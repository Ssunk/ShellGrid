# ShellGrid

Windows x64 多终端桌面应用，每个窗格对应一个真实 ConPTY 会话和独立 PowerShell 7 进程。

![ShellGrid 主界面](main.png)

## 特性

- 最多 16 个窗格，递归分割、比例调整，移动布局保留终端实例
- PowerShell 默认加载用户 Profile；前台/后台 Shell 使用独立的进程优先级
- xterm.js、10,000 行历史、搜索、最多 4 个 WebGL 上下文及自动回退
- 独立 PTY Host、MessagePort 传输、消费确认和有界输出反压
- 直接使用 node-pty/ConPTY 管理 Shell，支持关闭确认和工作区自动保存
- 文件夹工作区、代理设置、Git 暂存/差异/提交/分支/拉取/推送

## 安装

需要 Windows 10 1903 或更高版本（x64）和 PowerShell 7。安装包已包含 Electron，不需要另装 WebView2 或 Node。

提供 NSIS EXE 和 MSI，选择其中一种安装。首次从 Tauri 版迁移需先卸载旧程序再安装 Electron 版，业务数据继续保留在 `%LOCALAPPDATA%\ShellGrid`。详见[迁移说明](docs/electron-migration.md)。

## 开发

技术栈：Electron 42.8.1 / node-pty 1.2.0-beta.15 / xterm 6.1.0-beta.292 / Svelte 5 / TypeScript。

准备 Node 24、npm 和 PowerShell 7：

```powershell
npm ci
npm run dev
```

该命令启动完整桌面应用，前端支持 Vite HMR；修改主进程、preload 或 PTY Host 后重启命令。`npm run dev:web` 只预览界面。

## 验证与构建

```powershell
npm run check
npm test
npm run build
npm run test:windows
npm run bench:windows
npm run dist:win
node scripts\test-windows.mjs --packaged
npm run test:installers
```

EXE/MSI 在 `release` 目录，免安装测试目录在 `release\win-unpacked`。Windows 测试和基准使用隔离数据目录，结果写入 artifacts；指标定义和验收边界见[验证记录](docs/electron-verification.md)。版本标签触发 CI 检查、安装包构建和 Release 草稿。

安装器测试会在临时目录实际安装、升级和卸载；为保护已有安装，仅在本机没有 ShellGrid 产品和快捷方式时运行。

更多模块职责和修改约定见 [AGENTS.md](AGENTS.md)。
