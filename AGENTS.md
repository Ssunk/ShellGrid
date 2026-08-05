# AGENTS.md

本文件适用于整个仓库。修改代码前先阅读相关模块，并以当前实现和测试为准，不要仅依据产品计划推断行为。

## 项目概览

ShellGrid 是 Windows x64 专用的多终端桌面应用，技术栈为 Tauri 2、Rust、Svelte 5、TypeScript 和 xterm.js。每个窗格对应一个真实的 Windows ConPTY 会话和独立的 PowerShell 7 进程；WebView2 只负责界面、终端解析与渲染。

运行环境要求：

- Windows 10 1903 或更高版本
- PowerShell 7（`pwsh.exe`）
- WebView2 Runtime
- Node.js/npm
- Rust 1.77.2 或更高兼容版本（MSVC 工具链）

如果任务需要 Python，不要直接运行 `python` 或 `python3`，使用 `uv`，例如 `uv run python <script>`。

## 目录与职责

- `src/App.svelte`：应用启动、工作区状态、窗格操作、保存和窗口关闭流程。
- `src/components/`：递归布局节点和终端窗格视图。
- `src/lib/layout.ts`：布局树的纯函数；分割、关闭折叠、比例限制和 16 窗格上限。
- `src/lib/terminalRegistry.ts`：按 `paneId` 保存稳定的 xterm.js 实例；布局变化不应重建终端。
- `src/lib/terminalClient.ts`：浏览器端 WebSocket 协议、会话映射和输出批处理。
- `src-tauri/src/terminal.rs`：本机 WebSocket 服务、ConPTY、PowerShell 生命周期和传输反压。
- `src-tauri/src/job.rs`：Windows Job Object；保证关闭会话或应用时回收整个子进程树。
- `src-tauri/src/workspace.rs`：工作区校验、加载、损坏文件保留和原子保存。
- `src-tauri/src/lib.rs`：Tauri 命令、环境检测、Bootstrap 和应用退出处理。

不要手工编辑 `node_modules/`、`dist/` 或 `src-tauri/target/` 中的生成文件。

## 核心不变量

- 布局是递归的 `PaneNode | SplitNode` 树；持久化的是稳定 `paneId`，运行时 `sessionId` 不得持久化。
- 最多允许 16 个窗格；分割默认 50/50，比例限制在 0.15 到 0.85。
- 应用启动时先读取 Bootstrap 并连接 WebSocket，之后再挂载布局和创建终端。不要重新引入临时窗格的提前挂载。
- 同一 `paneId` 的 xterm.js 实例在布局更新或 DOM 宿主移动时必须保持不变，只有真正关闭窗格时才释放。
- 每个窗格启动独立 PowerShell 7，默认加载用户 Profile。Shell integration 只能上报当前目录，不得读取命令、历史或终端内容。
- 终端输出必须保持原始字节顺序。不得按行解析、改写输出或静默丢弃数据。
- WebSocket 只能监听随机的 `127.0.0.1` 端口，并使用每次启动生成的令牌。
- 控制消息使用 JSON；高频输入/输出使用二进制帧。当前帧格式为 1 字节类型、16 字节会话 UUID、其余为载荷。
- Rust 端会话输出队列必须有界，并通过阻塞读取形成 ConPTY 反压。
- 关闭单个窗格或整个应用时，必须终止相应 Job Object 中的 PowerShell 及其子进程。窗口关闭确认监听器不能递归阻止最终关闭。
- 工作区保存到 `%LOCALAPPDATA%\ShellGrid\workspace.json`。只保存布局和启动信息，不保存终端输出、环境变量快照或 Agent 进程状态。
- `open_external` 只允许 `http` 和 `https`。不要放宽协议白名单。
- 不得把 PTY 输出、Agent 消息、命令内容或潜在密钥写入日志。

## 前端约定

- 保持 TypeScript 严格检查通过。
- 优先复用现有 Svelte 组件、上下文和布局纯函数，不要在组件中复制树操作逻辑。
- 终端默认保留 10,000 行滚动历史；改变该值时评估多窗格内存影响。
- 剪贴板图片保存在 `%LOCALAPPDATA%\ShellGrid\clipboard-images`，终端中只粘贴文件路径；不要把图片原始字节写入 ConPTY。
- WebGL 上下文当前最多 4 个，加载失败后使用 xterm.js 内置渲染器。
- 活动窗格输出约每 8ms 合并，后台窗格约每 33ms 合并，每次最多 64KiB。改变批处理时同时验证输入延迟、输出顺序和内存增长。
- 快捷键不得占用终端和 Agent 常用键，例如 `Ctrl+C`、`Ctrl+V`、`Enter`、`Escape` 和 `Shift+Tab`。
- 默认界面语言为中文；Shell 和 Agent 输出保持原样。

## Rust 与进程约定

- Windows 终端实现使用 `portable-pty`/ConPTY，不要用重定向管道替代 PTY。
- 每个会话的 reader、writer、尺寸和生命周期必须独立，任何会话 ID 映射都要防止串流。
- 会话拥有 Job Object，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。新增启动路径时也必须进入相同的进程回收机制。
- 不要在持有全局会话锁时执行长时间异步等待。
- 保持错误消息可用于中文界面显示，但不要附带终端内容。

## 当前已知边界

- Rust 端目前接收 `set_priority`，但处理分支是空操作。当前只有前端 8ms/33ms 显示批处理，不代表后台 PowerShell 的 Windows 进程优先级已降低。
- 尚未完成自动化真实 ConPTY 集成测试。
- Codex、Claude Code、Gemini CLI 的完整交互回归以及 16 会话 CPU、内存、延迟基准尚未形成可重复的验收结果。
- 首版不支持终端图片协议、多命名工作区、云同步或结构化聊天面板。

实现新功能时，不要把上述边界描述为已经完成；若完成其中一项，应同步更新本文件并补充相应测试或基准记录。

## 开发命令

在仓库根目录运行：

```powershell
npm install
npm run tauri dev
```

`npm run dev` 只启动 Vite 前端，不能验证 Tauri 命令、ConPTY、Job Object 或真实 PowerShell 会话。

前端验证：

```powershell
npm run check
npm test
npm run build
```

Rust 验证：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Windows 安装包构建：

```powershell
npm run tauri build
```

产物位于 `src-tauri/target/release/`，NSIS 和 MSI 位于其 `bundle/` 子目录。

## 测试要求

- 修改布局逻辑时，更新 `src/lib/layout.test.ts`，覆盖分割、比例、关闭折叠、上限和序列化校验。
- 修改终端挂载或注册表时，验证布局变化不会重建 xterm.js 实例。
- 修改传输协议时，同时更新 Rust 和 TypeScript 两端，并测试帧类型、UUID、顺序、错误路径和反压。
- 修改进程生命周期时，在 Windows 上验证正常退出、强制关闭和子进程树回收。
- 修改窗口关闭流程时，验证“取消”保留应用和进程，“确认”保存布局后退出且无残留进程。
- 修改 VT 或渲染行为时，至少回归备用屏幕、TrueColor、宽字符、组合字符、鼠标、焦点、括号粘贴、OSC 8、快速刷新和缩放。
- 变更范围较小时运行相关测试；交付前至少运行类型检查、前端测试、前端构建、Rust 测试和 Clippy。涉及安装配置时再构建 Tauri 安装包。

## 修改原则

- 保持改动聚焦，遵循现有模块边界，不做无关重构。
- 修复生命周期问题时优先找清楚 `paneId`、`sessionId`、xterm 实例和 OS 进程四者的所有权关系。
- 新增依赖前先确认标准库或现有依赖不能解决，并同步提交相应锁文件变化。
- 不要删除或覆盖用户的工作区文件来修复加载问题；损坏状态应改名保留并回退到默认单窗格。
- 性能结论必须来自 Release 构建和可复现测量，不要用 Debug 构建或主观感受宣称达到指标。
