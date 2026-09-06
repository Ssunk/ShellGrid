import { describe, expect, it } from "vitest";
import { validCommand, validEvent } from "./protocol";
const id = "00000000-0000-4000-8000-000000000001";
describe("shared terminal protocol validation", () => {
  it("rejects malformed messages, IDs, payloads and dimensions at the host boundary", () => {
    for (const message of [null, [], {}, { type: "resize", generation: 1, sessionId: "bad", cols: 80, rows: 24 },
      { type: "ack", generation: 1, sessionId: id, chars: -1 },
      { type: "resize", generation: 1, sessionId: id, cols: Infinity, rows: 24 },
      { type: "close", generation: 1, sessionId: id, requestId: id },
      { type: "input", generation: 1, sessionId: id, data: "x", binary: "yes" },
      { type: "setPriority", generation: NaN, sessionId: id, focused: true },
    ]) expect(validCommand(message)).toBe(false);
    expect(validCommand({ type: "input", generation: 1, sessionId: id, data: "\x00\xff", binary: true })).toBe(true);
    expect(validCommand({ type: "close", generation: 1, requestId: id })).toBe(true);
    expect(validCommand({ type: "ack", generation: 1, sessionId: id, chars: 5000 })).toBe(true);
  });
  it("validates events and never accepts unknown frame types", () => {
    expect(validEvent({ type: "data", generation: 1, sessionId: id, data: "你好" })).toBe(true);
    expect(validEvent({ type: "exit", generation: 1, sessionId: id, exitCode: 0 })).toBe(true);
    expect(validEvent({ type: "data", generation: 1, sessionId: id, data: [] })).toBe(false);
    expect(validEvent({ type: "raw", generation: 1, sessionId: id, data: "text" })).toBe(false);
  });
});
