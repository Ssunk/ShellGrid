import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
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
  onFocus(paneId: string): void;
  onResize(paneId: string, cols: number, rows: number): void;
}

const terminals = new Map<string, RegisteredTerminal>();
const renderers = new Map<string, { webgl: boolean }>();
let webglContexts = 0;
const MAX_WEBGL_CONTEXTS = 4;

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
  terminal.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) callbacks.onCwd(paneId, data.slice(2));
    return true;
  });
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

export function fitTerminal(paneId: string): void {
  const entry = terminals.get(paneId);
  if (!entry || !entry.container.isConnected) return;
  try { entry.fit.fit(); } catch { /* zero-size during a tree update */ }
}

export function terminalSize(paneId: string): { cols: number; rows: number } | undefined {
  const terminal = terminals.get(paneId)?.terminal;
  return terminal ? { cols: terminal.cols, rows: terminal.rows } : undefined;
}

export function terminalCount(): number {
  return terminals.size;
}

export function disposeTerminal(paneId: string): void {
  const entry = terminals.get(paneId);
  if (!entry) return;
  entry.terminal.dispose();
  entry.container.remove();
  terminals.delete(paneId);
  const renderer = renderers.get(paneId);
  renderers.delete(paneId);
  if (renderer?.webgl) {
    renderer.webgl = false;
    webglContexts = Math.max(0, webglContexts - 1);
  }
}
