import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ManagedPty, type PtyCallbacks, type PtyFactory } from "./session-manager";
import type { CreateCommand, TerminalEvent } from "../../shared/protocol";

function command(paneId = "pane"): CreateCommand {
  return { type: "create", generation: 1, requestId: randomUUID(), paneId, launch: { cwd: "C:\\", shell: "pwsh.exe", args: [] }, cols: 100, rows: 40, focused: true };
}
function fakePty(): ManagedPty {
  return { shellPid: 42, start: vi.fn(), write: vi.fn(), resize: vi.fn(), setPriority: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), close: vi.fn(async () => {}) };
}
function setup(factory?: PtyFactory) {
  const pty = fakePty();
  let callbacks!: PtyCallbacks;
  const create = vi.fn<PtyFactory["create"]>(async (_command, listeners) => { callbacks = listeners; return pty; });
  const events: TerminalEvent[] = [];
  const manager = new SessionManager(1, factory ?? { create }, (event) => events.push(event));
  return { pty, create, events, manager, callbacks: () => callbacks };
}
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());
describe("PTY host session ownership and flow control", () => {
  it("batches in order, pauses above 100000 and resumes below 5000 confirmed characters", async () => {
    vi.useFakeTimers();
    const { manager, callbacks, pty, events } = setup();
    manager.handle(command());
    await settle();
    const created = events[0];
    if (created.type !== "created") throw new Error("creation failed");
    callbacks().data("🙂".repeat(50_000));
    expect(pty.pause).not.toHaveBeenCalled();
    callbacks().data("tail");
    expect(pty.pause).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(5);
    expect(events[1]).toMatchObject({ type: "data", data: "🙂".repeat(50_000) + "tail" });
    manager.handle({ type: "ack", generation: 1, sessionId: created.sessionId, chars: 95_004 });
    expect(pty.resume).not.toHaveBeenCalled();
    manager.handle({ type: "ack", generation: 1, sessionId: created.sessionId, chars: 1 });
    expect(pty.resume).toHaveBeenCalledOnce();
    await manager.shutdown();
  });
  it("rejects over-acknowledgement and flushes the tail before exit", async () => {
    vi.useFakeTimers();
    const { manager, callbacks, pty, events } = setup();
    manager.handle(command()); await settle();
    const sessionId = (events[0] as Extract<TerminalEvent, { type: "created" }>).sessionId;
    callbacks().data("last data");
    manager.handle({ type: "ack", generation: 1, sessionId, chars: 5000 });
    expect(events[1].type).toBe("error");
    expect(pty.resume).not.toHaveBeenCalled();
    callbacks().exit(9);
    expect(events.slice(-2)).toEqual([
      { type: "data", generation: 1, sessionId, data: "last data" },
      { type: "exit", generation: 1, sessionId, exitCode: 9 },
    ]);
    expect(manager.size).toBe(0);
    vi.runAllTimers();
    expect(events).toHaveLength(4);
  });
  it("closes a session canceled during asynchronous startup and does not publish created", async () => {
    let finish!: (pty: ManagedPty) => void;
    let aborted!: AbortSignal;
    const pty = fakePty();
    const { manager, events } = setup({ create: (_command, _listeners, signal) => {
      aborted = signal; return new Promise((resolve) => { finish = resolve; });
    } });
    const request = command();
    manager.handle(request);
    manager.handle({ type: "close", generation: 1, requestId: request.requestId });
    expect(aborted.aborted).toBe(true);
    finish(pty); await settle();
    await manager.shutdown();
    expect(pty.close).toHaveBeenCalled();
    expect(pty.start).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
  it("waits for old pane cleanup before rapid recreation and isolates late output", async () => {
    const old = fakePty(), fresh = fakePty();
    let closeDone!: () => void;
    old.close = vi.fn(() => new Promise<void>((resolve) => { closeDone = resolve; }));
    const listeners: PtyCallbacks[] = [];
    const create = vi.fn<PtyFactory["create"]>(async (_request, callbacks) => { listeners.push(callbacks); return listeners.length === 1 ? old : fresh; });
    const { manager, events } = setup({ create });
    manager.handle(command()); await settle();
    const sessionId = (events[0] as Extract<TerminalEvent, { type: "created" }>).sessionId;
    manager.handle({ type: "close", generation: 1, sessionId }); await settle();
    manager.handle(command());
    await settle();
    expect(create).toHaveBeenCalledOnce();
    listeners[0].data("late"); listeners[0].exit(1);
    closeDone(); await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.every((event) => event.type === "created")).toBe(true);
    await manager.shutdown();
  });
  it("reserves pending creates, enforces 16 panes and rejects illegal and stale commands", async () => {
    const { manager, create, events } = setup();
    for (let i = 0; i < 17; i++) manager.handle(command("pane" + i));
    manager.handle({ ...command("old"), generation: 0 });
    manager.handle({ ...command("stale"), generation: 2 });
    manager.handle({ ...command("bad"), cols: -1 });
    await settle();
    expect(create).toHaveBeenCalledTimes(16);
    expect(manager.size).toBe(16);
    expect(events.filter((event) => event.type === "error")).toHaveLength(3);
    await manager.shutdown();
    expect(manager.size).toBe(0);
  });
  it("creation failures release reservations and allow another attempt", async () => {
    const factory = { create: vi.fn<PtyFactory["create"]>().mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(fakePty()) };
    const { manager, events } = setup(factory);
    manager.handle(command()); await settle();
    expect(manager.size).toBe(0);
    manager.handle(command()); await settle();
    expect(events.map((event) => event.type)).toEqual(["error", "created"]);
    await manager.shutdown();
  });
});
