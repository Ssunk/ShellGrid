import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalClient } from "./terminalClient";

interface ClientInternals {
  socket: WebSocket;
  requests: Map<string, string>;
  receive(data: string | ArrayBuffer): void;
}

class FakeSocket {
  static OPEN = 1;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  constructor(public url: string) {}

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
    this.readyState = 3;
    this.onclose?.();
  }
}

const launch = { cwd: "C:\\", shell: "pwsh.exe", args: [] };

describe("connection recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries on a fresh socket after the initial connect fails", async () => {
    const onDisconnected = vi.fn();
    const client = new TerminalClient("ws://127.0.0.1", "token", {
      onCreated: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      onDisconnected,
    });
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", RecordingSocket as unknown as typeof WebSocket);

    const first = client.connect();
    sockets[0].fail();
    await expect(first).rejects.toThrow("无法连接本机终端服务");
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    const second = client.connect();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await second;

    await client.create("pane-1", launch, 80, 24);
    expect(sockets[1].send).toHaveBeenCalledWith(expect.stringContaining('"type":"create"'));
    expect(sockets[0].send).not.toHaveBeenCalled();
  });

  it("create swallows a failed connect and sends nothing while the socket is closed", async () => {
    const onDisconnected = vi.fn();
    const client = new TerminalClient("ws://127.0.0.1", "token", {
      onCreated: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      onDisconnected,
    });
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", RecordingSocket as unknown as typeof WebSocket);

    const first = client.connect();
    sockets[0].fail();
    await expect(first).rejects.toThrow();

    const created = client.create("pane-1", launch, 80, 24);
    sockets[1].fail();
    await expect(created).resolves.toBeUndefined();
    expect(onDisconnected).toHaveBeenCalledTimes(2);
    expect(sockets[1].send).not.toHaveBeenCalled();
  });
});

describe("TerminalClient session lifecycle", () => {
  it("closes a session whose pane was removed while creation was pending", () => {
    const onCreated = vi.fn();
    const client = new TerminalClient("ws://127.0.0.1", "token", {
      onCreated,
      onExit: vi.fn(),
      onError: vi.fn(),
      onDisconnected: vi.fn(),
    });
    const send = vi.fn();
    const internals = client as unknown as ClientInternals;
    internals.socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    internals.requests.set("request-1", "old-pane");

    client.closePane("old-pane");
    internals.receive(JSON.stringify({
      type: "created",
      requestId: "request-1",
      paneId: "old-pane",
      sessionId: "00000000-0000-0000-0000-000000000001",
    }));

    expect(onCreated).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "close",
      sessionId: "00000000-0000-0000-0000-000000000001",
    }));
  });
});
