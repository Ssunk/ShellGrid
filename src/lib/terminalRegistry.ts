import { desktop } from "./desktop";
import type { ConnectionInfo } from "../../shared/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

export interface RegisteredTerminal {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  attach(host: HTMLElement, afterFit?: () => void): void;
  setFocused(focused: boolean): void;
}

interface RegistryCallbacks {
  onCwd(paneId: string, cwd: string): void;
  onTitle(paneId: string, title: string): void;
  onInput(paneId: string, data: string): void;
  onBinaryInput(paneId: string, data: string): void;
  onFocus(paneId: string): void;
  onResize(paneId: string, cols: number, rows: number): void;
  onSearchResults(paneId: string, current: number, total: number): void;
}

const terminals = new Map<string, RegisteredTerminal>();
const renderers = new Map<string, { webgl: boolean }>();
const searches = new Map<string, SearchAddon>();
const pendingFits = new Map<string, { entry: RegisteredTerminal; afterFit?: () => void }>();
const observedPanes = new WeakMap<Element, string>();
let resizeObserver: ResizeObserver | undefined;
let fitFrame: number | undefined;
let webglContexts = 0;
const MAX_WEBGL_CONTEXTS = 4;
let windowsPty: ConnectionInfo["windowsPty"] | undefined;

export function configureTerminals(value: ConnectionInfo["windowsPty"]): void {
  windowsPty = value;
  for (const entry of terminals.values()) entry.terminal.options.windowsPty = value;
}

function handleRightClick(event: MouseEvent, terminal: Terminal): void {
  // VS Code's Windows default: copy and clear a selection, otherwise paste.
  // Keep web-only preview behavior intact when the validated desktop API is absent.
  if (!window.shellgrid) return;
  event.preventDefault();
  const api = desktop();
  if (terminal.hasSelection()) {
    const selection = terminal.getSelection();
    void api.writeClipboardText(selection).then(() => terminal.clearSelection()).catch(() => {});
  } else {
    void api.readClipboardText().then((text) => terminal.paste(text)).catch(() => {});
  }
}

const SEARCH_DECORATIONS = {
  matchBackground: "#3b5e4a",
  activeMatchBackground: "#5a8f6d",
  activeMatchColorOverviewRuler: "#8bd5a5",
  matchOverviewRuler: "#8bd5a5",
};

export function getTerminal(paneId: string, callbacks: RegistryCallbacks): RegisteredTerminal {
  const existing = terminals.get(paneId);
  if (existing) return existing;

  const terminal = new Terminal({
    allowProposedApi: true,
    logLevel: "off",
    windowsPty,
    linkHandler: {
      activate(event, uri) {
        event.preventDefault();
        void desktop().openExternal(uri).catch(() => {});
      },
    },
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: '"Cascadia Mono", "Microsoft YaHei UI", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    letterSpacing: 0,
    scrollback: 10_000,
    theme: {
      background: "#111417",
      foreground: "#d6d9dc",
      cursor: "#8bd5a5",
      cursorAccent: "#111417",
      selectionBackground: "#3b5e4a99",
      black: "#15191d",
      red: "#e06c75",
      green: "#8bd5a5",
      yellow: "#e5c07b",
      blue: "#74a7d8",
      magenta: "#c792c7",
      cyan: "#70c0ba",
      white: "#d6d9dc",
      brightBlack: "#66717b",
      brightRed: "#f07f88",
      brightGreen: "#a4e3b9",
      brightYellow: "#f0cf8d",
      brightBlue: "#8dbce8",
      brightMagenta: "#dda7dd",
      brightCyan: "#88d6cf",
      brightWhite: "#f2f4f5",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void desktop().openExternal(uri).catch(() => {});
    }),
  );

  const container = document.createElement("div");
  container.className = "terminal-surface";
  terminal.open(container);
  // 记录本实例是否占用了一个 WebGL 上下文，释放（dispose 或上下文丢失）时归还配额。
  const renderer = { webgl: false };
  if (webglContexts < MAX_WEBGL_CONTEXTS) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (renderer.webgl) {
          renderer.webgl = false;
          webglContexts = Math.max(0, webglContexts - 1);
        }
      });
      terminal.loadAddon(webgl);
      webglContexts += 1;
      renderer.webgl = true;
    } catch {
      // xterm's built-in renderer remains active.
    }
  }

  terminal.onData((data) => callbacks.onInput(paneId, data));
  terminal.onBinary((data) => callbacks.onBinaryInput(paneId, data));
  terminal.onTitleChange((title) => callbacks.onTitle(paneId, title));
  terminal.onResize(({ cols, rows }) => callbacks.onResize(paneId, cols, rows));
  const search = new SearchAddon();
  search.onDidChangeResults((results) => {
    callbacks.onSearchResults(paneId, results.resultIndex, results.resultCount);
  });
  terminal.loadAddon(search);
  searches.set(paneId, search);
  terminal.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) callbacks.onCwd(paneId, data.slice(2));
    return true;
  });
  container.addEventListener("focusin", () => callbacks.onFocus(paneId));
  container.addEventListener("pointerdown", () => callbacks.onFocus(paneId));
  container.addEventListener("contextmenu", (event) => handleRightClick(event, terminal));

  const registered: RegisteredTerminal = {
    terminal,
    fit,
    container,
    attach(host, afterFit) {
      if (container.parentElement !== host) host.append(container);
      scheduleFitTerminal(paneId, afterFit);
    },
    setFocused(focused) {
      if (focused) terminal.focus();
    },
  };
  terminals.set(paneId, registered);
  renderers.set(paneId, renderer);
  observedPanes.set(container, paneId);
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const id = observedPanes.get(target);
      const entry = id === undefined ? undefined : terminals.get(id);
      if (id !== undefined && entry) {
        pendingFits.set(id, { entry, afterFit: pendingFits.get(id)?.afterFit });
      }
    }
    // One observer delivers every changed pane together, so a divider update
    // can measure and resize them in this frame without another frame of lag.
    flushTerminalFits();
  });
  resizeObserver.observe(container);
  return registered;
}

export function writeTerminal(paneId: string, data: string, consumed: () => void): boolean {
  const entry = terminals.get(paneId);
  if (!entry) return false;
  entry.terminal.write(data, consumed);
  return true;
}

/** Drain writes already submitted before resetting after a host restart. */
export function drainTerminal(paneId: string): Promise<void> {
  const entry = terminals.get(paneId);
  if (!entry) return Promise.resolve();
  return new Promise((resolve) => entry.terminal.write("", resolve));
}

export function fitTerminal(paneId: string): void {
  const entry = terminals.get(paneId);
  if (entry) applyTerminalSize(entry, measureTerminal(entry));
}

function measureTerminal(entry: RegisteredTerminal): ReturnType<FitAddon["proposeDimensions"]> {
  if (!entry.container.isConnected) return;
  try { return entry.fit.proposeDimensions(); } catch { /* hidden during a tree update */ }
}

function applyTerminalSize(entry: RegisteredTerminal, size: ReturnType<FitAddon["proposeDimensions"]>): void {
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
  if (entry.terminal.cols === size.cols && entry.terminal.rows === size.rows) return;
  try { entry.terminal.resize(size.cols, size.rows); } catch { /* disposed during a tree update */ }
}

/** Coalesce mounts; the shared observer handles subsequent size changes before paint. */
function scheduleFitTerminal(paneId: string, afterFit?: () => void): void {
  const entry = terminals.get(paneId);
  if (!entry) return;
  pendingFits.set(paneId, { entry, afterFit: afterFit ?? pendingFits.get(paneId)?.afterFit });
  if (fitFrame !== undefined) return;
  fitFrame = requestAnimationFrame(flushTerminalFits);
}

function flushTerminalFits(): void {
  if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
  fitFrame = undefined;
  const pending = [...pendingFits];
  pendingFits.clear();
  // FitAddon.fit interleaves computed-style reads and resize writes. Its
  // public measurement API lets all panes share one layout read phase.
  const measured = pending.map(([id, fit]) => ({ id, ...fit, size: measureTerminal(fit.entry) }));
  for (const { id, entry, size, afterFit } of measured) {
    if (terminals.get(id) !== entry || !entry.container.isConnected) continue;
    applyTerminalSize(entry, size);
    afterFit?.();
  }
}

/** 把键盘焦点交给指定窗格的 xterm；实例不存在或不可见时静默失败。 */
export function focusTerminal(paneId: string): void {
  try {
    terminals.get(paneId)?.setFocused(true);
  } catch {
    // 终端正在销毁或尚未挂载时聚焦失败是正常的
  }
}

export function terminalSize(paneId: string): { cols: number; rows: number } | undefined {
  const terminal = terminals.get(paneId)?.terminal;
  return terminal ? { cols: terminal.cols, rows: terminal.rows } : undefined;
}

export function terminalCount(): number {
  return terminals.size;
}

/** 重置指定窗格终端的显示内容与 VT 状态，用于会话重启。 */
export function resetTerminal(paneId: string): void {
  terminals.get(paneId)?.terminal.reset();
}

/** 在当前窗格的滚动缓冲中搜索；空查询清除高亮装饰。 */
export function searchInTerminal(paneId: string, query: string, direction: "next" | "previous"): void {
  const addon = searches.get(paneId);
  if (!addon) return;
  const trimmed = query.trim();
  if (!trimmed) {
    addon.clearDecorations();
    return;
  }
  const options = { incremental: true, decorations: SEARCH_DECORATIONS };
  if (direction === "next") addon.findNext(trimmed, options);
  else addon.findPrevious(trimmed, options);
}

export function disposeTerminal(paneId: string): void {
  const entry = terminals.get(paneId);
  if (!entry) return;
  pendingFits.delete(paneId);
  if (!pendingFits.size && fitFrame !== undefined) {
    cancelAnimationFrame(fitFrame);
    fitFrame = undefined;
  }
  resizeObserver?.unobserve(entry.container);
  observedPanes.delete(entry.container);
  entry.terminal.dispose();
  entry.container.remove();
  terminals.delete(paneId);
  if (!terminals.size) {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
  }
  searches.delete(paneId);
  const renderer = renderers.get(paneId);
  renderers.delete(paneId);
  if (renderer?.webgl) {
    renderer.webgl = false;
    webglContexts = Math.max(0, webglContexts - 1);
  }
}
