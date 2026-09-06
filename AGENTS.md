# AGENTS.md

本文件适用于整个仓库。修改代码前先阅读相关模块，以当前实现和测试为准，不要仅依据产品计划推断行为。

## 项目概览

ShellGrid 是 Windows x64 多终端桌面应用，采用 Electron 42.8.1、Svelte 5、TypeScript、node-pty 1.2.0-beta.15 和 xterm 6.1.0-beta.292。Electron 主进程负责桌面服务，单个 utilityProcess PTY Host 管理全部 ConPTY 会话。Rust 仅用于受 Job Object 保护的原生启动器。

运行要求：Windows 10 1903+、PowerShell 7。安装包自带 Electron，不需要 WebView2、Node 或 Rust。开发要求 Node 24/npm、Rust 1.82+ 和 MSVC 工具链。命令在 Windows PowerShell 中运行，路径使用反斜杠。如需 Python，使用 `D:\workspace\python_venv\Scripts\python.exe`。

## 目录与职责

- `src/App.svelte`：Bootstrap、工作区状态、窗格操作、保存、重连和主进程请求的最新布局快照。
- `src/components/`：递归布局、终端窗格和 Git 面板。
- `src/lib/layout.ts`：布局纯函数、16 窗格上限和比例限制。
- `src/lib/terminalRegistry.ts`：以 paneId 保存稳定 xterm 实例、DOM 宿主移动、渲染和输入。
- `src/lib/terminalClient.ts`：MessagePort 客户端、请求及会话映射、xterm 消费确认和尾部退出处理。
- `shared/protocol.ts`、`shared/desktop.ts`：受校验的终端协议及 window.shellgrid 类型。
- `shared/workspace.ts`：schemaVersion 1 校验和持久化字段白名单。
- `electron/main.ts`、`preload.ts`、`security.ts`：窗口、受限 IPC 和调用来源校验。
- `electron/terminal-service.ts`、`pty-host.ts`、`pty/`：utilityProcess 生命周期、会话所有权、node-pty 和输出反压。
- `electron/close-coordinator.ts`：主进程关闭确认、获取最新布局、保存、回收会话和最终退出。
- `electron/services/`：工作区、剪贴板图片、Git 和运行环境探测。
- `native/launcher/`：挂起创建进程、Job Object、真实 Shell PID、独立命名管道和父进程存活监测。
- `scripts/`、`tests/windows/`：构建、真实 Windows 回归和 Release 性能测量。

不要手工编辑 node_modules、dist、dist-electron、release 或 native/launcher/target 中的生成文件。Rust 启动器以外不再保留 Tauri 工程。

## 核心不变量

- 布局是递归 PaneNode | SplitNode 树；持久化稳定 paneId，运行时 sessionId、连接代次、终端输出、环境快照和 Agent 状态不得持久化。
- 最多 16 个窗格；默认分割 50/50，比例范围 0.15–0.85。
- 读取 Bootstrap 并连接终端服务成功后才挂载布局、创建终端，不要提前挂载临时窗格。
- 同一 paneId 的 xterm 实例在布局更新或 DOM 移动时保持不变；只有真正关闭窗格时才 dispose。
- 创建前读取实际尺寸；创建过程中保存最新尺寸。重启前排空旧 xterm 写入，重置 VT 状态，隔离迟到事件。
- 一个 PTY Host 管理全部会话；MessagePort 在 preload 和 Host 间直接传输数据，不经过主进程逐帧转发，不监听网络端口。
- 每个命令/事件携带连接 generation；请求 ID 和 sessionId 使用 UUID，paneId 使用持久化标识。两端必须校验消息，重复创建不能产生第二个进程。
- 保持 node-pty 输出顺序，直接交给 xterm；不得按行改写或按缓存条数丢弃输出。真正关闭的窗格和旧代次事件可以释放。
- Host 约每 5ms 合并输出，按 JavaScript 字符串长度计数。未确认字符超过 100,000 时 pause，低于 5,000 时 resume。前端在 xterm.write 回调后每累计 5,000 字符 ACK；退出必须等待尾部回调完成。不要恢复前后台 8ms/33ms 节流。
- onData 和 onBinary 输入都必须保留；binary 是字节字符串，不得当作 UTF-8 二次编码。
- 每个会话启动独立 PowerShell，默认加载 Profile；Shell integration 只报告 cwd，不读取命令、历史或终端内容。
- 主进程校验 IPC 的 WebContents、主 Frame、精确入口 URL 和参数。preload 不得暴露 ipcRenderer、任意 invoke、Node API 或原始事件对象。
- 保持 contextIsolation、sandbox 和 webSecurity 开启，nodeIntegration 关闭；禁止导航到外部页面、webview 和弹出窗口。外链只允许 HTTP/HTTPS。
- 不把 PTY 输出、Agent 消息、命令内容或潜在密钥写入日志。IPC 错误以受控数据返回，避免 Electron 自动记录被拒绝的处理器异常。

## 前端约定

- 保持 TypeScript 严格检查通过，复用已有组件、上下文和布局函数。
- 滚动历史为 10,000 行；最多 4 个 WebGL 上下文，失败或上下文丢失后使用 xterm 内置渲染器。
- bundled ConPTY 支持现代 reflow；windowsPty 配置的兼容特征应与实际后端一致。改变缩放、初始化或 VT 行为时验证真实 ConPTY。
- 快捷键不得占用 Ctrl+C、Ctrl+V、Enter、Escape、Shift+Tab 等 Shell/Agent 常用键。
- 默认中文界面，Shell/Agent 输出保持原样。
- 剪贴板图片只粘贴本地文件路径，IPC 使用字节数组，最大 20 MiB；保留图片格式检查和七天清理规则。

## 进程和数据约定

- node-pty 为原生启动器创建 ConPTY，不得用重定向管道代替 PTY。
- 启动器用 CREATE_SUSPENDED 创建 Shell，先加入 KILL_ON_JOB_CLOSE Job，再恢复。Profile 的第一个子进程也必须受保护，失败路径不能遗留挂起进程。
- Job 句柄不可继承，只有启动器持有。主进程退出、Host 退出、控制管道断开、启动器被终止和正常关闭均必须回收子进程树。
- 启动器继承真实控制台，只处理生命周期控制消息；不得读取/转发终端内容。Ctrl+C 使用不被子进程继承的控制处理器，不使用继承的忽略标志或 CREATE_NEW_PROCESS_GROUP。
- 同步命名管道不能用重复句柄并发阻塞读写；使用 PeekNamedPipe 后读取已就绪的字节，保持存活检查和就绪/退出通知可推进。
- node-pty 1.2.0-beta.15 在自然 EOF 后需要额外释放 Windows 输入 socket 和输出 worker；适配集中在 NodePtyFactory，仅在 onExit 后执行。升级依赖时必须重新核对其内部结构并运行资源释放回归。
- 通过真实 Shell PID 设置 NORMAL / BELOW_NORMAL 优先级；后续新建子进程继承其优先级类，既有后代不会自动全部更新。
- 工作区仍位于 `%LOCALAPPDATA%\ShellGrid\workspace.json`，schemaVersion 为 1；旧 rootPath 补全、无效代理剥离、损坏文件保留和串行原子保存必须兼容。
- 不能读取或保留损坏工作区时禁止覆盖原文件。临时保存文件必须和目标同目录，写入并 sync 后 rename。
- Chromium 用户数据单独放在 ShellGrid\electron；剪贴板图片继续放在 ShellGrid\clipboard-images。安装及卸载不能清理这两个业务数据文件/目录。
- Git 参数通过 spawn 数组传入，不通过 Shell 拼接；文件使用 literal pathspec，未跟踪预览不能越过仓库边界。保留 diff/消息输出上限以及恢复、强制推送确认流程。
- 关闭确认在主进程协调；取消保留应用和进程，确认获取最新布局并保存后关闭会话，最终关闭必须绕过重复确认。保存失败仍需单独确认。

## 开发与验证

```powershell
npm ci
npm run dev
npm run check
npm test
npm run build
cargo fmt --manifest-path native\launcher\Cargo.toml -- --check
cargo test --locked --manifest-path native\launcher\Cargo.toml
cargo clippy --locked --manifest-path native\launcher\Cargo.toml --all-targets -- -D warnings
npm run test:windows
npm run bench:windows
npm run dist:win
node scripts\test-windows.mjs --packaged
npm run test:installers
```

`npm run dev` 启动完整 Electron 桌面和 Vite HMR；Electron/preload/Host 源码改动后重启开发命令。`npm run dev:web` 仅预览界面，不能验证桌面服务或 PTY。产物位于 release，运行程序位于 release\win-unpacked。

- 交付前至少运行类型检查、前端/服务测试、完整构建、Rust 测试、格式和 Clippy。改动进程、传输或关闭流程时运行真实 Windows 套件；修改安装配置时构建并验证两种安装包。
- 协议覆盖非法消息、UUID、并发创建、创建中关闭、快速重启、旧代次、输出顺序、ACK 反压和尾部退出。挂载改动验证 xterm 不重建。
- VT/渲染回归包括备用屏幕、TrueColor、宽/组合字符、输入法、鼠标、焦点、括号粘贴、OSC 8、快速刷新和缩放。
- 性能结论只来自 Release 运行时和可重复脚本；测量时不能同时运行其他 ShellGrid 测试。指标定义、机器信息和限制一起记录。
- Windows 测试使用临时数据目录和独立 PowerShell Profile 副本，不覆盖用户 Profile/工作区；报告只保存结果、计数、PID 和资源指标。

## 已知边界

真实 Windows 自动化入口及已执行结果见 `docs/electron-verification.md`。Codex、Claude Code、Gemini CLI 的完整交互回归、人工中文输入法组合过程及全部 VT/鼠标/链接场景仍需人工验收，不能把测试入口存在描述成验收完成。首版不支持终端图片协议、多命名工作区、云同步或结构化聊天面板。

## 修改与提交原则

保持改动聚焦；优先厘清 paneId、sessionId、xterm、PTY Host、启动器和 OS 进程的所有权。新增依赖先确认现有依赖或标准库不能解决，并更新锁文件。

创建提交前先看近期 git log。使用 Conventional Commits：`type: 中文简洁描述`，类型小写，冒号后一个空格，单行、无句号。通常不加 scope；不得包含 Co-Authored-By 或 AI 工具署名。常用类型 feat、fix、chore、docs、test、refactor、perf、build、ci。
