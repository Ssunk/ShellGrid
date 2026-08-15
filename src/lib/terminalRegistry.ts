import { invoke } from "@tauri-apps/api/core";
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
  attach(host: HTMLElement): void;
  setFocused(focused: boolean): void;
}

interface RegistryCallbacks {
  onCwd(paneId: string, cwd: string): void;
  onTitle(paneId: string, title: string): void;
  onInput(paneId: string, data: string): void;
  onPasteImages(paneId: string, images: File[]): void;
  onFocus(paneId: string): void;
  onResize(paneId: string, cols: number, rows: number): void;
  onSearchResults(paneId: string, current: number, total: number): void;
}

const terminals = new Map<string, RegisteredTerminal>();
const renderers = new Map<string, { webgl: boolean }>();
const searches = new Map<string, SearchAddon>();
let webglContexts = 0;
const MAX_WEBGL_CONTEXTS = 4;

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
      void invoke("open_external", { url: uri });
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
      // xterm's built-in DOM renderer remains active.
    }
  }

  terminal.onData((data) => callbacks.onInput(paneId, data));
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
  // xterm 的默认 paste 处理器只读取 text/plain。使用捕获阶段先取出剪贴板中的
  // 位图，避免事件到达 xterm 后被转换为空文本；普通文本仍完全交给 xterm，
  // 从而保留换行规范化和 bracketed paste 行为。
  container.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const itemImages = [...clipboard.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const images = itemImages.length > 0
      ? itemImages
      : [...clipboard.files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    callbacks.onPasteImages(paneId, images);
  }, true);
  container.addEventListener("focusin", () => callbacks.onFocus(paneId));
  container.addEventListener("pointerdown", () => callbacks.onFocus(paneId));

  const registered: RegisteredTerminal = {
    terminal,
    fit,
    container,
    attach(host) {
      if (container.parentElement !== host) host.append(container);
      requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* hidden while the split tree settles */ }
      });
    },
    setFocused(focused) {
      if (focused) terminal.focus();
    },
  };
  terminals.set(paneId, registered);
  renderers.set(paneId, renderer);
  return registered;
}

export function writeTerminal(paneId: string, bytes: Uint8Array): void {
  terminals.get(paneId)?.terminal.write(bytes);
}

export function pasteTerminal(paneId: string, text: string): void {
  terminals.get(paneId)?.terminal.paste(text);
}

export function fitTerminal(paneId: string): void {
  const entry = terminals.get(paneId);
  if (!entry || !entry.container.isConnected) return;
  try { entry.fit.fit(); } catch { /* zero-size during a tree update */ }
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

/** 清空指定窗格终端的显示内容，保留向后兼容。 */
export function clearTerminal(paneId: string): void {
  resetTerminal(paneId);
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
  entry.terminal.dispose();
  entry.container.remove();
  terminals.delete(paneId);
  searches.delete(paneId);
  const renderer = renderers.get(paneId);
  renderers.delete(paneId);
  if (renderer?.webgl) {
    renderer.webgl = false;
    webglContexts = Math.max(0, webglContexts - 1);
  }
}
