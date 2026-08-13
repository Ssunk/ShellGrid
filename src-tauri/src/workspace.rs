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
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub no_proxy: String,
}

impl ProxyConfig {
    // 仅在启用时校验地址：停用状态允许保留用户未写完的草稿。
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let parsed =
            url::Url::parse(self.url.trim()).map_err(|_| "代理地址格式无效".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
            return Err("代理协议只支持 http、https、socks5 或 socks5h".into());
        }
        if parsed.host_str().map_or(true, str::is_empty) {
            return Err("代理地址缺少主机".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStateV1 {
    pub schema_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    pub layout: LayoutNode,
    pub panes: HashMap<String, PaneLaunchInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
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
            root_path: Some(cwd.to_string_lossy().into_owned()),
            layout,
            panes,
            proxy: None,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("不支持的工作区版本".into());
        }
        if self
            .root_path
            .as_ref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err("工作区目录无效".into());
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
        if let Some(proxy) = &self.proxy {
            proxy.validate()?;
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
    let parsed = serde_json::from_slice::<WorkspaceStateV1>(&contents).map(|mut workspace| {
        // 代理配置损坏时只丢弃代理本身，不能让整个布局回退为默认单窗格。
        if workspace
            .proxy
            .as_ref()
            .is_some_and(|proxy| proxy.validate().is_err())
        {
            workspace.proxy = None;
        }
        if workspace.root_path.is_none() {
            workspace.root_path = first_pane_id(&workspace.layout)
                .and_then(|pane_id| workspace.panes.get(pane_id))
                .map(|pane| pane.cwd.clone());
        }
        workspace
    });
    match parsed {
        Ok(workspace) if workspace.validate().is_ok() => workspace,
        _ => {
            preserve_corrupt(path);
            fallback
        }
    }
}

fn first_pane_id(node: &LayoutNode) -> Option<&str> {
    match node {
        LayoutNode::Pane { pane_id } => Some(pane_id),
        LayoutNode::Split { first, .. } => first_pane_id(first),
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
        .map_or(0, |value| value.as_millis());
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

    #[test]
    fn round_trips_proxy_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let mut expected = fallback();
        expected.proxy = Some(ProxyConfig {
            enabled: true,
            url: "http://127.0.0.1:7890".into(),
            no_proxy: "localhost,127.0.0.1".into(),
        });
        save(&path, &expected).unwrap();
        assert_eq!(load_or_default(&path, fallback()), expected);
    }

    #[test]
    fn validates_proxy_only_when_enabled() {
        let mut state = fallback();
        state.proxy = Some(ProxyConfig {
            enabled: false,
            url: "还没写完".into(),
            no_proxy: String::new(),
        });
        assert!(state.validate().is_ok());
        for url in ["not a url", "ftp://127.0.0.1:21", "http://"] {
            state.proxy = Some(ProxyConfig {
                enabled: true,
                url: url.into(),
                no_proxy: String::new(),
            });
            assert!(state.validate().is_err(), "应拒绝启用的非法代理：{url}");
        }
        for url in ["http://127.0.0.1:7890", "socks5://proxy.local:1080"] {
            state.proxy = Some(ProxyConfig {
                enabled: true,
                url: url.into(),
                no_proxy: String::new(),
            });
            assert!(state.validate().is_ok(), "应接受合法代理：{url}");
        }
    }

    #[test]
    fn drops_invalid_proxy_on_load_but_keeps_layout() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let expected = fallback();
        let mut json = serde_json::to_value(&expected).unwrap();
        json["proxy"] = serde_json::json!({ "enabled": true, "url": "not a url" });
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        let loaded = load_or_default(&path, fallback());
        assert_eq!(loaded, expected);
        assert!(loaded.proxy.is_none());
        // 只丢弃代理，不把工作区文件改名为损坏备份。
        assert!(path.exists());
    }

    #[test]
    fn derives_root_path_when_loading_an_older_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let expected = fallback();
        let mut json = serde_json::to_value(&expected).unwrap();
        json.as_object_mut().unwrap().remove("rootPath");
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        let loaded = load_or_default(&path, fallback());
        assert_eq!(loaded.root_path, Some("C:\\".into()));
        assert!(path.exists());
    }
}
