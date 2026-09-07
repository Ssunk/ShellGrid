import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { WorkspaceStore } from "./services/workspace";
import { environment } from "./services/environment";
import { GitService } from "./services/git";
import { CloseCoordinator } from "./close-coordinator";
import { TerminalService } from "./terminal-service";
import { directoryPath, externalUrl, gitDiffRequest, gitMutation, trustedUrl } from "./security";
import { parseWorkspace } from "../shared/workspace";
import { textValue, uuid } from "../shared/protocol";
import type { Bootstrap, WorkspaceStateV1 } from "../src/lib/types";

// A separate Chromium profile keeps the existing workspace independent of
// Electron cache management and installer upgrade behavior.
const dataDirectory = join(process.env.LOCALAPPDATA ?? homedir(), "ShellGrid");
app.setPath("userData", join(dataDirectory, "electron"));
app.setAppUserModelId("io.shellgrid.desktop");
const developmentUrl = !app.isPackaged && process.env.SHELLGRID_DEV_URL === "http://127.0.0.1:1420/"
  ? process.env.SHELLGRID_DEV_URL : undefined;
const entryUrl = developmentUrl ?? pathToFileURL(resolve(__dirname, "../dist/index.html")).href;
let window: BrowserWindow | undefined;
let terminals: TerminalService | undefined;
let closeCoordinator: CloseCoordinator | undefined;
let quitting = false;

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!window || window.isDestroyed() || event.sender.isDestroyed()) return false;
  try {
    return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && trustedUrl(event.senderFrame.url, entryUrl);
  } catch { return false; }
}
function handle(channel: string, operation: (value: unknown, event: IpcMainInvokeEvent) => unknown): void {
  ipcMain.handle(channel, async (event, value: unknown) => {
    // Return errors as data: Electron's default rejected-IPC logging must not log
    // Git messages, launch parameters, clipboard contents or possible credentials.
    try {
      if (!trusted(event)) throw new Error("调用来源无效");
      return { ok: true, value: await operation(value, event) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "桌面操作失败" };
    }
  });
}
async function confirm(message: string): Promise<boolean> {
  if (!window || window.isDestroyed()) return false;
  const result = await dialog.showMessageBox(window, {
    type: "question", title: "ShellGrid", message, buttons: ["取消", "确定"], defaultId: 0, cancelId: 0, noLink: true,
  });
  return result.response === 1;
}
async function start(): Promise<void> {
  const status = await environment();
  const id = randomUUID();
  const initialDirectory = app.isPackaged ? homedir() : process.cwd();
  const fallback: WorkspaceStateV1 = {
    schemaVersion: 1, rootPath: initialDirectory, layout: { type: "pane", paneId: id },
    panes: { [id]: { cwd: initialDirectory, shell: status.pwshPath ?? "pwsh.exe", args: ["-NoLogo"] } },
  };
  const store = new WorkspaceStore(join(dataDirectory, "workspace.json"));
  let latestWorkspace = await store.load(fallback);
  status.message ??= store.warning;
  const bootstrap: Bootstrap = { workspace: latestWorkspace, appVersion: app.getVersion(), environment: status };
  const git = new GitService(status.gitPath);
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: "ShellGrid", width: 1280, height: 800, minWidth: 720, minHeight: 480,
    backgroundColor: "#111417", show: false,
    icon: app.isPackaged ? join(process.resourcesPath, "icon.ico") : join(__dirname, "../build/icon.ico"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    },
  });
  const currentWindow = window;
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  currentWindow.webContents.on("will-navigate", (event, url) => { if (!trustedUrl(url, entryUrl)) event.preventDefault(); });
  currentWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  currentWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  currentWindow.webContents.session.setPermissionCheckHandler(() => false);
  currentWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [
      "default-src 'self'; script-src 'self'; connect-src 'self' " + (developmentUrl ? "ws://127.0.0.1:1420 " : "") +
      "https://api.github.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'",
    ] },
  }));
  const hostPath = app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "dist-electron", "pty-host.cjs")
    : join(__dirname, "pty-host.cjs");
  terminals = new TerminalService(hostPath, status.windowsBuild, (generation) => {
    if (!currentWindow.isDestroyed()) currentWindow.webContents.send("terminal:disconnected", generation);
  });
  let workspaceReady = false;
  const snapshots = new Map<string, { resolve: (workspace: WorkspaceStateV1) => void; reject: () => void }>();
  ipcMain.on("workspace:ready", (event) => { if (trusted(event)) workspaceReady = true; });
  ipcMain.on("workspace:snapshot", (event, value: { requestId?: unknown; workspace?: unknown }) => {
    if (!trusted(event) || !value || !uuid(value.requestId)) return;
    const pending = snapshots.get(value.requestId);
    if (!pending) return;
    snapshots.delete(value.requestId);
    try { pending.resolve(parseWorkspace(value.workspace)); } catch { pending.reject(); }
  });
  function snapshot(): Promise<WorkspaceStateV1> {
    if (!workspaceReady) return Promise.resolve(latestWorkspace);
    return new Promise((resolveSnapshot, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => { snapshots.delete(requestId); reject(new Error("无法读取最新工作区")); }, 5000);
      snapshots.set(requestId, {
        resolve: (workspace) => { clearTimeout(timeout); resolveSnapshot(workspace); },
        reject: () => { clearTimeout(timeout); reject(new Error("工作区无效")); },
      });
      currentWindow.webContents.send("workspace:request", requestId);
    });
  }
  const save = async (value: unknown) => {
    const workspace = parseWorkspace(value);
    await store.save(workspace);
    latestWorkspace = workspace;
  };
  handle("bootstrap", () => ({ ...bootstrap, workspace: latestWorkspace }));
  handle("workspace:save", save);
  handle("external:open", (value) => shell.openExternal(externalUrl(value)));
  handle("dialog:confirm", (value) => {
    if (!textValue(value, 8192)) throw new Error("确认消息无效");
    return confirm(value);
  });
  handle("directory:choose", async (value) => {
    const result = await dialog.showOpenDialog(currentWindow, {
      title: "打开工作区文件夹", defaultPath: directoryPath(value), properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle("git:status", (value) => git.status(directoryPath(value)));
  handle("git:diff", (value) => { const request = gitDiffRequest(value); return git.diff(request.path, request.filePath, request.staged); });
  handle("git:headMessage", (value) => git.headMessage(directoryPath(value)));
  handle("git:mutate", (value) => git.mutate(gitMutation(value)));
  handle("terminal:connect", (value, event) => {
    if (!uuid(value) || !event.senderFrame) throw new Error("终端连接参数无效");
    return terminals!.connect(event.senderFrame, value);
  });
  ipcMain.on("terminal:disconnect", (event) => { if (trusted(event)) void terminals?.stop(); });
  closeCoordinator = new CloseCoordinator({
    hasSessions: () => terminals?.hasSessions ?? false, confirm, snapshot, save,
    stop: async () => { await Promise.all([terminals!.stop(), git.shutdown()]); },
    finish: () => { quitting = true; currentWindow.close(); app.quit(); },
  });
  currentWindow.on("close", (event) => {
    if (closeCoordinator?.allowClose) return;
    event.preventDefault();
    void closeCoordinator?.request();
  });
  currentWindow.webContents.on("render-process-gone", () => {
    workspaceReady = false;
    void Promise.all([terminals?.stop(), git.cancelActive()]);
  });
  currentWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
      workspaceReady = false;
      void Promise.all([terminals?.stop(), git.cancelActive()]);
    }
  });
  currentWindow.webContents.on("before-input-event", (event, input) => {
    if (!input.control || input.alt || input.meta || input.type !== "keyDown") return;
    if (!["+", "=", "-", "0"].includes(input.key)) return;
    event.preventDefault();
    const level = currentWindow.webContents.getZoomLevel();
    currentWindow.webContents.setZoomLevel(input.key === "0" ? 0 : Math.max(-3, Math.min(3, level + (input.key === "-" ? -0.5 : 0.5))));
  });
  currentWindow.once("ready-to-show", () => currentWindow.show());
  await currentWindow.loadURL(entryUrl);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on("before-quit", (event) => {
    if (quitting || !closeCoordinator) return;
    event.preventDefault();
    void closeCoordinator.request();
  });
  app.on("window-all-closed", () => { quitting = true; void terminals?.stop().finally(() => app.quit()); });
  void app.whenReady().then(start).catch(() => {
    // Show a fixed diagnostic, never a rejected launch command or environment.
    dialog.showErrorBox("ShellGrid", "桌面初始化失败，请检查安装文件和数据目录权限");
    quitting = true;
    void terminals?.stop().finally(() => app.quit());
    if (!terminals) app.quit();
  });
}
