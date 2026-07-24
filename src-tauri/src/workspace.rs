use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_PANES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayoutNode {
    Pane {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneLaunchInfo {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub shell: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStateV1 {
    pub schema_version: u8,
    pub layout: LayoutNode,
    pub panes: HashMap<String, PaneLaunchInfo>,
}

impl WorkspaceStateV1 {
    pub fn default_at(cwd: &Path, shell: String) -> Self {
        let pane_id = Uuid::new_v4().to_string();
        let layout = LayoutNode::Pane {
            pane_id: pane_id.clone(),
        };
        let panes = HashMap::from([(
            pane_id,
            PaneLaunchInfo {
                cwd: cwd.to_string_lossy().into_owned(),
                title: None,
                shell,
                args: vec!["-NoLogo".into()],
            },
        )]);
        Self {
            schema_version: 1,
            layout,
            panes,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("不支持的工作区版本".into());
        }
        let mut ids = Vec::new();
        collect_panes(&self.layout, &mut ids)?;
        if ids.is_empty() || ids.len() > MAX_PANES {
            return Err(format!("窗格数量必须在 1 到 {MAX_PANES} 之间"));
        }
        let unique: HashSet<_> = ids.iter().collect();
        if unique.len() != ids.len() {
            return Err("工作区包含重复窗格".into());
        }
        for id in ids {
            let pane = self
                .panes
                .get(id)
                .ok_or_else(|| format!("窗格 {id} 缺少启动信息"))?;
            if pane.shell.trim().is_empty() || pane.cwd.trim().is_empty() {
                return Err(format!("窗格 {id} 的启动信息无效"));
            }
        }
        Ok(())
    }
}

fn collect_panes<'a>(node: &'a LayoutNode, output: &mut Vec<&'a str>) -> Result<(), String> {
    match node {
        LayoutNode::Pane { pane_id } => output.push(pane_id),
        LayoutNode::Split {
            ratio,
            first,
            second,
            ..
        } => {
            if !(0.15..=0.85).contains(ratio) || !ratio.is_finite() {
                return Err("分割比例超出允许范围".into());
            }
            collect_panes(first, output)?;
            collect_panes(second, output)?;
        }
    }
    Ok(())
}

pub fn load_or_default(path: &Path, fallback: WorkspaceStateV1) -> WorkspaceStateV1 {
    let Ok(contents) = fs::read(path) else {
        return fallback;
    };
    let parsed = serde_json::from_slice::<WorkspaceStateV1>(&contents);
    match parsed {
        Ok(workspace) if workspace.validate().is_ok() => workspace,
        _ => {
            preserve_corrupt(path);
            fallback
        }
    }
}

pub fn save(path: &Path, workspace: &WorkspaceStateV1) -> Result<(), String> {
    workspace.validate()?;
    let parent = path.parent().ok_or("工作区路径没有父目录")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(workspace).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".workspace-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    atomic_replace(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

fn preserve_corrupt(path: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs());
    let corrupt = path.with_file_name(format!("workspace.corrupt-{stamp}.json"));
    let _ = fs::rename(path, corrupt);
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

pub fn workspace_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ShellGrid")
        .join("workspace.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fallback() -> WorkspaceStateV1 {
        WorkspaceStateV1::default_at(Path::new("C:\\"), "pwsh.exe".into())
    }

    #[test]
    fn round_trips_workspace_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let expected = fallback();
        save(&path, &expected).unwrap();
        assert_eq!(load_or_default(&path, fallback()), expected);
    }

    #[test]
    fn preserves_corrupt_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        fs::write(&path, b"not json").unwrap();
        let expected = fallback();
        assert_eq!(load_or_default(&path, expected.clone()), expected);
        assert!(!path.exists());
        assert!(fs::read_dir(directory.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("workspace.corrupt-")));
    }

    #[test]
    fn rejects_too_many_panes() {
        let mut state = fallback();
        for index in 0..MAX_PANES {
            state.panes.insert(
                format!("extra-{index}"),
                PaneLaunchInfo {
                    cwd: "C:\\".into(),
                    title: None,
                    shell: "pwsh.exe".into(),
                    args: vec![],
                },
            );
        }
        // Unreferenced launch records do not alter the live layout.
        assert!(state.validate().is_ok());
    }
}
