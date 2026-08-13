use serde::Serialize;
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tauri::State;

const MAX_DIFF_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct GitService {
    executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    upstream: Option<String>,
    current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repository: bool,
    repo_root: Option<String>,
    branch: Option<String>,
    detached: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFileStatus>,
    branches: Vec<GitBranch>,
    remotes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    content: String,
    binary: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct GitOperationResult {
    message: String,
}

impl GitService {
    pub fn new(executable: Option<String>) -> Self {
        Self { executable }
    }

    fn command(&self, cwd: &Path) -> Result<Command, String> {
        let executable = self
            .executable
            .as_deref()
            .ok_or_else(|| "未找到 Git，请先安装 Git for Windows 后重启应用".to_string())?;
        let mut command = Command::new(executable);
        command
            .arg("-c")
            .arg("color.ui=false")
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("-C")
            .arg(cwd)
            .env("GIT_TERMINAL_PROMPT", "0");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
        }
        Ok(command)
    }

    fn output<I, S>(&self, cwd: &Path, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.command(cwd)?
            .args(args)
            .output()
            .map_err(|error| format!("无法启动 Git：{error}"))
    }

    /// 用户提供的文件路径一律按字面路径处理，避免文件名中的 `*`、`[`、`?`
    /// 等字符被 Git pathspec 当作通配符展开而误伤其他文件。
    fn literal_pathspec(path: &str) -> String {
        format!(":(literal){path}")
    }

    fn literal_paths(paths: &[String]) -> impl Iterator<Item = String> + '_ {
        paths.iter().map(|path| Self::literal_pathspec(path))
    }

    fn checked_output<I, S>(&self, cwd: &Path, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.output(cwd, args)?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(git_error(&output))
        }
    }

    fn repository_root(&self, path: &str) -> Result<Option<PathBuf>, String> {
        let directory = Path::new(path);
        if !directory.is_dir() {
            return Err(format!("工作区目录不存在：{path}"));
        }
        let output = self.output(directory, ["rev-parse", "--show-toplevel"])?;
        if !output.status.success() {
            return Ok(None);
        }
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if root.is_empty() {
            Ok(None)
        } else {
            Ok(Some(PathBuf::from(root)))
        }
    }

    fn required_root(&self, path: &str) -> Result<PathBuf, String> {
        self.repository_root(path)?
            .ok_or_else(|| "当前工作区不是 Git 仓库".to_string())
    }

    fn status(&self, path: &str) -> Result<GitStatus, String> {
        let Some(root) = self.repository_root(path)? else {
            return Ok(GitStatus {
                is_repository: false,
                repo_root: None,
                branch: None,
                detached: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                files: Vec::new(),
                branches: Vec::new(),
                remotes: Vec::new(),
            });
        };
        let status = self.checked_output(
            &root,
            [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )?;
        let mut parsed = parse_status(&status.stdout);
        parsed.is_repository = true;
        parsed.repo_root = Some(root.to_string_lossy().into_owned());

        let branches = self.checked_output(
            &root,
            [
                "for-each-ref",
                "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)",
                "refs/heads",
            ],
        )?;
        parsed.branches = parse_branches(&branches.stdout);
        if let Some(branch) = parsed.branch.as_deref() {
            if !parsed
                .branches
                .iter()
                .any(|candidate| candidate.name == branch)
            {
                parsed.branches.insert(
                    0,
                    GitBranch {
                        name: branch.to_string(),
                        upstream: parsed.upstream.clone(),
                        current: true,
                    },
                );
            }
        }
        let remotes = self.checked_output(&root, ["remote"])?;
        parsed.remotes = String::from_utf8_lossy(&remotes.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        Ok(parsed)
    }

    fn diff(&self, path: &str, file_path: &str, staged: bool) -> Result<GitDiff, String> {
        let root = self.required_root(path)?;
        let mut command = self.command(&root)?;
        command.args(["diff", "--no-ext-diff", "--no-color"]);
        if staged {
            command.arg("--cached");
        }
        let output = command
            .arg("--")
            .arg(Self::literal_pathspec(file_path))
            .output()
            .map_err(|error| format!("无法读取差异：{error}"))?;
        if !output.status.success() {
            return Err(git_error(&output));
        }
        if !staged && output.stdout.is_empty() {
            if let Some(diff) = self.untracked_file_diff(&root, file_path)? {
                return Ok(diff);
            }
        }
        let truncated = output.stdout.len() > MAX_DIFF_BYTES;
        let content = bounded_text(&output.stdout, MAX_DIFF_BYTES);
        let binary = content.contains("Binary files ") || content.contains("GIT binary patch");
        Ok(GitDiff {
            content,
            binary,
            truncated,
        })
    }

    /// 未跟踪的新文件没有可对比的基线，`git diff` 不会输出任何内容。
    /// 这里直接读取工作树文件，构造与“新增文件”一致的差异文本用于预览。
    fn untracked_file_diff(&self, root: &Path, file_path: &str) -> Result<Option<GitDiff>, String> {
        let tracked = self
            .output(
                root,
                ["ls-files", "--error-unmatch", "--"]
                    .into_iter()
                    .map(str::to_owned)
                    .chain(std::iter::once(Self::literal_pathspec(file_path))),
            )?
            .status
            .success();
        if tracked {
            return Ok(None);
        }
        let full_path = root.join(file_path);
        let file = match std::fs::File::open(&full_path) {
            Ok(file) => file,
            Err(_) => return Ok(None),
        };
        let mut bytes = Vec::with_capacity(8192);
        let read = file
            .take(MAX_DIFF_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("无法读取文件 {file_path}：{error}"))?;
        let truncated = read > MAX_DIFF_BYTES;
        let binary = bytes[..bytes.len().min(8000)].contains(&0);
        if binary {
            return Ok(Some(GitDiff {
                content: String::new(),
                binary: true,
                truncated,
            }));
        }
        let body = bounded_text(&bytes, MAX_DIFF_BYTES);
        let mut content = format!(
            "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{file_path}\n"
        );
        if !body.is_empty() {
            let lines = body.lines().count();
            content.push_str(&format!("@@ -0,0 +1,{lines} @@\n"));
            for line in body.split_inclusive('\n') {
                content.push('+');
                content.push_str(line);
            }
        }
        Ok(Some(GitDiff {
            content,
            binary: false,
            truncated,
        }))
    }

    fn stage(&self, path: &str, paths: &[String]) -> Result<GitOperationResult, String> {
        if paths.is_empty() {
            return Err("没有可暂存的文件".into());
        }
        let root = self.required_root(path)?;
        let mut command = self.command(&root)?;
        let output = command
            .args(["add", "--"])
            .args(Self::literal_paths(paths))
            .output()
            .map_err(|error| format!("无法暂存文件：{error}"))?;
        operation_result(output, "已暂存所选文件")
    }

    fn unstage(&self, path: &str, paths: &[String]) -> Result<GitOperationResult, String> {
        if paths.is_empty() {
            return Err("没有可取消暂存的文件".into());
        }
        let root = self.required_root(path)?;
        let has_head = self.head_exists(&root)?;
        let mut command = self.command(&root)?;
        if has_head {
            command.args(["restore", "--staged", "--"]);
        } else {
            command.args(["rm", "--cached", "-r", "--"]);
        }
        let output = command
            .args(Self::literal_paths(paths))
            .output()
            .map_err(|error| format!("无法取消暂存：{error}"))?;
        operation_result(output, "已取消暂存所选文件")
    }

    fn restore(&self, path: &str, paths: &[String]) -> Result<GitOperationResult, String> {
        if paths.is_empty() {
            return Err("没有可恢复的文件".into());
        }
        let root = self.required_root(path)?;
        let mut command = self.command(&root)?;
        let output = command
            .args(["restore", "--worktree", "--"])
            .args(Self::literal_paths(paths))
            .output()
            .map_err(|error| format!("无法恢复工作树文件：{error}"))?;
        operation_result(output, "已恢复所选文件")
    }

    fn commit(
        &self,
        path: &str,
        message: &str,
        amend: bool,
        signoff: bool,
    ) -> Result<GitOperationResult, String> {
        let message = message.trim();
        if message.is_empty() {
            return Err("请输入提交信息".into());
        }
        let root = self.required_root(path)?;
        if amend && !self.head_exists(&root)? {
            return Err("仓库还没有提交，无法修补上次提交".into());
        }
        let mut args = vec!["commit", "-m", message];
        if amend {
            args.push("--amend");
        }
        if signoff {
            args.push("--signoff");
        }
        let output = self.checked_output(&root, args)?;
        let fallback = if amend {
            "提交已修补"
        } else {
            "提交已创建"
        };
        Ok(GitOperationResult {
            message: success_message(&output, fallback),
        })
    }

    fn head_exists(&self, root: &Path) -> Result<bool, String> {
        Ok(self
            .output(root, ["rev-parse", "--verify", "HEAD"])?
            .status
            .success())
    }

    fn head_message(&self, path: &str) -> Result<Option<String>, String> {
        let root = self.required_root(path)?;
        if !self.head_exists(&root)? {
            return Ok(None);
        }
        let output = self.checked_output(&root, ["log", "-1", "--pretty=%B"])?;
        Ok(Some(
            bounded_text(&output.stdout, MAX_MESSAGE_BYTES)
                .trim_end()
                .to_string(),
        ))
    }

    fn switch_branch(
        &self,
        path: &str,
        branch: &str,
        create: bool,
    ) -> Result<GitOperationResult, String> {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("请输入分支名称".into());
        }
        let root = self.required_root(path)?;
        if create {
            self.checked_output(&root, ["check-ref-format", "--branch", branch])?;
        }
        let mut command = self.command(&root)?;
        command.arg("switch");
        if create {
            command.arg("-c").arg(branch);
        } else {
            command.arg("--").arg(branch);
        }
        let output = command
            .output()
            .map_err(|error| format!("无法切换分支：{error}"))?;
        operation_result(
            output,
            if create {
                "分支已创建并切换"
            } else {
                "分支已切换"
            },
        )
    }

    fn pull(&self, path: &str) -> Result<GitOperationResult, String> {
        let root = self.required_root(path)?;
        let output = self.checked_output(&root, ["pull", "--ff-only"])?;
        Ok(GitOperationResult {
            message: success_message(&output, "已拉取远端更新"),
        })
    }

    fn push(
        &self,
        path: &str,
        remote: Option<&str>,
        force_with_lease: bool,
    ) -> Result<GitOperationResult, String> {
        let root = self.required_root(path)?;
        let status = self.status(path)?;
        let branch = status
            .branch
            .filter(|_| !status.detached)
            .ok_or_else(|| "分离 HEAD 状态下不能从面板推送".to_string())?;
        let mut command = self.command(&root)?;
        command.arg("push");
        if force_with_lease {
            command.arg("--force-with-lease");
        }
        if status.upstream.is_none() {
            let remote = remote
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "当前分支没有 upstream，请先选择远端".to_string())?;
            if !status.remotes.iter().any(|candidate| candidate == remote) {
                return Err("选择的 Git 远端不存在".into());
            }
            command
                .arg("--set-upstream")
                .arg("--")
                .arg(remote)
                .arg(branch.as_str());
        }
        let output = command
            .output()
            .map_err(|error| format!("无法推送：{error}"))?;
        operation_result(
            output,
            if force_with_lease {
                "安全强制推送完成"
            } else {
                "推送完成"
            },
        )
    }
}

fn parse_status(bytes: &[u8]) -> GitStatus {
    let decoded = String::from_utf8_lossy(bytes);
    let records: Vec<&str> = decoded.split('\0').collect();
    let mut status = GitStatus {
        is_repository: true,
        repo_root: None,
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        branches: Vec::new(),
        remotes: Vec::new(),
    };
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if let Some(value) = record.strip_prefix("# branch.head ") {
            status.detached = value == "(detached)" || value == "(unknown)";
            if !status.detached {
                status.branch = Some(value.to_string());
            }
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(ahead) = part.strip_prefix('+') {
                    status.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = part.strip_prefix('-') {
                    status.behind = behind.parse().unwrap_or(0);
                }
            }
        } else if record.starts_with("1 ") {
            if let Some(file) = parse_file_record(record, 9, None) {
                status.files.push(file);
            }
        } else if record.starts_with("2 ") {
            let original = records.get(index + 1).map(|value| (*value).to_string());
            if let Some(file) = parse_file_record(record, 10, original) {
                status.files.push(file);
                index += 1;
            }
        } else if record.starts_with("u ") {
            if let Some(file) = parse_file_record(record, 11, None) {
                status.files.push(file);
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            status.files.push(GitFileStatus {
                path: path.to_string(),
                original_path: None,
                index_status: "?".into(),
                worktree_status: "?".into(),
            });
        }
        index += 1;
    }
    status
}

fn parse_file_record(
    record: &str,
    fields: usize,
    original_path: Option<String>,
) -> Option<GitFileStatus> {
    let parts: Vec<&str> = record.splitn(fields, ' ').collect();
    let code = parts.get(1)?;
    let mut chars = code.chars();
    Some(GitFileStatus {
        path: parts.last()?.to_string(),
        original_path,
        index_status: chars.next().unwrap_or('.').to_string(),
        worktree_status: chars.next().unwrap_or('.').to_string(),
    })
}

fn parse_branches(bytes: &[u8]) -> Vec<GitBranch> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let name = fields.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let upstream = fields
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let current = fields.next().is_some_and(|value| value.trim() == "*");
            Some(GitBranch {
                name: name.to_string(),
                upstream,
                current,
            })
        })
        .collect()
}

fn git_error(output: &Output) -> String {
    let stderr = bounded_text(&output.stderr, MAX_MESSAGE_BYTES);
    let stdout = bounded_text(&output.stdout, MAX_MESSAGE_BYTES);
    let detail = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    if detail.trim().is_empty() {
        format!(
            "Git 操作失败（退出码 {}）",
            output.status.code().unwrap_or(-1)
        )
    } else {
        detail.trim().to_string()
    }
}

fn operation_result(output: Output, fallback: &str) -> Result<GitOperationResult, String> {
    if !output.status.success() {
        return Err(git_error(&output));
    }
    Ok(GitOperationResult {
        message: success_message(&output, fallback),
    })
}

fn success_message(output: &Output, fallback: &str) -> String {
    let stdout = bounded_text(&output.stdout, MAX_MESSAGE_BYTES);
    let stderr = bounded_text(&output.stderr, MAX_MESSAGE_BYTES);
    let message = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    if message.trim().is_empty() {
        fallback.to_string()
    } else {
        message.trim().to_string()
    }
}

fn bounded_text(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]).into_owned()
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Git 后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn git_status(service: State<'_, GitService>, path: String) -> Result<GitStatus, String> {
    let service = service.inner().clone();
    run_blocking(move || service.status(&path)).await
}

#[tauri::command]
pub async fn git_diff(
    service: State<'_, GitService>,
    path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let service = service.inner().clone();
    run_blocking(move || service.diff(&path, &file_path, staged)).await
}

#[tauri::command]
pub async fn git_stage(
    service: State<'_, GitService>,
    path: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.stage(&path, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(
    service: State<'_, GitService>,
    path: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.unstage(&path, &paths)).await
}

#[tauri::command]
pub async fn git_restore(
    service: State<'_, GitService>,
    path: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.restore(&path, &paths)).await
}

#[tauri::command]
pub async fn git_commit(
    service: State<'_, GitService>,
    path: String,
    message: String,
    amend: bool,
    signoff: bool,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.commit(&path, &message, amend, signoff)).await
}

#[tauri::command]
pub async fn git_head_message(
    service: State<'_, GitService>,
    path: String,
) -> Result<Option<String>, String> {
    let service = service.inner().clone();
    run_blocking(move || service.head_message(&path)).await
}

#[tauri::command]
pub async fn git_switch_branch(
    service: State<'_, GitService>,
    path: String,
    branch: String,
    create: bool,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.switch_branch(&path, &branch, create)).await
}

#[tauri::command]
pub async fn git_pull(
    service: State<'_, GitService>,
    path: String,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.pull(&path)).await
}

#[tauri::command]
pub async fn git_push(
    service: State<'_, GitService>,
    path: String,
    remote: Option<String>,
    force_with_lease: bool,
) -> Result<GitOperationResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.push(&path, remote.as_deref(), force_with_lease)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_porcelain_v2_status_and_rename_paths() {
        let input = concat!(
            "# branch.oid abcdef\0",
            "# branch.head feature/ui\0",
            "# branch.upstream origin/feature/ui\0",
            "# branch.ab +2 -1\0",
            "1 M. N... 100644 100644 100644 a b src/main.rs\0",
            "2 RM N... 100644 100644 100644 a b R100 src/新 name.rs\0",
            "src/old name.rs\0",
            "? notes/计划.txt\0",
        );
        let status = parse_status(input.as_bytes());
        assert_eq!(status.branch.as_deref(), Some("feature/ui"));
        assert_eq!(status.upstream.as_deref(), Some("origin/feature/ui"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[1].path, "src/新 name.rs");
        assert_eq!(
            status.files[1].original_path.as_deref(),
            Some("src/old name.rs")
        );
        assert_eq!(status.files[2].index_status, "?");
    }

    #[test]
    fn parses_local_branches() {
        let branches = parse_branches(b"feature\torigin/feature\t*\nmain\torigin/main\t \n");
        assert_eq!(branches.len(), 2);
        assert!(branches[0].current);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/feature"));
        assert!(!branches[1].current);
    }

    #[test]
    fn force_push_with_lease_updates_a_rewritten_branch() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let path = directory.path();
        let remote_path = remote.path();
        let service = GitService::new(Some("git".into()));
        service
            .checked_output(remote_path, ["init", "--bare"])
            .unwrap();
        service.checked_output(path, ["init"]).unwrap();
        service
            .checked_output(path, ["config", "user.name", "ShellGrid Test"])
            .unwrap();
        service
            .checked_output(path, ["config", "user.email", "shellgrid@example.invalid"])
            .unwrap();
        fs::write(path.join("force.txt"), "initial\n").unwrap();
        service
            .stage(path.to_str().unwrap(), &["force.txt".into()])
            .unwrap();
        service
            .commit(path.to_str().unwrap(), "initial", false, false)
            .unwrap();
        service
            .checked_output(
                path,
                ["remote", "add", "origin", remote_path.to_str().unwrap()],
            )
            .unwrap();
        service
            .push(path.to_str().unwrap(), Some("origin"), false)
            .unwrap();

        fs::write(path.join("force.txt"), "rewritten\n").unwrap();
        service
            .stage(path.to_str().unwrap(), &["force.txt".into()])
            .unwrap();
        service
            .commit(path.to_str().unwrap(), "rewritten", true, false)
            .unwrap();
        assert!(service.push(path.to_str().unwrap(), None, false).is_err());
        service.push(path.to_str().unwrap(), None, true).unwrap();

        let branch = service
            .status(path.to_str().unwrap())
            .unwrap()
            .branch
            .unwrap();
        let local_head = service.checked_output(path, ["rev-parse", "HEAD"]).unwrap();
        let remote_head = service
            .checked_output(remote_path, ["rev-parse", branch.as_str()])
            .unwrap();
        assert_eq!(local_head.stdout, remote_head.stdout);
    }

    #[test]
    fn previews_untracked_new_files_when_git_is_available() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let service = GitService::new(Some("git".into()));
        service.checked_output(path, ["init"]).unwrap();
        service
            .checked_output(path, ["config", "core.autocrlf", "false"])
            .unwrap();
        fs::write(path.join("notes.txt"), "line1\nline2").unwrap();
        fs::write(path.join("empty.txt"), "").unwrap();
        fs::write(path.join("blob.bin"), b"\x00\x01\x02").unwrap();

        let notes = service
            .diff(path.to_str().unwrap(), "notes.txt", false)
            .unwrap();
        assert!(!notes.binary);
        assert!(!notes.truncated);
        assert!(notes.content.contains("new file mode 100644"));
        assert!(notes.content.contains("@@ -0,0 +1,2 @@"));
        assert!(notes.content.contains("+line1\n+line2"));
        assert!(!notes.content.contains("\\ No newline at end of file"));

        let empty = service
            .diff(path.to_str().unwrap(), "empty.txt", false)
            .unwrap();
        assert!(!empty.binary);
        assert!(empty.content.contains("diff --git a/empty.txt b/empty.txt"));
        assert!(!empty.content.contains("@@"));

        let blob = service
            .diff(path.to_str().unwrap(), "blob.bin", false)
            .unwrap();
        assert!(blob.binary);
        assert!(blob.content.is_empty());
    }

    #[test]
    fn treats_glob_characters_in_filenames_literally_when_git_is_available() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let service = GitService::new(Some("git".into()));
        service.checked_output(path, ["init"]).unwrap();
        service
            .checked_output(path, ["config", "user.name", "ShellGrid Test"])
            .unwrap();
        service
            .checked_output(path, ["config", "user.email", "shellgrid@example.invalid"])
            .unwrap();
        service
            .checked_output(path, ["config", "core.autocrlf", "false"])
            .unwrap();
        fs::write(path.join("star[1]file.txt"), "content\n").unwrap();
        fs::write(path.join("star2file.txt"), "other\n").unwrap();

        // 未跟踪文件预览应命中字面文件名，而不是把 `[1]` 当作字符类展开。
        let diff = service
            .diff(path.to_str().unwrap(), "star[1]file.txt", false)
            .unwrap();
        assert!(diff.content.contains("diff --git a/star[1]file.txt"));
        assert!(!diff.content.contains("star2file.txt"));

        service
            .stage(path.to_str().unwrap(), &["star[1]file.txt".into()])
            .unwrap();
        let status = service.status(path.to_str().unwrap()).unwrap();
        let staged: Vec<&GitFileStatus> = status
            .files
            .iter()
            .filter(|file| file.index_status != "?")
            .collect();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].path, "star[1]file.txt");

        service
            .commit(path.to_str().unwrap(), "initial", false, false)
            .unwrap();
        fs::write(path.join("star[1]file.txt"), "changed\n").unwrap();
        service
            .stage(path.to_str().unwrap(), &["star[1]file.txt".into()])
            .unwrap();
        service
            .unstage(path.to_str().unwrap(), &["star[1]file.txt".into()])
            .unwrap();
        let status = service.status(path.to_str().unwrap()).unwrap();
        assert!(status
            .files
            .iter()
            .all(|file| file.index_status == "." || file.index_status == "?"));
        service
            .restore(path.to_str().unwrap(), &["star[1]file.txt".into()])
            .unwrap();
        assert_eq!(
            fs::read_to_string(path.join("star[1]file.txt")).unwrap(),
            "content\n"
        );
    }

    #[test]
    fn runs_local_repository_workflow_when_git_is_available() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let service = GitService::new(Some("git".into()));
        service.checked_output(path, ["init"]).unwrap();
        service
            .checked_output(path, ["config", "user.name", "ShellGrid Test"])
            .unwrap();
        service
            .checked_output(path, ["config", "user.email", "shellgrid@example.invalid"])
            .unwrap();
        service
            .checked_output(path, ["config", "core.autocrlf", "false"])
            .unwrap();
        fs::write(path.join("hello world.txt"), "你好，ShellGrid\n").unwrap();

        let status = service.status(path.to_str().unwrap()).unwrap();
        assert_eq!(status.files[0].index_status, "?");
        let untracked = service
            .diff(path.to_str().unwrap(), "hello world.txt", false)
            .unwrap();
        assert!(!untracked.binary);
        assert!(!untracked.truncated);
        assert!(untracked.content.contains("new file mode 100644"));
        assert!(untracked.content.contains("+你好，ShellGrid"));
        service
            .stage(path.to_str().unwrap(), &["hello world.txt".into()])
            .unwrap();
        let diff = service
            .diff(path.to_str().unwrap(), "hello world.txt", true)
            .unwrap();
        assert!(diff.content.contains("ShellGrid"));
        assert!(service
            .commit(path.to_str().unwrap(), "no head yet", true, false)
            .is_err());
        service
            .commit(path.to_str().unwrap(), "initial commit", false, false)
            .unwrap();
        let clean_status = service.status(path.to_str().unwrap()).unwrap();
        assert!(clean_status.files.is_empty());
        let unchanged = service
            .diff(path.to_str().unwrap(), "hello world.txt", false)
            .unwrap();
        assert!(unchanged.content.is_empty());
        fs::write(path.join("hello world.txt"), "已暂存版本\n").unwrap();
        service
            .stage(path.to_str().unwrap(), &["hello world.txt".into()])
            .unwrap();
        fs::write(path.join("hello world.txt"), "未暂存版本\n").unwrap();
        service
            .restore(path.to_str().unwrap(), &["hello world.txt".into()])
            .unwrap();
        assert_eq!(
            fs::read_to_string(path.join("hello world.txt")).unwrap(),
            "已暂存版本\n"
        );
        let restored_status = service.status(path.to_str().unwrap()).unwrap();
        assert_eq!(restored_status.files[0].index_status, "M");
        assert_eq!(restored_status.files[0].worktree_status, ".");
        assert_eq!(
            service.head_message(path.to_str().unwrap()).unwrap(),
            Some("initial commit".to_string())
        );
        service
            .commit(path.to_str().unwrap(), "amended commit", true, true)
            .unwrap();
        let amended = service
            .head_message(path.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(amended.starts_with("amended commit"));
        assert!(amended.contains("Signed-off-by: ShellGrid Test <shellgrid@example.invalid>"));
        assert_eq!(
            service
                .checked_output(path, ["rev-list", "--count", "HEAD"])
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap(),
            "1"
        );
        let initial_branch = clean_status.branch.unwrap();
        service
            .switch_branch(path.to_str().unwrap(), "feature/git-panel", true)
            .unwrap();
        assert_eq!(
            service
                .status(path.to_str().unwrap())
                .unwrap()
                .branch
                .as_deref(),
            Some("feature/git-panel")
        );
        service
            .switch_branch(path.to_str().unwrap(), &initial_branch, false)
            .unwrap();
        assert_eq!(
            service
                .status(path.to_str().unwrap())
                .unwrap()
                .branch
                .as_deref(),
            Some(initial_branch.as_str())
        );
    }
}
