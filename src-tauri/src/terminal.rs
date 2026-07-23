use crate::job::Job;
use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query, State},
    response::Response,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, Weak},
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

const OUTPUT_CHUNK_SIZE: usize = 16 * 1024;
const SESSION_QUEUE_DEPTH: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum ClientMessage {
    Create {
        request_id: String,
        pane_id: String,
        cwd: String,
        shell: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
    },
    Resize { session_id: Uuid, cols: u16, rows: u16 },
    SetPriority { session_id: Uuid, focused: bool },
    Close { session_id: Uuid },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum ServerMessage<'a> {
    Created { request_id: &'a str, pane_id: &'a str, session_id: Uuid },
    Exit { session_id: Uuid, exit_code: u32 },
    Error { request_id: Option<&'a str>, session_id: Option<Uuid>, message: &'a str },
}

#[derive(Clone)]
enum ServerFrame {
    Text(String),
    Binary(Vec<u8>),
}

struct Hub {
    client: RwLock<Option<mpsc::Sender<ServerFrame>>>,
}

impl Hub {
    fn new() -> Self {
        Self { client: RwLock::new(None) }
    }

    async fn attach(&self, sender: mpsc::Sender<ServerFrame>) {
        *self.client.write().await = Some(sender);
    }

    async fn send(&self, frame: ServerFrame) {
        loop {
            let client = self.client.read().await.clone();
            if let Some(client) = client {
                if client.send(frame.clone()).await.is_ok() {
                    return;
                }
                *self.client.write().await = None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn json(&self, message: &ServerMessage<'_>) {
        if let Ok(json) = serde_json::to_string(message) {
            self.send(ServerFrame::Text(json)).await;
        }
    }
}

type ChildHandle = Arc<Mutex<Box<dyn Child + Send + Sync>>>;

struct Session {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: ChildHandle,
    _job: Job,
}

pub struct TerminalServer {
    token: String,
    url: String,
    sessions: Arc<Mutex<HashMap<Uuid, Session>>>,
    hub: Arc<Hub>,
}

impl TerminalServer {
    pub async fn start() -> Result<Arc<Self>, String> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let server = Arc::new(Self {
            token,
            url: format!("ws://127.0.0.1:{}/terminal", address.port()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            hub: Arc::new(Hub::new()),
        });
        let router = Router::new()
            .route("/terminal", get(websocket_handler))
            .with_state(server.clone());
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(server)
    }

    pub fn token(&self) -> &str { &self.token }

    pub fn url(&self) -> &str { &self.url }

    fn create(
        self: &Arc<Self>,
        cwd: &str,
        shell: &str,
        args: &[String],
        cols: u16,
        rows: u16,
    ) -> Result<Uuid, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("启动目录不存在：{cwd}"));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("无法创建 ConPTY：{error}"))?;
        let mut command = CommandBuilder::new(shell);
        command.cwd(cwd);
        for argument in args {
            command.arg(argument);
        }
        if is_pwsh(shell) && !args.iter().any(|value| value.eq_ignore_ascii_case("-Command")) {
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg(shell_integration());
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动 {shell}：{error}"))?;
        drop(pair.slave);
        let process_id = child.process_id().ok_or_else(|| {
            let _ = child.kill();
            "无法获取终端进程 ID".to_string()
        })?;
        let job = Job::for_process(process_id).map_err(|error| {
            let _ = child.kill();
            format!("无法创建进程回收 Job Object：{error}")
        })?;
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let session_id = Uuid::new_v4();
        let child = Arc::new(Mutex::new(child));
        let session = Session {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            child: child.clone(),
            _job: job,
        };
        self.sessions.lock().map_err(|_| "会话表已损坏")?.insert(session_id, session);
        self.spawn_output(session_id, reader);
        self.spawn_exit_watcher(session_id, child);
        Ok(session_id)
    }

    fn spawn_output(self: &Arc<Self>, session_id: Uuid, mut reader: Box<dyn Read + Send>) {
        let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(SESSION_QUEUE_DEPTH);
        thread::spawn(move || {
            let mut buffer = vec![0_u8; OUTPUT_CHUNK_SIZE];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) if sender.blocking_send(buffer[..count].to_vec()).is_err() => break,
                    Ok(_) => {}
                }
            }
        });
        let hub = self.hub.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(chunk) = receiver.recv().await {
                let mut frame = Vec::with_capacity(17 + chunk.len());
                frame.push(2);
                frame.extend_from_slice(session_id.as_bytes());
                frame.extend_from_slice(&chunk);
                hub.send(ServerFrame::Binary(frame)).await;
            }
        });
    }

    fn spawn_exit_watcher(self: &Arc<Self>, session_id: Uuid, child: ChildHandle) {
        let sessions: Weak<Mutex<HashMap<Uuid, Session>>> = Arc::downgrade(&self.sessions);
        let hub = self.hub.clone();
        thread::spawn(move || loop {
            let status = child.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten();
            if let Some(status) = status {
                if let Some(sessions) = sessions.upgrade() {
                    if let Ok(mut sessions) = sessions.lock() {
                        sessions.remove(&session_id);
                    }
                }
                let exit_code = status.exit_code();
                tauri::async_runtime::spawn(async move {
                    hub.json(&ServerMessage::Exit { session_id, exit_code }).await;
                });
                break;
            }
            thread::sleep(Duration::from_millis(100));
        });
    }

    fn input(&self, session_id: Uuid, bytes: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "会话表已损坏")?;
        let session = sessions.get(&session_id).ok_or("终端会话不存在")?;
        let mut writer = session.writer.lock().map_err(|_| "终端输入流已损坏")?;
        writer.write_all(bytes).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "会话表已损坏")?;
        let session = sessions.get(&session_id).ok_or("终端会话不存在")?;
        let result = session
            .master
            .lock()
            .map_err(|_| "ConPTY 句柄已损坏")?
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|error| error.to_string());
        result
    }

    fn close(&self, session_id: Uuid) -> Result<(), String> {
        let session = self.sessions.lock().map_err(|_| "会话表已损坏")?.remove(&session_id);
        if let Some(session) = session {
            session.child.lock().map_err(|_| "终端进程句柄已损坏")?.kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = self.sessions.lock().ok().map(|mut value| value.drain().map(|(_, session)| session).collect::<Vec<_>>());
        if let Some(sessions) = sessions {
            for session in sessions {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
            }
        }
    }
}

fn is_pwsh(shell: &str) -> bool {
    Path::new(shell)
        .file_stem()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("pwsh"))
}

fn shell_integration() -> &'static str {
    "$global:__CliMultipleOriginalPrompt=$function:prompt; function global:prompt { try { [Console]::Write(\"`e]9;9;$((Get-Location).Path)`e\\\") } catch {}; & $global:__CliMultipleOriginalPrompt }"
}

#[derive(Deserialize)]
struct AuthQuery { token: String }

async fn websocket_handler(
    State(server): State<Arc<TerminalServer>>,
    Query(auth): Query<AuthQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if auth.token != server.token {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade.on_upgrade(move |socket| socket_loop(server, socket))
}

async fn socket_loop(server: Arc<TerminalServer>, socket: WebSocket) {
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (sender, mut receiver) = mpsc::channel::<ServerFrame>(256);
    server.hub.attach(sender).await;
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            let message = match frame {
                ServerFrame::Text(text) => Message::Text(text.into()),
                ServerFrame::Binary(bytes) => Message::Binary(bytes.into()),
            };
            if socket_sender.send(message).await.is_err() { break; }
        }
    });

    while let Some(Ok(message)) = socket_receiver.next().await {
        match message {
            Message::Text(text) => handle_control(&server, &text).await,
            Message::Binary(bytes) => handle_binary(&server, &bytes).await,
            Message::Close(_) => break,
            _ => {}
        }
    }
    writer.abort();
}

async fn handle_control(server: &Arc<TerminalServer>, text: &str) {
    let message = match serde_json::from_str::<ClientMessage>(text) {
        Ok(message) => message,
        Err(error) => {
            server.hub.json(&ServerMessage::Error { request_id: None, session_id: None, message: &format!("无效控制消息：{error}") }).await;
            return;
        }
    };
    match message {
        ClientMessage::Create { request_id, pane_id, cwd, shell, args, cols, rows } => {
            match server.create(&cwd, &shell, &args, cols, rows) {
                Ok(session_id) => server.hub.json(&ServerMessage::Created { request_id: &request_id, pane_id: &pane_id, session_id }).await,
                Err(message) => server.hub.json(&ServerMessage::Error { request_id: Some(&request_id), session_id: None, message: &message }).await,
            }
        }
        ClientMessage::Resize { session_id, cols, rows } => {
            if let Err(message) = server.resize(session_id, cols, rows) {
                server.hub.json(&ServerMessage::Error { request_id: None, session_id: Some(session_id), message: &message }).await;
            }
        }
        ClientMessage::SetPriority { session_id, focused } => {
            let _ = (session_id, focused);
        }
        ClientMessage::Close { session_id } => {
            if let Err(message) = server.close(session_id) {
                server.hub.json(&ServerMessage::Error { request_id: None, session_id: Some(session_id), message: &message }).await;
            }
        }
    }
}

async fn handle_binary(server: &Arc<TerminalServer>, bytes: &[u8]) {
    if bytes.len() < 17 || bytes[0] != 1 { return; }
    let Ok(session_id) = Uuid::from_slice(&bytes[1..17]) else { return; };
    if let Err(message) = server.input(session_id, &bytes[17..]) {
        server.hub.json(&ServerMessage::Error { request_id: None, session_id: Some(session_id), message: &message }).await;
    }
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_pwsh_paths() {
        assert!(is_pwsh("pwsh.exe"));
        assert!(is_pwsh(r"C:\\Program Files\\PowerShell\\7\\pwsh.exe"));
        assert!(!is_pwsh("cmd.exe"));
    }

    #[test]
    fn integration_emits_only_current_directory_metadata() {
        let script = shell_integration();
        assert!(script.contains("Get-Location"));
        assert!(!script.contains("PSReadLine"));
        assert!(!script.contains("history"));
    }

    #[test]
    fn control_messages_are_tagged_and_binary_frames_reserve_session_prefix() {
        let encoded = r#"{"type":"resize","sessionId":"00000000-0000-0000-0000-000000000000","cols":120,"rows":40}"#;
        assert!(matches!(serde_json::from_str::<ClientMessage>(encoded).unwrap(), ClientMessage::Resize { cols: 120, rows: 40, .. }));
        let mut frame = vec![2_u8];
        frame.extend_from_slice(Uuid::nil().as_bytes());
        frame.extend_from_slice(b"hello");
        assert_eq!(frame[0], 2);
        assert_eq!(&frame[1..17], &[0_u8; 16]);
        assert_eq!(&frame[17..], b"hello");
    }
}
