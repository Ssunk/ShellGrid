import { describe, expect, it, vi } from "vitest";

class TerminalMock {
  cols = 80;
  rows = 24;
  unicode = { activeVersion: "" };
  parser = { registerOscHandler: vi.fn() };
  loadAddon = vi.fn();
  open = vi.fn((element: HTMLElement) => { element.dataset.opened = "true"; });
  onData = vi.fn();
  onTitleChange = vi.fn();
  onResize = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  reset = vi.fn();
  clear = vi.fn();
  write = vi.fn();
  paste = vi.fn();
}

interface SearchAddonMock {
  onDidChangeResults: ReturnType<typeof vi.fn>;
  clearDecorations: ReturnType<typeof vi.fn>;
  findNext: ReturnType<typeof vi.fn>;
  findPrevious: ReturnType<typeof vi.fn>;
}

const { searchInstances } = vi.hoisted(() => ({ searchInstances: [] as SearchAddonMock[] }));

vi.mock("@xterm/xterm", () => ({ Terminal: TerminalMock }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
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
    onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onPasteImages: vi.fn(),
    onFocus: vi.fn(), onResize: vi.fn(), onSearchResults: vi.fn(), ...extra,
  };
}

describe("terminal registry", () => {
  it("resets terminal instance state and buffer on reset", async () => {
    const { disposeTerminal, getTerminal, resetTerminal, clearTerminal } = await import("./terminalRegistry");
    const entry = getTerminal("reset-pane", makeCallbacks() as never);
    resetTerminal("reset-pane");
    expect(entry.terminal.reset).toHaveBeenCalledTimes(1);
    clearTerminal("reset-pane");
    expect(entry.terminal.reset).toHaveBeenCalledTimes(2);
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

  it("intercepts clipboard images before xterm handles the paste", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const onPasteImages = vi.fn();
    const entry = getTerminal("image-pane", { ...makeCallbacks(), onPasteImages } as never);
    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        files: [],
      },
    });

    entry.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onPasteImages).toHaveBeenCalledWith("image-pane", [image]);
  });

  it("leaves text paste events for xterm", async () => {
    const { getTerminal } = await import("./terminalRegistry");
    const onPasteImages = vi.fn();
    const entry = getTerminal("text-pane", { ...makeCallbacks(), onPasteImages } as never);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });

    entry.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onPasteImages).not.toHaveBeenCalled();
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
