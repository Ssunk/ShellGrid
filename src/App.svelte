<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getVersion } from "@tauri-apps/api/app";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount, setContext } from "svelte";
  import { ChevronDown, ChevronUp, Columns2, Download, FolderOpen, GitBranch, Globe, Info, Rows2, Save, Search, ShieldAlert, SquareTerminal, X } from "lucide-svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import LayoutNode from "./components/LayoutNode.svelte";
  import { APP_CONTEXT, type AppController } from "./lib/appContext";
  import { closePane, makePaneLaunch, MAX_PANES, paneIds, splitPane, updateRatio } from "./lib/layout";
  import { isValidProxyUrl, normalizeProxyUrl, sessionProxy } from "./lib/proxy";
  import { TerminalClient } from "./lib/terminalClient";
  import { clearTerminal, disposeTerminal, fitTerminal, focusTerminal, getTerminal, pasteTerminal, resetTerminal, searchInTerminal, terminalSize } from "./lib/terminalRegistry";
  import { checkForUpdate, type UpdateInfo } from "./lib/update";
  import type { Bootstrap, EnvironmentStatus, ProxyConfig, SessionState, WorkspaceStateV1 } from "./lib/types";

  const defaultPaneId = "local-pane";
  const fallbackWorkspace: WorkspaceStateV1 = {
    schemaVersion: 1,
    rootPath: "C:\\",
    layout: { type: "pane", paneId: defaultPaneId },
    panes: { [defaultPaneId]: makePaneLaunch("C:\\") },
  };
  let workspace = fallbackWorkspace;
  let environment: EnvironmentStatus = {
    windowsSupported: true,
    webview2Available: true,
    pwshAvailable: true,
    pwshPath: "pwsh.exe",
    gitAvailable: true,
    gitPath: "git.exe",
    message: null,
  };
  let terminalClient: TerminalClient | undefined;
  let ready = false;
  let activePaneId = defaultPaneId;
  let sessions: Record<string, SessionState> = {};
  let errorMessage = "";
  let saveState: "saved" | "saving" | "dirty" = "saved";
  let showInfo = false;
  let showProxy = false;
  let showGit = false;
  let proxyDraft: ProxyConfig = { enabled: false, url: "", noProxy: "" };
  let appVersion = "";
  let updateInfo: UpdateInfo | null = null;
  let updateStatus: "idle" | "checking" | "latest" | "found" | "error" = "idle";
  let showUpdateNotice = false;
  const DISMISSED_UPDATE_KEY = "shellgrid-dismissed-update";
  const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;
  let nextPaneNumber = 2;
  let saveTimer = 0;
  let reconnectTimer = 0;
  let unlistenClose: (() => void) | undefined;
  let currentRoot = "C:\\";
  let workspaceEpoch = 0;
  let searchOpen = false;
  let searchPaneId = "";
  let searchQuery = "";
  let searchIndex = 0;
  let searchTotal = 0;
  let searchInput: HTMLInputElement | undefined;

  $: currentRoot = workspaceRoot(workspace);

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
    restart: (paneId) => restartPane(paneId),
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
        onPasteImages: (id, images) => void pasteImages(id, images),
        onFocus: (id) => controller.setActivePane(id),
        onResize: (id, cols, rows) => terminalClient?.resize(id, cols, rows),
        onSearchResults: (id, current, total) => {
          if (id !== searchPaneId) return;
          searchIndex = current;
          searchTotal = total;
        },
      });
      entry.attach(host);
      if (paneId === activePaneId) entry.setFocused(true);
      void terminalClient?.create(paneId, controller.getLaunch(paneId), entry.terminal.cols, entry.terminal.rows, sessionProxy(workspace.proxy));
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
      workspace = { ...boot.workspace, rootPath: workspaceRoot(boot.workspace) };
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
      // 连接失败时保留 terminalClient：onDisconnected 驱动的重连逻辑会持续重试。
      // 只有拿不到 bootstrap（如浏览器预览）才视为没有终端服务，置空客户端。
      await terminalClient.connect().catch(() => {});
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
      const saved = await persist();
      if (!saved && !window.confirm("工作区保存失败，仍要退出吗？")) return;
      const stopListening = unlistenClose;
      unlistenClose = undefined;
      stopListening?.();
      await appWindow.close();
    });
    appVersion = await getVersion().catch(() => "");
    void runUpdateCheck(true);
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
      void terminalClient.create(paneId, controller.getLaunch(paneId), size?.cols ?? 80, size?.rows ?? 24, sessionProxy(workspace.proxy));
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
    controller.setActivePane(newId);
    focusTerminal(newId);
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
    const nextActiveId = paneIds(nextLayout)[0];
    controller.setActivePane(nextActiveId);
    focusTerminal(nextActiveId);
    if (searchPaneId === paneId) closeSearch();
    markDirty();
  }

  // 会话退出或启动失败后，在同一窗格内用原启动信息重启会话并重置终端状态。
  function restartPane(paneId: string): void {
    const size = terminalSize(paneId);
    sessions = { ...sessions, [paneId]: { paneId, running: false } };
    resetTerminal(paneId);
    void terminalClient?.create(
      paneId,
      controller.getLaunch(paneId),
      size?.cols ?? 80,
      size?.rows ?? 24,
      sessionProxy(workspace.proxy),
    );
  }

  function markDirty(): void {
    saveState = "dirty";
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void persist(), 700);
  }

  async function pasteImages(paneId: string, images: File[]): Promise<void> {
    try {
      const paths: string[] = [];
      for (const image of images) {
        if (image.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("剪贴板图片超过 20 MiB 限制");
        const bytes = new Uint8Array(await image.arrayBuffer());
        paths.push(await invoke<string>("save_clipboard_image", { data: bytesToBase64(bytes) }));
      }
      if (paths.length === 0) return;
      const references = paths.map((path) => `[图片文件: "${path}"]`).join(" ");
      pasteTerminal(paneId, ` ${references} `);
    } catch (reason) {
      errorMessage = typeof reason === "string"
        ? reason
        : reason instanceof Error ? reason.message : "无法保存剪贴板图片";
    }
  }

  // 分块拼接避免 String.fromCharCode 在超大数组上爆栈；base64 比 JSON 数字数组的 IPC 载荷小一个数量级。
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    return btoa(binary);
  }

  async function persist(): Promise<boolean> {
    saveState = "saving";
    try {
      await invoke("save_workspace", { workspace });
      saveState = "saved";
      return true;
    } catch {
      saveState = "dirty";
      errorMessage = "工作区保存失败";
      return false;
    }
  }

  function createFromToolbar(direction: "horizontal" | "vertical"): void {
    split(activePaneId, direction);
  }

  function workspaceRoot(state: WorkspaceStateV1): string {
    const first = paneIds(state.layout)[0];
    return state.rootPath || state.panes[first]?.cwd || "C:\\";
  }

  function workspaceName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).pop() || path;
  }

  async function chooseWorkspaceFolder(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: currentRoot,
        title: "打开工作区文件夹",
      });
      if (typeof selected !== "string" || selected === currentRoot) return;
      if (
        Object.values(sessions).some((session) => session.running) &&
        !window.confirm("打开新文件夹会终止当前所有终端并重置为单窗格，确定继续吗？")
      ) return;

      for (const paneId of paneIds(workspace.layout)) {
        terminalClient?.closePane(paneId);
        disposeTerminal(paneId);
      }
      const paneId = `pane-${crypto.randomUUID()}`;
      workspace = {
        schemaVersion: 1,
        rootPath: selected,
        layout: { type: "pane", paneId },
        panes: { [paneId]: makePaneLaunch(selected, environment.pwshPath || "pwsh.exe") },
        proxy: workspace.proxy,
      };
      sessions = {};
      activePaneId = paneId;
      workspaceEpoch += 1;
      errorMessage = "";
      showGit = true;
      closeSearch();
      await persist();
    } catch (reason) {
      errorMessage = typeof reason === "string" ? reason : "无法打开工作区文件夹";
    }
  }

  function toggleInfo(): void {
    showInfo = !showInfo;
    if (showInfo) showProxy = false;
  }

  function toggleProxy(): void {
    showProxy = !showProxy;
    if (showProxy) {
      showInfo = false;
      proxyDraft = { enabled: false, url: "", noProxy: "", ...workspace.proxy };
    }
  }

  // 只把合法（或已停用）的草稿写入工作区：启用状态下的非法地址若被持久化，
  // Rust 端 validate 会拒绝保存，连布局改动也会一起写不进磁盘。
  function applyProxyDraft(): void {
    proxyDraft = { ...proxyDraft, url: normalizeProxyUrl(proxyDraft.url) };
    if (proxyDraft.enabled && !isValidProxyUrl(proxyDraft.url)) return;
    const blank = !proxyDraft.enabled && proxyDraft.url === "" && !(proxyDraft.noProxy ?? "").trim();
    workspace = { ...workspace, proxy: blank ? undefined : { ...proxyDraft } };
    markDirty();
  }

  // startup 为 true 时静默检查：失败不打扰，被用户忽略过的版本不再弹出提示条。
  async function runUpdateCheck(startup = false): Promise<void> {
    if (!appVersion || updateStatus === "checking") return;
    updateStatus = "checking";
    try {
      updateInfo = await checkForUpdate(appVersion);
      updateStatus = updateInfo ? "found" : "latest";
      if (updateInfo) {
        showUpdateNotice = !startup || localStorage.getItem(DISMISSED_UPDATE_KEY) !== updateInfo.version;
      }
    } catch {
      updateStatus = "error";
    }
  }

  function dismissUpdate(): void {
    if (updateInfo) localStorage.setItem(DISMISSED_UPDATE_KEY, updateInfo.version);
    showUpdateNotice = false;
  }

  function openReleasePage(): void {
    if (updateInfo) void invoke("open_external", { url: updateInfo.url });
  }

  function toggleSearch(): void {
    if (searchOpen) {
      closeSearch();
      return;
    }
    searchOpen = true;
    searchPaneId = activePaneId;
    searchQuery = "";
    searchIndex = 0;
    searchTotal = 0;
    window.setTimeout(() => searchInput?.focus(), 0);
  }

  function closeSearch(): void {
    searchInTerminal(searchPaneId, "", "next");
    searchOpen = false;
    searchPaneId = "";
  }

  function runSearch(direction: "next" | "previous"): void {
    if (!searchQuery) return;
    searchInTerminal(searchPaneId, searchQuery, direction);
  }

  function handleSearchKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(event.shiftKey ? "previous" : "next");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  }

  function handleShortcut(event: KeyboardEvent): void {
    // 使用 Ctrl+Shift 组合；Ctrl+Alt 在部分键盘布局上等价于 AltGr，会拦截正常字符输入。
    if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
    // Git 面板等输入控件中不触发快捷键；xterm 自身的隐藏 textarea 属于终端表面，
    // 必须放行，否则终端聚焦时 Ctrl+Shift+W/H/V/F 会全部失效。
    const target = event.target as HTMLElement | null;
    if (
      target &&
      !target.closest(".terminal-surface") &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
    ) return;
    const key = event.key.toLowerCase();
    if (key === "h") createFromToolbar("horizontal");
    else if (key === "v") createFromToolbar("vertical");
    else if (key === "w") close(activePaneId);
    else if (key === "f") toggleSearch();
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
    <div class="brand"><SquareTerminal size={18} /><span>ShellGrid</span><small title={currentRoot}>{workspaceName(currentRoot)}</small></div>
    <div class="toolbar-group">
      <button class="toolbar-button" title="打开文件夹作为工作区" on:click={() => void chooseWorkspaceFolder()}><FolderOpen size={16} />打开文件夹</button>
      <button class:active={showGit} class="toolbar-button" title="切换 Git 源码管理" on:click={() => (showGit = !showGit)}><GitBranch size={16} />源码管理</button>
      <button class="toolbar-button" title="左右分割 (Ctrl+Shift+H)" on:click={() => createFromToolbar("horizontal")}><Columns2 size={16} />左右分割</button>
      <button class="toolbar-button" title="上下分割 (Ctrl+Shift+V)" on:click={() => createFromToolbar("vertical")}><Rows2 size={16} />上下分割</button>
      <button class="toolbar-button" title="保存工作区" on:click={() => void persist()}><Save size={16} />保存</button>
    </div>
    <div class="toolbar-spacer"></div>
    <span class="pane-count">{paneIds(workspace.layout).length} / {MAX_PANES} 窗格</span>
    <span class:dirty={saveState !== "saved"} class="save-indicator">{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中" : "待保存"}</span>
    <button class="icon-button toolbar-search" title="搜索终端输出 (Ctrl+Shift+F)" on:click={toggleSearch}><Search size={17} /></button>
    <button class="icon-button toolbar-proxy" class:proxy-on={Boolean(workspace.proxy?.enabled)} title={workspace.proxy?.enabled ? "网络代理（已启用）" : "网络代理"} on:click={toggleProxy}><Globe size={17} /></button>
    <button class="icon-button toolbar-info" title="运行环境" on:click={toggleInfo}><Info size={17} /></button>
  </header>

  {#if environment.message || errorMessage}
    <div class="notice" class:error-notice={Boolean(errorMessage)}>
      <ShieldAlert size={16} />
      <span>{errorMessage || environment.message}</span>
      <button class="icon-button" title="关闭提示" on:click={() => (errorMessage = "")}><X size={15} /></button>
    </div>
  {/if}

  {#if showUpdateNotice && updateInfo}
    <div class="notice update-notice">
      <Download size={16} />
      <span>发现新版本 {updateInfo.version}（当前 v{appVersion}），请从发布页下载安装包更新。</span>
      <button class="notice-action" on:click={openReleasePage}>查看发布页</button>
      <button class="icon-button" title="忽略此版本" on:click={dismissUpdate}><X size={15} /></button>
    </div>
  {/if}

  {#if searchOpen}
    <div class="search-overlay">
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        aria-label="搜索终端输出"
        placeholder="搜索终端输出（Enter 下一个，Shift+Enter 上一个）"
        spellcheck="false"
        on:input={() => runSearch("next")}
        on:keydown={handleSearchKey}
      />
      <span class="search-count" class:zero={searchTotal === 0}>{searchTotal > 0 ? `${searchIndex + 1} / ${searchTotal}` : "无匹配"}</span>
      <button class="icon-button" title="上一个（Shift+Enter）" on:click={() => runSearch("previous")}><ChevronUp size={15} /></button>
      <button class="icon-button" title="下一个（Enter）" on:click={() => runSearch("next")}><ChevronDown size={15} /></button>
      <button class="icon-button" title="关闭（Esc）" on:click={closeSearch}><X size={15} /></button>
    </div>
  {/if}

  {#if showInfo}
    <aside class="environment-popover">
      <div class="popover-title">运行环境</div>
      <div class="environment-row"><span>Windows</span><b class:ok={environment.windowsSupported}>{environment.windowsSupported ? "可用" : "不支持"}</b></div>
      <div class="environment-row"><span>WebView2</span><b class:ok={environment.webview2Available}>{environment.webview2Available ? "可用" : "缺失"}</b></div>
      <div class="environment-row"><span>PowerShell 7</span><b class:ok={environment.pwshAvailable}>{environment.pwshAvailable ? "可用" : "缺失"}</b></div>
      {#if environment.pwshPath}<code>{environment.pwshPath}</code>{/if}
      <div class="environment-row"><span>Git</span><b class:ok={environment.gitAvailable}>{environment.gitAvailable ? "可用" : "缺失"}</b></div>
      {#if environment.gitPath}<code>{environment.gitPath}</code>{/if}
      <div class="environment-row"><span>当前版本</span><b class="muted">{appVersion ? `v${appVersion}` : "未知"}</b></div>
      <div class="environment-row">
        <span>更新</span>
        <b class:ok={updateStatus === "latest" || updateStatus === "found"} class:muted={updateStatus === "idle" || updateStatus === "checking"}>
          {updateStatus === "found" ? `可更新到 ${updateInfo?.version}` : updateStatus === "latest" ? "已是最新" : updateStatus === "checking" ? "检查中..." : updateStatus === "error" ? "检查失败" : "未检查"}
        </b>
      </div>
      {#if updateStatus === "found"}
        <button class="toolbar-button popover-action" on:click={openReleasePage}><Download size={14} />查看发布页</button>
      {:else}
        <button class="toolbar-button popover-action" disabled={updateStatus === "checking" || !appVersion} on:click={() => void runUpdateCheck()}>检查更新</button>
      {/if}
    </aside>
  {/if}

  {#if showProxy}
    <aside class="environment-popover proxy-popover">
      <div class="popover-title">网络代理</div>
      <label class="proxy-toggle">
        <input type="checkbox" bind:checked={proxyDraft.enabled} on:change={applyProxyDraft} />
        <span>为新建终端启用代理</span>
      </label>
      <label class="proxy-field">
        <span>代理地址</span>
        <input type="text" placeholder="http://127.0.0.1:7890" spellcheck="false" bind:value={proxyDraft.url} on:change={applyProxyDraft} />
      </label>
      <label class="proxy-field">
        <span>例外列表（NO_PROXY，可选）</span>
        <input type="text" placeholder="localhost,127.0.0.1" spellcheck="false" bind:value={proxyDraft.noProxy} on:change={applyProxyDraft} />
      </label>
      {#if proxyDraft.enabled && !isValidProxyUrl(normalizeProxyUrl(proxyDraft.url))}
        <p class="proxy-error">代理地址无效：需要 http、https 或 socks5 地址，例如 http://127.0.0.1:7890</p>
      {:else}
        <p class="proxy-hint">通过 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 环境变量注入，仅对之后新建的终端会话生效。</p>
      {/if}
    </aside>
  {/if}

  <div class="workbench">
    {#if showGit}<GitPanel path={currentRoot} gitAvailable={environment.gitAvailable} onClose={() => (showGit = false)} />{/if}
    <main class="workspace" aria-label="终端工作区">
      {#if ready}
        {#key workspaceEpoch}
          <LayoutNode node={workspace.layout} {activePaneId} panes={workspace.panes} {sessions} />
        {/key}
      {:else}
        <div class="startup-state">
          <SquareTerminal size={22} />
          <span>正在启动终端...</span>
        </div>
      {/if}
    </main>
  </div>
</div>
