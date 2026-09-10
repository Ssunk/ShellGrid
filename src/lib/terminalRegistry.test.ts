import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, getTheme } from "./themes";

class TerminalMock {
  cols = 80;
  rows = 24;
  options: object;
  constructor(options: object) { this.options = options; }
  unicode = { activeVersion: "" };
  parser = { registerOscHandler: vi.fn() };
  loadAddon = vi.fn();
  open = vi.fn((element: HTMLElement) => { element.dataset.opened = "true"; });
  onData = vi.fn();
  onBinary = vi.fn();
  onTitleChange = vi.fn();
  onResize = vi.fn();
  resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
  focus = vi.fn();
  hasSelection = vi.fn(() => false);
  getSelection = vi.fn(() => "");
  clearSelection = vi.fn();
  paste = vi.fn();
  dispose = vi.fn();
  reset = vi.fn();
  write = vi.fn();
}

const observers: ResizeObserverMock[] = [];
class ResizeObserverMock {
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  notify(...targets: Element[]) {
    this.callback(targets.map((target) => ({ target })) as ResizeObserverEntry[], this);
  }
}

interface SearchAddonMock {
  onDidChangeResults: ReturnType<typeof vi.fn>;
  clearDecorations: ReturnType<typeof vi.fn>;
  findNext: ReturnType<typeof vi.fn>;
  findPrevious: ReturnType<typeof vi.fn>;
}

const { searchInstances } = vi.hoisted(() => ({ searchInstances: [] as SearchAddonMock[] }));

vi.mock("@xterm/xterm", () => ({ Terminal: TerminalMock }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  fit = vi.fn();
  proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn(); } }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults = vi.fn();
    clearDecorations = vi.fn();
    findNext = vi.fn();
    findPrevious = vi.fn();
    constructor() {
      searchInstances.push(this as unknown as SearchAddonMock);
    }
  },
}));

function makeCallbacks(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onBinaryInput: vi.fn(),
    onFocus: vi.fn(), onResize: vi.fn(), onSearchResults: vi.fn(), ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  observers.length = 0;
});

afterEach(async () => {
  const { disposeTerminal, setTerminalTheme } = await import("./terminalRegistry");
  for (const id of ["stable-pane", "text-pane", "search-pane", "count-pane", "binary-pane", "ack-pane", "link-pane", "copy-pane", "paste-pane", "fit-one", "fit-two", "theme-one", "theme-two", "theme-new"]) disposeTerminal(id);
  setTerminalTheme(getTheme(DEFAULT_THEME).terminal);
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "shellgrid");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("terminal registry", () => {
  it("recolors every existing and future pane without resetting terminals or interrupting pending writes", async () => {
    const { getTerminal, setTerminalTheme, writeTerminal } = await import("./terminalRegistry");
    const entries = ["theme-one", "theme-two"].map((id) => getTerminal(id, makeCallbacks() as never));
    const consumed = vi.fn();
    writeTerminal("theme-one", "pending output", consumed);
    const palette = getTheme("rose").terminal;

    setTerminalTheme(palette);

    for (const [index, entry] of entries.entries()) {
      expect(getTerminal(["theme-one", "theme-two"][index], makeCallbacks() as never)).toBe(entry);
      expect(entry.terminal.options.theme).toEqual(palette);
      expect(entry.terminal.options.theme).not.toBe(palette);
      expect(entry.terminal.open).toHaveBeenCalledOnce();
      expect(entry.terminal.reset).not.toHaveBeenCalled();
      expect(entry.terminal.dispose).not.toHaveBeenCalled();
    }
    expect(consumed).not.toHaveBeenCalled();
    (entries[0].terminal as unknown as TerminalMock).write.mock.calls[0][1]();
    expect(consumed).toHaveBeenCalledOnce();

    const added = getTerminal("theme-new", makeCallbacks() as never);
    expect(added.terminal.options.theme).toEqual(palette);
    setTerminalTheme(getTheme(DEFAULT_THEME).terminal);
    for (const entry of [...entries, added]) expect(entry.terminal.options.theme).toEqual(getTheme(DEFAULT_THEME).terminal);
  });

  it("forwards legacy binary input independently of text input", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const onBinaryInput = vi.fn(), onInput = vi.fn();
    const entry = getTerminal("binary-pane", makeCallbacks({ onBinaryInput, onInput }) as never);
    const terminal = entry.terminal as unknown as TerminalMock;
    terminal.onBinary.mock.calls[0][0]("\x80\xff");
    expect(onBinaryInput).toHaveBeenCalledWith("binary-pane", "\x80\xff");
    expect(onInput).not.toHaveBeenCalled();
  });
  it("acknowledges writes through the xterm callback, never before parsing", async () => {
    const { getTerminal, writeTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("ack-pane", makeCallbacks() as never);
    const done = vi.fn();
    expect(writeTerminal("ack-pane", "tail", done)).toBe(true);
    expect(done).not.toHaveBeenCalled();
    const terminal = entry.terminal as unknown as TerminalMock;
    terminal.write.mock.calls[0][1]();
    expect(done).toHaveBeenCalledOnce();
    expect(writeTerminal("missing", "tail", done)).toBe(false);
  });
  it("opens OSC 8 links through the validated desktop API", async () => {
    const openExternal = vi.fn(async () => {});
    Object.defineProperty(window, "shellgrid", { configurable: true, value: { openExternal } });
    const { getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("link-pane", makeCallbacks() as never);
    const event = new MouseEvent("click", { cancelable: true });
    entry.terminal.options.linkHandler!.activate(event, "https://example.com", { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } });
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
  });
  it("resets terminal instance state and buffer on reset", async () => {
    const { disposeTerminal, getTerminal, resetTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("reset-pane", makeCallbacks() as never);
    resetTerminal("reset-pane");
    expect(entry.terminal.reset).toHaveBeenCalledTimes(1);
    disposeTerminal("reset-pane");
  });
  it("focuses the terminal of a mounted pane without throwing for missing panes", async () => {
    const { disposeTerminal, focusTerminal, getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("focus-pane", makeCallbacks() as never);
    focusTerminal("focus-pane");
    expect(entry.terminal.focus).toHaveBeenCalledTimes(1);
    focusTerminal("missing-pane");
    expect(entry.terminal.focus).toHaveBeenCalledTimes(1);
    disposeTerminal("focus-pane");
  });

  it("keeps one terminal instance while its host moves", async () => {
    const { getTerminal, terminalCount } = await import("./terminalRegistry");
    const first = getTerminal("stable-pane", makeCallbacks() as never);
    const second = getTerminal("stable-pane", makeCallbacks() as never);
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    first.attach(firstHost);
    second.attach(secondHost);
    expect(second).toBe(first);
    expect(secondHost.firstElementChild).toBe(first.container);
    expect(firstHost.childElementCount).toBe(0);
    expect(terminalCount()).toBe(1);
  });

  it("measures every changed pane before resizing and creates with the fitted dimensions", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const order: string[] = [];
    const entries = ["fit-one", "fit-two"].map((id, index) => {
      const entry = getTerminal(id, makeCallbacks() as never);
      const host = document.createElement("div");
      document.body.append(host);
      vi.mocked(entry.fit.proposeDimensions).mockImplementation(() => {
        order.push("measure " + id);
        return { cols: 100 + index, rows: 40 };
      });
      const terminal = entry.terminal as unknown as TerminalMock;
      terminal.resize.mockImplementation((cols, rows) => {
        order.push("resize " + id);
        terminal.cols = cols;
        terminal.rows = rows;
      });
      const afterFit = vi.fn(() => expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 100 + index, rows: 40 }));
      entry.attach(host, afterFit);
      return { entry, afterFit };
    });
    expect(observers).toHaveLength(1);
    expect(order).toEqual([]);
    // Deliver the complete ResizeObserver batch, as Chromium does before paint.
    observers[0].notify(...entries.map(({ entry }) => entry.container));
    expect(order).toEqual(["measure fit-one", "measure fit-two", "resize fit-one", "resize fit-two"]);
    for (const { afterFit } of entries) expect(afterFit).toHaveBeenCalledOnce();
    vi.advanceTimersToNextFrame();
    expect(order).toHaveLength(4);
  });

  it("coalesces rapid remounts and only runs the latest mount callback", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("fit-one", makeCallbacks() as never);
    const firstHost = document.createElement("div"), lastHost = document.createElement("div");
    document.body.append(firstHost, lastHost);
    const oldMount = vi.fn(), currentMount = vi.fn();
    entry.attach(firstHost, oldMount);
    entry.attach(lastHost, currentMount);
    vi.advanceTimersToNextFrame();
    expect(entry.container.parentElement).toBe(lastHost);
    expect(entry.fit.proposeDimensions).toHaveBeenCalledOnce();
    expect(oldMount).not.toHaveBeenCalled();
    expect(currentMount).toHaveBeenCalledOnce();
  });

  it("skips unchanged sizes and disconnected surfaces, then fits a reattached terminal", async () => {
    const { fitTerminal, getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("fit-one", makeCallbacks() as never);
    const host = document.createElement("div");
    document.body.append(host);
    entry.attach(host);
    vi.advanceTimersToNextFrame();
    const terminal = entry.terminal as unknown as TerminalMock;
    expect(terminal.resize).not.toHaveBeenCalled();
    entry.container.remove();
    vi.mocked(entry.fit.proposeDimensions).mockClear().mockReturnValue({ cols: 120, rows: 36 });
    fitTerminal("fit-one");
    observers[0].notify(entry.container);
    expect(entry.fit.proposeDimensions).not.toHaveBeenCalled();
    entry.attach(host);
    vi.advanceTimersToNextFrame();
    expect(terminal.resize).toHaveBeenCalledExactlyOnceWith(120, 36);
  });

  it("cancels pending mounts and releases observation when the pane is disposed", async () => {
    const { disposeTerminal, getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("fit-one", makeCallbacks() as never);
    const host = document.createElement("div");
    document.body.append(host);
    const afterFit = vi.fn();
    entry.attach(host, afterFit);
    disposeTerminal("fit-one");
    observers[0].notify(entry.container);
    vi.advanceTimersToNextFrame();
    expect(entry.fit.proposeDimensions).not.toHaveBeenCalled();
    expect(afterFit).not.toHaveBeenCalled();
    expect(observers[0].unobserve).toHaveBeenCalledWith(entry.container);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it("leaves text paste events for xterm", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("text-pane", makeCallbacks() as never);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });

    entry.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("copies and clears a selection on right click", async () => {
    const writeClipboardText = vi.fn(async () => {});
    Object.defineProperty(window, "shellgrid", { configurable: true, value: { writeClipboardText } });
    const { getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("copy-pane", makeCallbacks() as never);
    const terminal = entry.terminal as unknown as TerminalMock;
    terminal.hasSelection.mockReturnValue(true);
    terminal.getSelection.mockReturnValue("selected text");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    entry.container.dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(writeClipboardText).toHaveBeenCalledWith("selected text");
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("pastes the system clipboard on right click without a selection", async () => {
    const readClipboardText = vi.fn(async () => "clipboard text");
    Object.defineProperty(window, "shellgrid", { configurable: true, value: { readClipboardText } });
    const { getTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("paste-pane", makeCallbacks() as never);
    const terminal = entry.terminal as unknown as TerminalMock;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    entry.container.dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(readClipboardText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith("clipboard text");
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("searches the pane buffer and clears decorations on empty query", async () => {
    const { getTerminal, searchInTerminal } = await import("./terminalRegistry");
    getTerminal("search-pane", makeCallbacks() as never);
    const addon = searchInstances[searchInstances.length - 1];

    searchInTerminal("search-pane", "pattern", "next");
    expect(addon.findNext).toHaveBeenCalledWith("pattern", expect.objectContaining({ incremental: true }));

    searchInTerminal("search-pane", "pattern", "previous");
    expect(addon.findPrevious).toHaveBeenCalled();

    searchInTerminal("search-pane", "   ", "next");
    expect(addon.clearDecorations).toHaveBeenCalled();

    searchInTerminal("missing-pane", "pattern", "next");
    expect(addon.findNext).toHaveBeenCalledTimes(1);
  });

  it("reports search result counts through the registry callbacks", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const onSearchResults = vi.fn();
    getTerminal("count-pane", { ...makeCallbacks(), onSearchResults } as never);
    const addon = searchInstances[searchInstances.length - 1];
    const listener = addon.onDidChangeResults.mock.calls[0][0] as (results: { resultIndex: number; resultCount: number }) => void;

    listener({ resultIndex: 2, resultCount: 5 });

    expect(onSearchResults).toHaveBeenCalledWith("count-pane", 2, 5);
  });
});
