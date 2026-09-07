import { contextBridge, ipcRenderer } from "electron";
import type { ShellGridAPI } from "../shared/desktop";
import { validCommand, validEvent, type ConnectionInfo, type TerminalEvent } from "../shared/protocol";
import type { WorkspaceStateV1 } from "../src/lib/types";

async function invoke<T>(channel: string, value?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, value) as { ok: true; value: T } | { ok: false; error: string };
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const listeners = new Set<(event: TerminalEvent) => void>();
const disconnectedListeners = new Set<() => void>();
let port: MessagePort | undefined;
let connection: Promise<ConnectionInfo> | undefined;
let generation = 0;
let requestId: string | undefined;
let resolveConnection: ((info: ConnectionInfo) => void) | undefined;
let rejectConnection: ((error: Error) => void) | undefined;
function disconnect(notify = true): void {
  port?.close(); port = undefined; connection = undefined;
  requestId = undefined;
  rejectConnection?.(new Error("终端服务连接已断开"));
  resolveConnection = undefined; rejectConnection = undefined;
  if (notify) for (const listener of disconnectedListeners) listener();
}
ipcRenderer.on("terminal:port", (event, message: { requestId: string; info: ConnectionInfo }) => {
  const transferred = event.ports[0];
  if (!transferred || message.requestId !== requestId || !resolveConnection) { transferred?.close(); return; }
  port?.close();
  port = transferred;
  generation = message.info.generation;
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (!validEvent(data) || data.generation !== generation) return;
    for (const listener of listeners) listener(data);
  };
  port.onmessageerror = () => disconnect();
  port.start();
  resolveConnection(message.info);
  resolveConnection = undefined; rejectConnection = undefined;
});
ipcRenderer.on("terminal:disconnected", (_event, endedGeneration: number) => {
  if (endedGeneration === generation && port) disconnect();
});
let workspaceProvider: (() => WorkspaceStateV1) | undefined;
ipcRenderer.on("workspace:request", (_event, id: string) => {
  try { ipcRenderer.send("workspace:snapshot", { requestId: id, workspace: workspaceProvider?.() }); }
  catch { ipcRenderer.send("workspace:snapshot", { requestId: id }); }
});
const api: ShellGridAPI = {
  getBootstrap: () => invoke("bootstrap"),
  saveWorkspace: (workspace) => invoke("workspace:save", workspace),
  chooseDirectory: (defaultPath) => invoke("directory:choose", defaultPath),
  confirm: (message) => invoke("dialog:confirm", message),
  openExternal: (url) => invoke("external:open", url),
  onWorkspaceRequest(provider) {
    workspaceProvider = provider;
    ipcRenderer.send("workspace:ready");
    return () => { if (workspaceProvider === provider) workspaceProvider = undefined; };
  },
  git: {
    status: (path) => invoke("git:status", path),
    diff: (request) => invoke("git:diff", request),
    headMessage: (path) => invoke("git:headMessage", path),
    mutate: (request) => invoke("git:mutate", request),
  },
  terminal: {
    connect() {
      if (connection) return connection;
      const id = crypto.randomUUID();
      requestId = id;
      connection = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
      void invoke("terminal:connect", id).catch(() => { if (requestId === id) disconnect(); });
      return connection;
    },
    send(command) { if (validCommand(command) && command.generation === generation) port?.postMessage(command); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onDisconnected(listener) { disconnectedListeners.add(listener); return () => disconnectedListeners.delete(listener); },
    disconnect() {
      disconnect(false);
      ipcRenderer.send("terminal:disconnect");
    },
  },
};
contextBridge.exposeInMainWorld("shellgrid", api);
