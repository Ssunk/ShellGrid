import { describe, expect, it, vi } from "vitest";
import { TerminalClient } from "./terminalClient";

interface ClientInternals {
  socket: WebSocket;
  requests: Map<string, string>;
  receive(data: string | ArrayBuffer): void;
}

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
