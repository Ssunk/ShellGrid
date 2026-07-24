<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { onMount, setContext } from "svelte";
  import { Columns2, Info, Rows2, Save, ShieldAlert, SquareTerminal, X } from "lucide-svelte";
  import LayoutNode from "./components/LayoutNode.svelte";
  import { APP_CONTEXT, type AppController } from "./lib/appContext";
  import { closePane, makePaneLaunch, MAX_PANES, paneIds, splitPane, updateRatio } from "./lib/layout";
  import { TerminalClient } from "./lib/terminalClient";
  import { disposeTerminal, fitTerminal, getTerminal, terminalSize } from "./lib/terminalRegistry";
  import type { Bootstrap, EnvironmentStatus, SessionState, WorkspaceStateV1 } from "./lib/types";

  const defaultPaneId = "local-pane";
  const fallbackWorkspace: WorkspaceStateV1 = {
    schemaVersion: 1,
    layout: { type: "pane", paneId: defaultPaneId },
    panes: { [defaultPaneId]: makePaneLaunch("C:\\") },
  };
  let workspace = fallbackWorkspace;
  let environment: EnvironmentStatus = {
    windowsSupported: true,
    webview2Available: true,
    pwshAvailable: true,
    pwshPath: "pwsh.exe",
    message: null,
  };
  let terminalClient: TerminalClient | undefined;
  let ready = false;
  let activePaneId = defaultPaneId;
  let sessions: Record<string, SessionState> = {};
  let errorMessage = "";
  let saveState: "saved" | "saving" | "dirty" = "saved";
  let showInfo = false;
  let nextPaneNumber = 2;
  let saveTimer = 0;
  let reconnectTimer = 0;
  let unlistenClose: (() => void) | undefined;

  const controller: AppController = {
    getLaunch: (paneId) => workspace.panes[paneId] ?? makePaneLaunch("C:\\"),
    getSession: (paneId) => sessions[paneId],
    getActivePane: () => activePaneId,
    setActivePane: (paneId) => {
      activePaneId = paneId;
      terminalClient?.focus(paneId);
    },
    split: (paneId, direction) => split(paneId, direction),
    close: (paneId) => close(paneId),
    updateRatio: (path, ratio) => {
      workspace = { ...workspace, layout: updateRatio(workspace.layout, path, ratio) };
      markDirty();
    },
    mountTerminal: (paneId, host) => {
      const entry = getTerminal(paneId, {
        onCwd: (id, cwd) => {
          const current = workspace.panes[id];
          if (current && current.cwd !== cwd) {
            workspace = { ...workspace, panes: { ...workspace.panes, [id]: { ...current, cwd } } };
            markDirty();
          }
        },
        onTitle: (id, title) => {
          const current = workspace.panes[id];
          if (current && !current.title && title) workspace = { ...workspace, panes: { ...workspace.panes, [id]: { ...current, title } } };
        },
        onInput: (id, data) => terminalClient?.input(id, data),
        onFocus: (id) => controller.setActivePane(id),
        onResize: (id, cols, rows) => terminalClient?.resize(id, cols, rows),
      });
      entry.attach(host);
      void terminalClient?.create(paneId, controller.getLaunch(paneId), entry.terminal.cols, entry.terminal.rows);
    },
    resizeTerminal: (paneId) => {
      fitTerminal(paneId);
    },
  };
  setContext(APP_CONTEXT, controller);

  onMount(() => {
    void initialize();
    return () => {
      unlistenClose?.();
      window.clearTimeout(reconnectTimer);
    };
  });

  async function initialize(): Promise<void> {
    try {
      const boot = await invoke<Bootstrap>("get_bootstrap");
      workspace = boot.workspace;
      environment = boot.environment;
      activePaneId = paneIds(workspace.layout)[0];
      terminalClient = new TerminalClient(boot.wsUrl, boot.token, {
        onCreated: (paneId, sessionId) => {
          sessions = { ...sessions, [paneId]: { paneId, sessionId, running: true } };
          if (paneId === activePaneId) terminalClient?.focus(paneId);
        },
        onExit: (paneId, exitCode) => {
          sessions = { ...sessions, [paneId]: { paneId, running: false, exitCode } };
        },
        onError: (paneId, message) => {
          errorMessage = message;
          if (paneId) sessions = { ...sessions, [paneId]: { paneId, running: false, error: message } };
        },
        onDisconnected: () => {
          errorMessage = "终端服务连接已断开，正在重连...";
          sessions = Object.fromEntries(
            Object.entries(sessions).map(([paneId, session]) => [paneId, { ...session, running: false }]),
          );
          scheduleReconnect();
        },
      });
      await terminalClient.connect();
    } catch {
      // Browser preview and a missing WebView command both retain a usable shell workspace.
      terminalClient = undefined;
    }
    ready = true;
    if (!("__TAURI_INTERNALS__" in window)) return;
    const appWindow = getCurrentWindow();
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (Object.values(sessions).some((session) => session.running) && !window.confirm("仍有终端正在运行，确定退出并终止它们吗？")) return;
      await persist();
      const stopListening = unlistenClose;
      unlistenClose = undefined;
      stopListening?.();
      await appWindow.close();
    });
  }

  function scheduleReconnect(): void {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => void reconnect(), 1000);
  }

  async function reconnect(): Promise<void> {
    if (!terminalClient) return;
    try {
      await terminalClient.connect();
    } catch {
      scheduleReconnect();
      return;
    }
    errorMessage = "";
    for (const paneId of paneIds(workspace.layout)) {
      const size = terminalSize(paneId);
      void terminalClient.create(paneId, controller.getLaunch(paneId), size?.cols ?? 80, size?.rows ?? 24);
    }
  }

  function split(paneId: string, direction: "horizontal" | "vertical"): void {
    const ids = paneIds(workspace.layout);
    if (ids.length >= MAX_PANES) {
      errorMessage = `最多支持 ${MAX_PANES} 个窗格`;
      return;
    }
    const newId = `pane-${Date.now()}-${nextPaneNumber++}`;
    workspace = {
      ...workspace,
      layout: splitPane(workspace.layout, paneId, newId, direction),
      panes: { ...workspace.panes, [newId]: { ...workspace.panes[paneId], title: undefined } },
    };
    activePaneId = newId;
    markDirty();
  }

  function close(paneId: string): void {
    // 先确认布局允许关闭（最后一个窗格不可关），再销毁会话与终端实例。
    const nextLayout = closePane(workspace.layout, paneId);
    if (!nextLayout) {
      errorMessage = "至少需要保留一个窗格";
      return;
    }
    const session = sessions[paneId];
    if (session?.running && !window.confirm("关闭此窗格会终止其中的进程，确定继续吗？")) return;
    terminalClient?.closePane(paneId);
    disposeTerminal(paneId);
    const { [paneId]: _, ...remainingPanes } = workspace.panes;
    workspace = { ...workspace, layout: nextLayout, panes: remainingPanes };
    const { [paneId]: _closedSession, ...remainingSessions } = sessions;
    sessions = remainingSessions;
    activePaneId = paneIds(nextLayout)[0];
    markDirty();
  }

  function markDirty(): void {
    saveState = "dirty";
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void persist(), 700);
  }

  async function persist(): Promise<void> {
    saveState = "saving";
    try {
      await invoke("save_workspace", { workspace });
      saveState = "saved";
    } catch {
      saveState = "dirty";
      errorMessage = "工作区保存失败";
    }
  }

  function createFromToolbar(direction: "horizontal" | "vertical"): void {
    split(activePaneId, direction);
  }

  function handleShortcut(event: KeyboardEvent): void {
    // 使用 Ctrl+Shift 组合；Ctrl+Alt 在部分键盘布局上等价于 AltGr，会拦截正常字符输入。
    if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "h") createFromToolbar("horizontal");
    else if (key === "v") createFromToolbar("vertical");
    else if (key === "w") close(activePaneId);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
</script>

<svelte:head>
  <title>ShellGrid</title>
</svelte:head>

<svelte:window on:keydown={handleShortcut} />

<div class="app-shell">
  <header class="topbar">
    <div class="brand"><SquareTerminal size={18} /><span>ShellGrid</span><small>工作区</small></div>
    <div class="toolbar-group">
      <button class="toolbar-button" title="左右分割 (Ctrl+Shift+H)" on:click={() => createFromToolbar("horizontal")}><Columns2 size={16} />左右分割</button>
      <button class="toolbar-button" title="上下分割 (Ctrl+Shift+V)" on:click={() => createFromToolbar("vertical")}><Rows2 size={16} />上下分割</button>
      <button class="toolbar-button" title="保存工作区" on:click={() => void persist()}><Save size={16} />保存</button>
    </div>
    <div class="toolbar-spacer"></div>
    <span class="pane-count">{paneIds(workspace.layout).length} / {MAX_PANES} 窗格</span>
    <span class:dirty={saveState !== "saved"} class="save-indicator">{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中" : "待保存"}</span>
    <button class="icon-button toolbar-info" title="运行环境" on:click={() => (showInfo = !showInfo)}><Info size={17} /></button>
  </header>

  {#if environment.message || errorMessage}
    <div class="notice" class:error-notice={Boolean(errorMessage)}>
      <ShieldAlert size={16} />
      <span>{errorMessage || environment.message}</span>
      <button class="icon-button" title="关闭提示" on:click={() => (errorMessage = "")}><X size={15} /></button>
    </div>
  {/if}

  {#if showInfo}
    <aside class="environment-popover">
      <div class="popover-title">运行环境</div>
      <div class="environment-row"><span>Windows</span><b class:ok={environment.windowsSupported}>{environment.windowsSupported ? "可用" : "不支持"}</b></div>
      <div class="environment-row"><span>WebView2</span><b class:ok={environment.webview2Available}>{environment.webview2Available ? "可用" : "缺失"}</b></div>
      <div class="environment-row"><span>PowerShell 7</span><b class:ok={environment.pwshAvailable}>{environment.pwshAvailable ? "可用" : "缺失"}</b></div>
      {#if environment.pwshPath}<code>{environment.pwshPath}</code>{/if}
    </aside>
  {/if}

  <main class="workspace" aria-label="终端工作区">
    {#if ready}
      <LayoutNode node={workspace.layout} {activePaneId} panes={workspace.panes} {sessions} />
    {:else}
      <div class="startup-state">
        <SquareTerminal size={22} />
        <span>正在启动终端...</span>
      </div>
    {/if}
  </main>
</div>
