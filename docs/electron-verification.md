# Electron Windows 验证记录

本页记录 0.3.1 的 Electron + node-pty 终端验证结果、复现入口和验收边界。日期使用北京时间（UTC+8）；JSON 报告中的日期使用 UTC。`artifacts` 已被 Git 忽略，原始报告保留在执行测试的机器或 CI artifact 中。

## 本轮基础检查

2026-09-06 执行以下检查，均通过：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | Svelte 检查 0 错误、0 警告；Electron TypeScript 检查通过 |
| `npm test` | 前端 6 个文件、35 项测试；服务及协议 9 个文件、39 项测试通过 |
| `npm run build` | Vite 生产资源、Electron 主进程/preload/PTY Host 和 node-pty ConPTY 构建通过 |
| `npm run test:windows` | 真实 ConPTY、PTY Host、渲染器和关闭流程通过 |

本轮开发工具为 PowerShell 7.6.5、Node 24.19.0、npm 11.17.0。Electron 内置 Node 的版本见后面的运行时记录。构建仍有 xterm 分块超过 500 kB 的 Vite 提示，构建退出码为 0。

单元测试覆盖协议非法消息和 UUID、连接 generation、并发创建、创建中关闭、快速重建、迟到事件隔离、输出顺序、ACK 反压和退出尾部处理；也覆盖工作区兼容与原子保存、Git 路径、输出边界、剪贴板图片校验、受限 IPC 和主进程关闭协调。

## 真实 Windows 回归

完成 `npm run build` 后，在仓库根目录运行：

```powershell
npm run test:windows
```

入口为 [test-windows.mjs](../scripts/test-windows.mjs)。完整运行依次验证 PTY Host 和真实 Electron 渲染器，成功后写入 `artifacts\windows-verification.json`。每次运行的中间结果位于 `artifacts\windows-<时间戳>`。

本轮 2026-09-06 22:58 完整复测通过，`artifacts\windows-verification.json` 的记录时间为 `2026-09-06T14:58:45.353Z`，包含以下结果：

| 范围 | 已验证内容 |
| --- | --- |
| 真实 ConPTY 输出 | 连续输出顺序、尾部标记、退出码、超过高水位暂停和 ACK 后恢复 |
| 启动与输入 | 创建期间取消、可执行文件不存在、Ctrl+C 后 Shell 继续工作、仅报告 cwd 的集成 |
| 尺寸与优先级 | 调整到 132×44 并读取实际控制台尺寸、真实 Shell PID 的 Normal/BelowNormal 切换 |
| 进程生命周期 | 自然退出、关闭窗格和 Host 正常关闭时，直接由 node-pty 管理 Shell 会话 |
| 并发与资源释放 | 16 个独立 Shell；Host 关闭后回收会话；重复自然退出后释放 node-pty 输出 worker 和输入管道句柄 |
| 桌面与兼容 | 沙箱、上下文隔离、受限 preload、旧 workspace Bootstrap、非法外链协议拒绝 |
| 终端实例 | 分割、关闭相邻窗格、窗口缩放和调整尺寸时保留原有 xterm DOM 宿主 |
| 输入与剪贴板 | 经真实 xterm 输入链路返回中文；剪贴板字节 IPC 保持内容和保存目录 |
| 关闭流程 | 取消关闭保留会话；保存失败后二次确认可取消；确认关闭保存最新布局并回收会话 |

脚本把 `LOCALAPPDATA` 指向独立测试目录。测试报告只保存结果、计数、PID 和资源指标，不保存终端内容。

UI 自动化使用真实的隐藏窗口，并由测试代码选择确认对话框的回答。中文输入通过 `webContents.insertText` 注入；系统输入法的候选、组合和提交过程仍需人工验收。

可单独运行 `node scripts\test-windows.mjs --host-only` 或 `node scripts\test-windows.mjs --ui-only`。Host-only 会覆盖汇总报告，但其中不含 UI 结果；UI-only 仅输出本次目录内的 `ui-report.json`。判断完整回归是否通过时需检查报告包含 `host` 和 `ui`。

## 打包与安装器

```powershell
npm run dist:win
node scripts\test-windows.mjs --packaged
npm run test:installers
```

`dist:win` 构建 Windows x64 的 NSIS EXE 和 MSI，输出到 `release`。`--packaged` 使用开发依赖中的 Electron 运行测试入口，加载 `release\win-unpacked\resources` 内的 asar、PTY Host 和 node-pty，以验证打包后的模块及路径。汇总 JSON 不记录是否使用了 `--packaged`，应同时保留执行命令和退出结果。

[安装器测试](../scripts/verify-installers.ps1) 在仓库内的临时安装目录执行每用户安装、后续版本升级和卸载，检查产品登记版本以及 node-pty 的 DLL、worker 文件。脚本遇到已有 ShellGrid 安装或同名快捷方式时会停止。

数据保留验证对真实 `%LOCALAPPDATA%\ShellGrid` 中的工作区计算哈希，并创建唯一名称的图片测试文件；只在工作区不存在时建立测试工作区。清理时仅删除由本次创建且内容未变的测试文件。原有工作区不会被覆盖。

本轮 `artifacts\installer-verification.json` 记录 NSIS、MSI 的 0.3.0 → 0.3.1 安装、升级和卸载共 6 项通过，工作区与图片保持不变。

这些测试覆盖安装文件、版本登记和业务数据保留。安装后通过桌面快捷方式启动的完整交互、代码签名及 SmartScreen 体验仍需发布验收；首次从 Tauri 版迁移按[迁移说明](electron-migration.md)先卸载再安装。

## Release 性能样本

先完成生产构建，再单独运行基准，期间不运行其他 ShellGrid 测试：

```powershell
npm run build
npm run bench:windows
```

[基准入口](../scripts/bench-windows.mjs) 依次测量 1、4、16 个窗格，写入 `artifacts\windows-benchmark.json`；[测量实现](../tests/windows/benchmark.ts) 使用 Electron Release 运行时、Vite 生产资源和直接 node-pty ConPTY。

以下数据来自本轮 2026-09-06 23:05 的 direct node-pty ConPTY 报告。机器与运行条件：

| 项目 | 记录 |
| --- | --- |
| Windows 内核版本 | 10.0.26200，x64 |
| CPU | Intel Core i5-12600KF，12 个逻辑处理器 |
| 系统内存 | 15.86 GiB |
| 运行时 | Electron 42.8.1，内置 Node 24.18.1 |
| 终端依赖 | node-pty 1.2.0-beta.15，xterm 6.1.0-beta.292 |
| 窗口与 Shell | 真实隐藏 BrowserWindow，PowerShell `-NoProfile`，未运行 Agent CLI |

| 窗格数 | 启动耗时（ms） | 响应 p50 / p95（ms） | 总吞吐（百万字符/s） | 空闲 Electron / PTY 工作集（MiB） | 采样最大 Electron / PTY 工作集（MiB） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 963 | 15.8 / 30.1 | 1.87 | 441.5 / 102.2 | 499.9 / 120.0 |
| 4 | 836 | 29.5 / 30.9 | 4.22 | 465.6 / 407.9 | 586.1 / 475.8 |
| 16 | 970 | 40.2 / 79.7 | 4.59 | 572.9 / 1629.1 | 988.7 / 1898.1 |

指标定义：

- 启动耗时从测试模块初始化计时，到全部会话创建且 UI 显示运行状态为止，不包含 Electron 进程启动前的时间。
- 响应延迟从渲染器发送合成命令计时，到渲染器收到对应输出标记为止；每窗格 10 轮，样本数分别为 10、40、160。分位数按排序后的对应索引取值，没有跨多次运行统计波动。
- 吞吐测试每窗格输出 40,000 行，统计全部窗格收到的 JavaScript 字符串长度及最终标记到达时间。表中为所有窗格的合计吞吐，不是字节速率。
- 测试使用真实 xterm 消费与 ACK，但响应和吞吐的计时终点在数据到达渲染器时，不代表最后一次 `xterm.write` 回调或屏幕绘制已完成。
- 空闲资源在预热和 2 秒等待后采样。负载期间每 750 ms 尝试采样，避免采样任务重叠，结束时追加一次采样；表中的最大值只是观测值。
- Electron 工作集为 `app.getAppMetrics()` 中各进程工作集之和；PTY 工作集单独统计其后代，包括 PowerShell 和 OpenConsole。采样 PowerShell 自身被排除，工作集可能重复包含共享内存页。
- 原始报告中的 Electron CPU 为进程百分比之和；PTY CPU 为 CIM 用户态与内核态累计秒数，`ptyCpuSecondsDelta` 是输出阶段消耗的 CPU 秒数，不能当作 CPU 百分比或峰值。

隐藏窗口、合成命令和 `-NoProfile` 不覆盖可见窗口的输入到绘制延迟、用户 Profile 开销或 Agent CLI 负载。该样本也没有 Tauri 对照组，不能用于宣称迁移后的性能提升。

## 待人工验收

当前自动化尚未完成以下验收：

| 场景 | 验收内容 |
| --- | --- |
| Codex、Claude Code、Gemini CLI | 实际启动与持续交互、流式输出、长内容滚动、重绘、Ctrl+C 中断、重启及窗格关闭 |
| 中文输入法 | Windows 系统输入法候选窗定位、连续组合、提交与取消、切换焦点、缩放和多窗格下输入 |
| VT 可视表现 | 备用屏幕进出、TrueColor、中文宽字符/组合字符/emoji、快速刷新与真实 ConPTY 缩放后的画面 |
| 终端交互 | 鼠标选择与鼠标报告、焦点报告、括号粘贴、OSC 8 和普通 HTTP/HTTPS 链接点击 |
| 渲染回退 | 可见窗口下 WebGL 上限、上下文丢失后的回退和不同 DPI 的显示效果 |
| 系统与发布 | 声明支持的最低 Windows 10 1903 环境、安装后完整启动及升级体验 |

[VT 测试](../electron/pty/vt.test.ts) 已验证 headless xterm 的备用屏幕、TrueColor、宽/组合字符、光标查询、刷新和部分模式切换；它不能替代上表中的实际输入和可视验收。上述人工项在取得操作记录前保持未验收状态。
