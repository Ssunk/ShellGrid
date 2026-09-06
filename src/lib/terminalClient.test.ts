import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo, CreateCommand, TerminalCommand, TerminalEvent } from "../../shared/protocol";
import type { TerminalBridge } from "../../shared/desktop";
import { TerminalClient } from "./terminalClient";

const { writes, configure } = vi.hoisted(() => ({
  writes: [] as { pane: string; data: string; done: () => void }[], configure: vi.fn(),
}));
vi.mock("./terminalRegistry", () => ({
  configureTerminals: configure,
  writeTerminal: (pane: string, data: string, done: () => void) => { writes.push({ pane, data, done }); return true; },
}));
const launch = { cwd: "C:\\", shell: "pwsh.exe", args: ["-NoLogo"] };
class Bridge implements TerminalBridge {
  info: ConnectionInfo = { generation: 1, windowsPty: { backend: "conpty", buildNumber: 26100 } };
  connect = vi.fn(async () => this.info);
  send = vi.fn<(command: TerminalCommand) => void>();
  disconnect = vi.fn();
  listener?: (event: TerminalEvent) => void;
  lost?: () => void;
  onEvent(listener: (event: TerminalEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  onDisconnected(listener: () => void) { this.lost = listener; return () => { this.lost = undefined; }; }
  event(value: Omit<TerminalEvent, "generation"> | object) { this.listener?.({ generation: this.info.generation, ...value } as TerminalEvent); }
  creates() { return this.send.mock.calls.map(([command]) => command).filter((command): command is CreateCommand => command.type === "create"); }
}
function setup() {
  const bridge = new Bridge();
  const callbacks = { onCreated: vi.fn(), onExit: vi.fn(), onError: vi.fn(), onDisconnected: vi.fn() };
  return { bridge, callbacks, client: new TerminalClient(bridge, callbacks) };
}
function created(bridge: Bridge, request: CreateCommand, sessionId = crypto.randomUUID()) {
  bridge.event({ type: "created", requestId: request.requestId, paneId: request.paneId, sessionId, shellPid: 100 });
  return sessionId;
}
beforeEach(() => { writes.length = 0; configure.mockClear(); });
describe("MessagePort terminal client", () => {
  it("reserves concurrent creates before connecting and uses the final measured dimensions", async () => {
    const { client, bridge } = setup();
    let ready!: (info: ConnectionInfo) => void;
    bridge.connect.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const first = client.create("pane", launch, 80, 24);
    const duplicate = client.create("pane", launch, 80, 24);
    client.resize("pane", 132, 39);
    ready(bridge.info);
    await Promise.all([first, duplicate]);
    expect(bridge.creates()).toHaveLength(1);
    expect(bridge.creates()[0]).toMatchObject({ cols: 132, rows: 39 });
    client.resize("pane", 141, 43);
    const id = created(bridge, bridge.creates()[0]);
    expect(bridge.send).toHaveBeenCalledWith(expect.objectContaining({ type: "resize", sessionId: id, cols: 141, rows: 43 }));
    expect(configure).toHaveBeenCalledWith(bridge.info.windowsPty);
  });
  it("cancels creation while connection is pending", async () => {
    const { client, bridge } = setup();
    let ready!: (info: ConnectionInfo) => void;
    bridge.connect.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const pending = client.create("pane", launch, 80, 24);
    client.closePane("pane");
    ready(bridge.info);
    await pending;
    expect(bridge.creates()).toHaveLength(0);
  });
  it("closes late created sessions after close and immediate recreation of the same pane", async () => {
    const { client, bridge, callbacks } = setup();
    await client.create("pane", launch, 80, 24);
    const old = bridge.creates()[0];
    client.closePane("pane");
    await client.create("pane", launch, 80, 24);
    const fresh = bridge.creates()[1];
    const oldId = created(bridge, old);
    expect(callbacks.onCreated).not.toHaveBeenCalled();
    expect(bridge.send).toHaveBeenCalledWith({ type: "close", generation: 1, sessionId: oldId });
    const newId = created(bridge, fresh);
    expect(callbacks.onCreated).toHaveBeenCalledWith("pane", newId);
    expect(client.isRunning("pane")).toBe(true);
  });
  it("only acknowledges consumed UTF-16 characters and waits for all tail writes before exit", async () => {
    const { client, bridge, callbacks } = setup();
    await client.create("pane", launch, 80, 24);
    const sessionId = created(bridge, bridge.creates()[0]);
    bridge.event({ type: "data", sessionId, data: "🙂".repeat(2501) });
    bridge.event({ type: "data", sessionId, data: "tail" });
    bridge.event({ type: "exit", sessionId, exitCode: 7 });
    expect(bridge.send.mock.calls.filter(([command]) => command.type === "ack")).toHaveLength(0);
    expect(callbacks.onExit).not.toHaveBeenCalled();
    writes[0].done();
    expect(bridge.send).toHaveBeenCalledWith({ type: "ack", generation: 1, sessionId, chars: 5000 });
    expect(callbacks.onExit).not.toHaveBeenCalled();
    writes[1].done();
    expect(callbacks.onExit).toHaveBeenCalledWith("pane", 7);
    expect(bridge.send).toHaveBeenCalledWith({ type: "ack", generation: 1, sessionId, chars: 6 });
  });
  it("preserves all ordered chunks with no pre-create buffer cap or background timer", async () => {
    const { client, bridge } = setup();
    await client.create("pane", launch, 80, 24);
    const sessionId = created(bridge, bridge.creates()[0]);
    for (let i = 0; i < 100; i++) bridge.event({ type: "data", sessionId, data: String(i) });
    expect(writes).toHaveLength(100);
    expect(writes.map((write) => write.data)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  });
  it("retries a failed connection and ignores events and write callbacks from earlier generations", async () => {
    const { client, bridge, callbacks } = setup();
    bridge.connect.mockRejectedValueOnce(new Error("offline"));
    await expect(client.connect()).rejects.toThrow();
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();
    await client.create("pane", launch, 80, 24);
    const oldId = created(bridge, bridge.creates()[0]);
    bridge.event({ type: "data", sessionId: oldId, data: "x".repeat(6000) });
    bridge.lost?.();
    bridge.info = { ...bridge.info, generation: 2 };
    await client.create("pane", launch, 100, 40);
    const freshId = created(bridge, bridge.creates()[1]);
    bridge.event({ type: "exit", generation: 1, sessionId: freshId, exitCode: 0 });
    writes[0].done();
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(client.isRunning("pane")).toBe(true);
    expect(bridge.send.mock.calls.filter(([command]) => command.type === "ack")).toHaveLength(0);
  });
  it("rejects malformed events and preserves binary input and focus priority", async () => {
    const { client, bridge, callbacks } = setup();
    client.focus("pane");
    await client.create("pane", launch, 80, 24);
    bridge.event({ type: "created", sessionId: "bad" });
    expect(callbacks.onCreated).not.toHaveBeenCalled();
    const id = created(bridge, bridge.creates()[0]);
    client.input("pane", "\x80\xff", true);
    expect(bridge.send).toHaveBeenCalledWith({ type: "input", generation: 1, sessionId: id, data: "\x80\xff", binary: true });
    client.focus("other");
    expect(bridge.send).toHaveBeenCalledWith({ type: "setPriority", generation: 1, sessionId: id, focused: false });
  });
});
