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
}

vi.mock("@xterm/xterm", () => ({ Terminal: TerminalMock }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn(); } }));

describe("terminal registry", () => {
  it("keeps one terminal instance while its host moves", async () => {
    const { getTerminal, terminalCount } = await import("./terminalRegistry");
    const callbacks = {
      onCwd: vi.fn(), onTitle: vi.fn(), onInput: vi.fn(), onFocus: vi.fn(), onResize: vi.fn(),
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
});
