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
  write = vi.fn();
  paste = vi.fn();
}

vi.mock("@xterm/xterm", () => ({ Terminal: TerminalMock }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn(); } }));

describe("terminal registry", () => {
  it("focuses the terminal of a mounted pane without throwing for missing panes", async () => {
    const { disposeTerminal, focusTerminal, getTerminal } = await import("./terminalRegistry");
    const callbacks = {
      onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onPasteImages: vi.fn(), onFocus: vi.fn(), onResize: vi.fn(),
    };
    const entry = getTerminal("focus-pane", callbacks);
    focusTerminal("focus-pane");
    expect(entry.terminal.focus).toHaveBeenCalledTimes(1);
    focusTerminal("missing-pane");
    expect(entry.terminal.focus).toHaveBeenCalledTimes(1);
    disposeTerminal("focus-pane");
  });

  it("keeps one terminal instance while its host moves", async () => {
    const { getTerminal, terminalCount } = await import("./terminalRegistry");
    const callbacks = {
      onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onPasteImages: vi.fn(), onFocus: vi.fn(), onResize: vi.fn(),
    };
    const first = getTerminal("stable-pane", callbacks);
    const second = getTerminal("stable-pane", callbacks);
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
    const entry = getTerminal("image-pane", {
      onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onPasteImages, onFocus: vi.fn(), onResize: vi.fn(),
    });
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
    const entry = getTerminal("text-pane", {
      onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onPasteImages, onFocus: vi.fn(), onResize: vi.fn(),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });

    entry.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onPasteImages).not.toHaveBeenCalled();
  });
});
