# 从 Tauri 版迁移

首次 Electron 版采用卸载后重装。Tauri 与 electron-builder 的安装器标识和升级机制不同，不承诺直接覆盖安装。

1. 保存工作区并退出旧版 ShellGrid。
2. 在 Windows“已安装的应用”中卸载旧版。保留 `%LOCALAPPDATA%\ShellGrid`，不手动清理该目录。
3. 安装新版本 EXE 或 MSI，选择一种安装器。
4. 启动后读取同一个 workspace.json：布局、稳定 paneId、启动目录、Shell 参数和代理保持兼容。终端会话重新创建，历史输出和 Agent 进程不会恢复。

用户数据路径：

| 内容 | 路径 |
| --- | --- |
| 工作区（schemaVersion 1） | `%LOCALAPPDATA%\ShellGrid\workspace.json` |
| Electron/Chromium 缓存与偏好 | `%LOCALAPPDATA%\ShellGrid\electron` |
| 损坏工作区备份 | `%LOCALAPPDATA%\ShellGrid\workspace.corrupt-*.json` |

安装/卸载脚本不删除工作区。Electron 缓存与工作区分开；NSIS 的 deleteAppDataOnUninstall 明确关闭，MSI 不把用户业务数据登记为安装文件。需要备份时，复制工作区文件即可。

后续 Electron 版本使用稳定 appId `io.shellgrid.desktop` 和产品名称；递增版本后，使用与已安装版本相同的安装器正常升级。EXE 与 MSI 之间切换时先卸载旧安装器版本。发布包尚未配置代码签名证书。

工作区的无效代理会被单独剥离，旧数据缺少 rootPath 时从首个窗格 cwd 补全；损坏布局改名保留后回退单窗格。不能安全读取或保留旧文件时，本次运行禁止覆盖它。

## 架构变化

主进程负责窗口、受校验的桌面 IPC、工作区和 Git；preload 只暴露 window.shellgrid。渲染器启用沙箱、上下文隔离，关闭 Node 集成。

主进程通过 MessageChannelMain 把两端分别交给 preload 和单个 utilityProcess PTY Host。终端数据不经过主进程逐帧中转，不再打开 WebSocket 监听端口。每次连接都有新的 generation，恢复连接前关闭旧宿主并重新创建 Shell。

node-pty 直接创建 ConPTY 和 PowerShell，PTY Host 保存 node-pty 返回的真实 Shell PID，并负责会话输入、输出、暂停、恢复、调整尺寸和关闭。终端链路不再包含额外的原生启动器或控制管道。

输出约 5ms 合并；未消费字符超过 100,000 时暂停读取，低于 5,000 时恢复。xterm.write 完成后确认消费，退出状态等待尾部显示处理完成。计数使用 JavaScript 字符串长度，保留 node-pty 事件顺序。
