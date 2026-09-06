import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const terminals: Terminal[] = [];
function terminal() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, logLevel: "off",
    windowsPty: { backend: "conpty", buildNumber: 21376 } });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  terminals.push(term);
  return term;
}
function write(term: Terminal, data: string): Promise<void> { return new Promise((resolve) => term.write(data, resolve)); }
afterEach(() => { for (const term of terminals.splice(0)) term.dispose(); });
describe("pinned xterm VT compatibility", () => {
  it("restores the normal screen after an alternate screen application exits", async () => {
    const term = terminal();
    await write(term, "normal");
    await write(term, "\x1b[?1049h\x1b[Halternate");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe("alternate");
    await write(term, "\x1b[?1049l");
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe("normal");
  });
  it("retains TrueColor, Unicode width and combining characters", async () => {
    const term = terminal();
    await write(term, "\x1b[38;2;18;52;86m中e\u0301🙂");
    const line = term.buffer.active.getLine(0)!;
    expect(line.getCell(0)!.getWidth()).toBe(2);
    expect(line.getCell(0)!.getFgColor()).toBe(0x123456);
    expect(line.getCell(2)!.getChars()).toBe("e\u0301");
    expect(line.getCell(3)!.getWidth()).toBe(2);
  });
  it("answers cursor position queries needed by ConPTY and PowerShell during resize", async () => {
    const term = terminal();
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    await write(term, "\x1b[4;7H\x1b[6n");
    expect(replies).toEqual(["\x1b[4;7R"]);
    term.resize(132, 44);
    await write(term, "\x1b[9;11H\x1b[6n");
    expect(replies.at(-1)).toBe("\x1b[9;11R");
  });
  it("processes rapid redraw and paste/mouse/focus modes without changing final screen content", async () => {
    const term = terminal();
    await write(term, "\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h");
    for (let i = 0; i < 100; i++) await write(term, "\x1b[H\x1b[2Kframe " + i);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe("frame 99");
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    await write(term, "\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?1004l");
    expect(term.modes.bracketedPasteMode).toBe(false);
  });
});
