mod git;
mod job;
mod terminal;
mod workspace;

use git::GitService;
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
    git_available: bool,
    git_path: Option<String>,
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
    let git_path = find_git();
    let windows_supported = cfg!(windows);
    let message = if !windows_supported {
        Some("ShellGrid 需要 Windows 10 1903 或更高版本".into())
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
        git_available: git_path.is_some(),
        git_path,
        message,
    }
}

fn find_git() -> Option<String> {
    let candidates = [
        ("ProgramFiles", r"Git\cmd\git.exe"),
        ("ProgramFiles(x86)", r"Git\cmd\git.exe"),
        ("LOCALAPPDATA", r"Programs\Git\cmd\git.exe"),
    ];
    candidates
        .iter()
        .find_map(|(variable, relative)| {
            let candidate = PathBuf::from(std::env::var_os(variable)?).join(relative);
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().into_owned())
        })
        .or_else(|| find_executable_on_path("git.exe"))
}

fn find_executable_on_path(name: &str) -> Option<String> {
    let mut command = std::process::Command::new("where.exe");
    command.arg(name);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn find_pwsh() -> Option<String> {
    find_pwsh_installed().or_else(find_pwsh_on_path)
}

// 先探测固定安装位置：几次文件元数据查询即可覆盖 MSI/winget 默认目录与商店版，
// 避免每次启动都付出 where.exe 的进程创建与全 PATH 扫描（PATH 含失效网络目录时可达秒级）。
fn find_pwsh_installed() -> Option<String> {
    let candidates = [
        ("ProgramFiles", r"PowerShell\7\pwsh.exe"),
        ("ProgramFiles(x86)", r"PowerShell\7\pwsh.exe"),
        ("ProgramFiles", r"PowerShell\7-preview\pwsh.exe"),
        ("LOCALAPPDATA", r"Microsoft\WindowsApps\pwsh.exe"),
    ];
    candidates.iter().find_map(|(variable, relative)| {
        let candidate = PathBuf::from(std::env::var_os(variable)?).join(relative);
        // 商店版 pwsh 是应用执行别名（reparse point），fs::metadata 对其会失败，
        // 因此用 symlink_metadata 判断存在性。
        std::fs::symlink_metadata(&candidate)
            .is_ok_and(|metadata| !metadata.is_dir())
            .then(|| candidate.to_string_lossy().into_owned())
    })
}

fn find_pwsh_on_path() -> Option<String> {
    find_executable_on_path("pwsh.exe")
}

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let environment = environment();
            let git = GitService::new(environment.git_path.clone());
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
            app.manage(git);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            save_workspace,
            open_external,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_head_message,
            git::git_switch_branch,
            git::git_pull,
            git::git_push
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ShellGrid");

    application.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<RuntimeState>().terminal.close_all();
        }
    });
}
