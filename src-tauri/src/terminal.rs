use crate::job::Job;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, Weak},
    thread,
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const OUTPUT_CHUNK_SIZE: usize = 16 * 1024;
const SESSION_QUEUE_DEPTH: usize = 64;
const INPUT_QUEUE_DEPTH: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyLaunch {
    url: String,
    #[serde(default)]
    no_proxy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ClientMessage {
    Create {
        request_id: String,
        pane_id: String,
        cwd: String,
        shell: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
        proxy: Option<ProxyLaunch>,
    },
    Resize {
        session_id: Uuid,
        cols: u16,
        rows: u16,
    },
    SetPriority {
        session_id: Uuid,
        focused: bool,
    },
    Close {
        session_id: Uuid,
    },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ServerMessage<'a> {
    Created {
        request_id: &'a str,
        pane_id: &'a str,
        session_id: Uuid,
    },
    Exit {
        session_id: Uuid,
        exit_code: u32,
    },
    Error {
        request_id: Option<&'a str>,
        session_id: Option<Uuid>,
        message: &'a str,
    },
}

#[derive(Clone)]
enum ServerFrame {
    Text(String),
    Binary(Vec<u8>),
}

struct Hub {
    client: watch::Sender<Option<mpsc::Sender<ServerFrame>>>,
}

impl Hub {
    fn new() -> Self {
        let (client, _) = watch::channel(None);
        Self { client }
    }

    fn attach(&self, sender: mpsc::Sender<ServerFrame>) {
        self.client.send_replace(Some(sender));
    }

    async fn send(&self, frame: ServerFrame) {
        let mut receiver = self.client.subscribe();
        loop {
            let client = receiver.borrow_and_update().clone();
            if let Some(client) = client {
                if client.send(frame.clone()).await.is_ok() {
                    return;
                }
            }
            // 没有前端连接时挂起等待，attach 时被唤醒；watch 关闭说明服务已停止。
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }

    async fn json(&self, message: &ServerMessage<'_>) {
        if let Ok(json) = serde_json::to_string(message) {
            self.send(ServerFrame::Text(json)).await;
        }
    }
}

struct Session {
    input: mpsc::Sender<Vec<u8>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_id: u32,
    _job: Job,
}

type SpawnedSession = (Uuid, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>);

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

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    fn create(
        self: &Arc<Self>,
        cwd: &str,
        shell: &str,
        args: &[String],
        cols: u16,
        rows: u16,
        proxy: Option<&ProxyLaunch>,
    ) -> Result<SpawnedSession, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("启动目录不存在：{cwd}"));
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("无法创建 ConPTY：{error}"))?;
        let mut command = CommandBuilder::new(shell);
        command.cwd(cwd);
        if let Some(proxy) = proxy {
            for (name, value) in proxy_environment(proxy) {
                command.env(name, value);
            }
        }
        for argument in args {
            command.arg(argument);
        }
        if is_pwsh(shell)
            && !args
                .iter()
                .any(|value| value.eq_ignore_ascii_case("-Command"))
        {
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
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let session_id = Uuid::new_v4();
        let session = Session {
            input: spawn_input_writer(writer),
            master: Arc::new(Mutex::new(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            process_id,
            _job: job,
        };
        self.sessions
            .lock()
            .map_err(|_| "会话表已损坏")?
            .insert(session_id, session);
        Ok((session_id, reader, child))
    }

    fn spawn_output(
        self: &Arc<Self>,
        session_id: Uuid,
        mut reader: Box<dyn Read + Send>,
        exit_code: mpsc::Receiver<u32>,
    ) {
        let (sender, receiver) = mpsc::channel::<Vec<u8>>(SESSION_QUEUE_DEPTH);
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
        tauri::async_runtime::spawn(forward_output_and_exit(
            hub, session_id, receiver, exit_code,
        ));
    }

    fn spawn_exit_watcher(
        self: &Arc<Self>,
        session_id: Uuid,
        mut child: Box<dyn Child + Send + Sync>,
        exit_sender: mpsc::Sender<u32>,
    ) {
        let sessions: Weak<Mutex<HashMap<Uuid, Session>>> = Arc::downgrade(&self.sessions);
        thread::spawn(move || {
            let exit_code = child.wait().map_or(1, |status| status.exit_code());
            if let Some(sessions) = sessions.upgrade() {
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&session_id);
                }
            }
            // 退出码交给输出转发任务，由它在输出全部排空后统一发送 Exit，
            // 保证前端先收到该会话的全部输出，再收到退出消息。
            let _ = exit_sender.blocking_send(exit_code);
        });
    }

    async fn input(&self, session_id: Uuid, bytes: &[u8]) -> Result<(), String> {
        let sender = {
            let sessions = self.sessions.lock().map_err(|_| "会话表已损坏")?;
            sessions
                .get(&session_id)
                .ok_or("终端会话不存在")?
                .input
                .clone()
        };
        sender
            .send(bytes.to_vec())
            .await
            .map_err(|_| "终端输入流已关闭".to_string())
    }

    fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
        let master = {
            let sessions = self.sessions.lock().map_err(|_| "会话表已损坏")?;
            sessions
                .get(&session_id)
                .ok_or("终端会话不存在")?
                .master
                .clone()
        };
        let result = master
            .lock()
            .map_err(|_| "ConPTY 句柄已损坏")?
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string());
        result
    }

    fn set_priority(&self, session_id: Uuid, focused: bool) -> Result<(), String> {
        let process_id = {
            let sessions = self.sessions.lock().map_err(|_| "会话表已损坏")?;
            sessions
                .get(&session_id)
                .ok_or("终端会话不存在")?
                .process_id
        };
        set_process_priority_class(process_id, focused)
    }

    fn close(&self, session_id: Uuid) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "会话表已损坏")?
            .remove(&session_id);
        if let Some(session) = session {
            // kill 与进程自行退出存在竞态，可能返回诸如 "os error 0" 的虚假错误；
            // 无论 kill 结果如何，Session 释放时 Job Object 都会回收整棵进程树，无需上报。
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = self.sessions.lock().ok().map(|mut value| {
            value
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        });
        if let Some(sessions) = sessions {
            for session in sessions {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

// 先转发完该会话的全部输出，再发送 Exit，保证输出顺序完整、不丢尾部数据。
async fn forward_output_and_exit(
    hub: Arc<Hub>,
    session_id: Uuid,
    mut chunks: mpsc::Receiver<Vec<u8>>,
    mut exit_code: mpsc::Receiver<u32>,
) {
    while let Some(chunk) = chunks.recv().await {
        let mut frame = Vec::with_capacity(17 + chunk.len());
        frame.push(2);
        frame.extend_from_slice(session_id.as_bytes());
        frame.extend_from_slice(&chunk);
        hub.send(ServerFrame::Binary(frame)).await;
    }
    if let Some(code) = exit_code.recv().await {
        hub.json(&ServerMessage::Exit {
            session_id,
            exit_code: code,
        })
        .await;
    }
}

// 每个会话独立的写线程：input() 只做异步入队，阻塞的 ConPTY 写入不会占用全局会话锁，
// 且同一会话的输入顺序由单线程保证。
fn spawn_input_writer(mut writer: Box<dyn Write + Send>) -> mpsc::Sender<Vec<u8>> {
    let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE_DEPTH);
    thread::spawn(move || {
        while let Some(bytes) = receiver.blocking_recv() {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });
    sender
}

// 把前台会话恢复为 NORMAL、后台会话降为 BELOW_NORMAL。Windows 子进程继承父进程的
// 优先级类，因此调整 pwsh 即可影响整棵进程树。失败（如进程刚退出）由调用方静默处理。
#[cfg(windows)]
fn set_process_priority_class(process_id: u32, focused: bool) -> Result<(), String> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
            PROCESS_SET_INFORMATION,
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, false, process_id)
            .map_err(|error| error.to_string())?;
        let priority = if focused {
            NORMAL_PRIORITY_CLASS
        } else {
            BELOW_NORMAL_PRIORITY_CLASS
        };
        let result = SetPriorityClass(handle, priority);
        let _ = CloseHandle(handle);
        result.map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
fn set_process_priority_class(_process_id: u32, _focused: bool) -> Result<(), String> {
    Ok(())
}

fn is_pwsh(shell: &str) -> bool {
    Path::new(shell)
        .file_stem()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("pwsh"))
}

// 覆盖 curl/git/Node/Rust CLI 等常见工具读取的代理变量；Windows 环境变量不区分大小写，
// 无需再补小写变体。仅注入新进程环境，不修改系统或已运行会话。
fn proxy_environment(proxy: &ProxyLaunch) -> Vec<(&'static str, String)> {
    let url = proxy.url.trim();
    let mut variables: Vec<(&'static str, String)> = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
        .into_iter()
        .map(|name| (name, url.to_string()))
        .collect();
    let no_proxy = proxy.no_proxy.as_deref().map_or("", str::trim);
    if !no_proxy.is_empty() {
        variables.push(("NO_PROXY", no_proxy.to_string()));
    }
    variables
}

fn shell_integration() -> &'static str {
    "$global:__ShellGridOriginalPrompt=$function:prompt; function global:prompt { try { [Console]::Write(\"`e]9;9;$((Get-Location).Path)`e\\\") } catch {}; & $global:__ShellGridOriginalPrompt }"
}

#[derive(Deserialize)]
struct AuthQuery {
    token: String,
}

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
    // 每个连接对应一份全新的前端会话状态；旧连接遗留的会话已无人认领，先回收其进程。
    server.close_all();
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (sender, mut receiver) = mpsc::channel::<ServerFrame>(256);
    server.hub.attach(sender);
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            let message = match frame {
                ServerFrame::Text(text) => Message::Text(text.into()),
                ServerFrame::Binary(bytes) => Message::Binary(bytes.into()),
            };
            if socket_sender.send(message).await.is_err() {
                break;
            }
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
            server
                .hub
                .json(&ServerMessage::Error {
                    request_id: None,
                    session_id: None,
                    message: &format!("无效控制消息：{error}"),
                })
                .await;
            return;
        }
    };
    match message {
        ClientMessage::Create {
            request_id,
            pane_id,
            cwd,
            shell,
            args,
            cols,
            rows,
            proxy,
        } => {
            let spawner = server.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                spawner.create(&cwd, &shell, &args, cols, rows, proxy.as_ref())
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|value| value);
            match result {
                Ok((session_id, reader, child)) => {
                    // 先送出 Created 再启动输出转发，保证前端在收到任何输出前已建立会话映射。
                    server
                        .hub
                        .json(&ServerMessage::Created {
                            request_id: &request_id,
                            pane_id: &pane_id,
                            session_id,
                        })
                        .await;
                    let (exit_sender, exit_receiver) = mpsc::channel(1);
                    server.spawn_output(session_id, reader, exit_receiver);
                    server.spawn_exit_watcher(session_id, child, exit_sender);
                }
                Err(message) => {
                    server
                        .hub
                        .json(&ServerMessage::Error {
                            request_id: Some(&request_id),
                            session_id: None,
                            message: &message,
                        })
                        .await
                }
            }
        }
        ClientMessage::Resize {
            session_id,
            cols,
            rows,
        } => {
            if let Err(message) = server.resize(session_id, cols, rows) {
                server
                    .hub
                    .json(&ServerMessage::Error {
                        request_id: None,
                        session_id: Some(session_id),
                        message: &message,
                    })
                    .await;
            }
        }
        ClientMessage::SetPriority {
            session_id,
            focused,
        } => {
            // 优先级调整是尽力而为：会话刚关闭或进程已退出时静默忽略，不打扰前端。
            let _ = server.set_priority(session_id, focused);
        }
        ClientMessage::Close { session_id } => {
            if let Err(message) = server.close(session_id) {
                server
                    .hub
                    .json(&ServerMessage::Error {
                        request_id: None,
                        session_id: Some(session_id),
                        message: &message,
                    })
                    .await;
            }
        }
    }
}

async fn handle_binary(server: &Arc<TerminalServer>, bytes: &[u8]) {
    if bytes.len() < 17 || bytes[0] != 1 {
        return;
    }
    let Ok(session_id) = Uuid::from_slice(&bytes[1..17]) else {
        return;
    };
    if let Err(message) = server.input(session_id, &bytes[17..]).await {
        server
            .hub
            .json(&ServerMessage::Error {
                request_id: None,
                session_id: Some(session_id),
                message: &message,
            })
            .await;
    }
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;

    fn binary_payload(frame: &ServerFrame) -> &[u8] {
        match frame {
            ServerFrame::Binary(bytes) => &bytes[17..],
            _ => panic!("expected binary frame"),
        }
    }

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
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(encoded).unwrap(),
            ClientMessage::Resize {
                cols: 120,
                rows: 40,
                ..
            }
        ));
        let mut frame = vec![2_u8];
        frame.extend_from_slice(Uuid::nil().as_bytes());
        frame.extend_from_slice(b"hello");
        assert_eq!(frame[0], 2);
        assert_eq!(&frame[1..17], &[0_u8; 16]);
        assert_eq!(&frame[17..], b"hello");
    }

    #[test]
    fn create_message_accepts_optional_proxy() {
        let base = r#"{"type":"create","requestId":"r","paneId":"p","cwd":"C:\\","shell":"pwsh.exe","args":[],"cols":80,"rows":24"#;
        let without_proxy = format!("{base}}}");
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(&without_proxy).unwrap(),
            ClientMessage::Create { proxy: None, .. }
        ));
        let with_proxy =
            format!(r#"{base},"proxy":{{"url":"http://127.0.0.1:7890","noProxy":"localhost"}}}}"#);
        let ClientMessage::Create { proxy, .. } =
            serde_json::from_str::<ClientMessage>(&with_proxy).unwrap()
        else {
            panic!("expected create message");
        };
        let proxy = proxy.expect("proxy should deserialize");
        assert_eq!(proxy.url, "http://127.0.0.1:7890");
        assert_eq!(proxy.no_proxy.as_deref(), Some("localhost"));
    }

    #[test]
    fn proxy_environment_sets_standard_variables() {
        let proxy = ProxyLaunch {
            url: " http://127.0.0.1:7890 ".into(),
            no_proxy: Some("localhost,127.0.0.1".into()),
        };
        let variables = proxy_environment(&proxy);
        let url = "http://127.0.0.1:7890".to_string();
        assert_eq!(
            variables,
            vec![
                ("HTTP_PROXY", url.clone()),
                ("HTTPS_PROXY", url.clone()),
                ("ALL_PROXY", url),
                ("NO_PROXY", "localhost,127.0.0.1".into()),
            ]
        );
        let minimal = ProxyLaunch {
            url: "socks5://proxy.local:1080".into(),
            no_proxy: Some("  ".into()),
        };
        assert!(proxy_environment(&minimal)
            .iter()
            .all(|(name, _)| *name != "NO_PROXY"));
    }

    #[test]
    fn set_priority_rejects_unknown_sessions() {
        let server = Arc::new(TerminalServer {
            token: String::new(),
            url: String::new(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            hub: Arc::new(Hub::new()),
        });
        assert!(server.set_priority(Uuid::new_v4(), true).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn sets_priority_class_of_a_live_process() {
        let pid = std::process::id();
        assert!(set_process_priority_class(pid, true).is_ok());
        assert!(set_process_priority_class(pid, false).is_ok());
        assert!(set_process_priority_class(pid, true).is_ok());
    }

    #[test]
    fn hub_send_parks_until_client_attaches_and_delivers_in_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let hub = Arc::new(Hub::new());
            let pending = {
                let hub = hub.clone();
                tokio::spawn(async move { hub.send(ServerFrame::Text("first".into())).await })
            };
            tokio::task::yield_now().await;
            let (sender, mut receiver) = mpsc::channel::<ServerFrame>(8);
            hub.attach(sender);
            pending.await.unwrap();
            hub.send(ServerFrame::Text("second".into())).await;
            let order: Vec<String> = [receiver.recv().await, receiver.recv().await]
                .into_iter()
                .map(|frame| match frame {
                    Some(ServerFrame::Text(text)) => text,
                    _ => panic!("expected text frame"),
                })
                .collect();
            assert_eq!(order, ["first", "second"]);
        });
    }

    #[test]
    fn exit_arrives_after_all_output() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let hub = Arc::new(Hub::new());
            let (sender, mut receiver) = mpsc::channel::<ServerFrame>(64);
            hub.attach(sender);
            let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(8);
            let (exit_tx, exit_rx) = mpsc::channel::<u32>(1);
            let session_id = Uuid::new_v4();
            let forwarder =
                tokio::spawn(forward_output_and_exit(hub, session_id, chunk_rx, exit_rx));

            chunk_tx.send(b"first".to_vec()).await.unwrap();
            chunk_tx.send(b"second".to_vec()).await.unwrap();
            drop(chunk_tx);
            exit_tx.send(7).await.unwrap();
            drop(exit_tx);
            forwarder.await.unwrap();

            let frames: Vec<ServerFrame> = [
                receiver.recv().await,
                receiver.recv().await,
                receiver.recv().await,
            ]
            .into_iter()
            .map(|frame| frame.expect("expected three frames"))
            .collect();
            for frame in &frames[..2] {
                match frame {
                    ServerFrame::Binary(bytes) => {
                        assert_eq!(&bytes[..1], &[2]);
                        assert_eq!(&bytes[1..17], session_id.as_bytes());
                    }
                    _ => panic!("expected binary frame"),
                }
            }
            assert_eq!(binary_payload(&frames[0]), b"first");
            assert_eq!(binary_payload(&frames[1]), b"second");
            match &frames[2] {
                ServerFrame::Text(text) => {
                    assert!(text.contains("\"type\":\"exit\""));
                    assert!(text.contains("\"exitCode\":7"));
                }
                _ => panic!("expected exit frame"),
            }
        });
    }

    #[test]
    fn exit_sent_when_session_ends_without_output() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let hub = Arc::new(Hub::new());
            let (sender, mut receiver) = mpsc::channel::<ServerFrame>(64);
            hub.attach(sender);
            let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(8);
            let (exit_tx, exit_rx) = mpsc::channel::<u32>(1);
            let session_id = Uuid::new_v4();
            let forwarder =
                tokio::spawn(forward_output_and_exit(hub, session_id, chunk_rx, exit_rx));

            // 无输出即 reader 结束：关闭 chunk 通道后输出任务应立即读取退出码并发送 Exit。
            drop(chunk_tx);
            exit_tx.send(3).await.unwrap();
            drop(exit_tx);
            forwarder.await.unwrap();
            match receiver.recv().await {
                Some(ServerFrame::Text(text)) => {
                    assert!(text.contains("\"type\":\"exit\""));
                    assert!(text.contains("\"exitCode\":3"));
                }
                _ => panic!("expected exit frame"),
            }
        });
    }
}
