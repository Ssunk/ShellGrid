mod job;
mod terminal;
mod workspace;

use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use terminal::TerminalServer;
use workspace::WorkspaceStateV1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentStatus {
    windows_supported: bool,
    webview2_available: bool,
    pwsh_available: bool,
    pwsh_path: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    workspace: WorkspaceStateV1,
    ws_url: String,
    token: String,
    environment: EnvironmentStatus,
}

struct RuntimeState {
    bootstrap: Bootstrap,
    workspace_path: PathBuf,
    terminal: Arc<TerminalServer>,
}

#[tauri::command]
fn get_bootstrap(state: tauri::State<'_, RuntimeState>) -> Bootstrap {
    state.bootstrap.clone()
}

#[tauri::command]
fn save_workspace(
    state: tauri::State<'_, RuntimeState>,
    workspace: WorkspaceStateV1,
) -> Result<(), String> {
    workspace::save(&state.workspace_path, &workspace)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "链接格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 http 或 https 链接".into());
    }
    open::that_detached(parsed.as_str()).map_err(|error| error.to_string())
}

fn environment() -> EnvironmentStatus {
    let pwsh_path = find_pwsh();
    let windows_supported = cfg!(windows);
    let message = if !windows_supported {
        Some("CliMultiple 需要 Windows 10 1903 或更高版本".into())
    } else if pwsh_path.is_none() {
        Some("未找到 PowerShell 7（pwsh.exe），请先安装后重启应用".into())
    } else {
        None
    };
    EnvironmentStatus {
        windows_supported,
        // The desktop window cannot reach this command unless WebView2 loaded successfully.
        webview2_available: true,
        pwsh_available: pwsh_path.is_some(),
        pwsh_path,
        message,
    }
}

fn find_pwsh() -> Option<String> {
    let output = std::process::Command::new("where.exe")
        .arg("pwsh.exe")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

pub fn run() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let environment = environment();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("C:\\"));
            let shell = environment
                .pwsh_path
                .clone()
                .unwrap_or_else(|| "pwsh.exe".into());
            let workspace_path = workspace::workspace_path();
            let fallback = WorkspaceStateV1::default_at(&cwd, shell);
            let workspace = workspace::load_or_default(&workspace_path, fallback);
            let terminal = tauri::async_runtime::block_on(TerminalServer::start())
                .map_err(|error| anyhow::anyhow!(error))?;
            let bootstrap = Bootstrap {
                workspace,
                ws_url: terminal.url().to_owned(),
                token: terminal.token().to_owned(),
                environment,
            };
            app.manage(RuntimeState {
                bootstrap,
                workspace_path,
                terminal,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            save_workspace,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("failed to build CliMultiple");

    application.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<RuntimeState>().terminal.close_all();
        }
    });
}
