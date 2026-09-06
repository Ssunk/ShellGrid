import type { MessagePortMain } from "electron";
import { SessionManager } from "./pty/session-manager";
import { NodePtyFactory } from "./pty/node-pty-factory";

const parent = process.parentPort;
if (!parent) throw new Error("PTY Host 必须作为 Electron utilityProcess 运行");
let manager: SessionManager | undefined;
let port: MessagePortMain | undefined;
let shuttingDown: Promise<void> | undefined;
function shutdown(): Promise<void> {
  return shuttingDown ??= (async () => {
    await manager?.shutdown();
    port?.close();
    process.exit(0);
  })();
}
parent.on("message", (event) => {
  const message = event.data as { type: string; generation?: number };
  if (message.type === "shutdown") { void shutdown(); return; }
  if (message.type !== "connect" || manager || !message.generation || !event.ports[0]) return;
  port = event.ports[0];
  manager = new SessionManager(message.generation, new NodePtyFactory(),
    (data) => port?.postMessage(data), (count) => parent.postMessage({ type: "count", count }));
  port.on("message", (entry) => manager?.handle(entry.data));
  port.on("close", () => { void shutdown(); });
  port.start();
  parent.postMessage({ type: "ready", generation: message.generation });
});
// No stack, command, environment or terminal payload logging on fatal errors.
process.on("uncaughtException", () => { parent.postMessage({ type: "fatal", reason: "uncaughtException" }); void shutdown(); });
process.on("unhandledRejection", () => { parent.postMessage({ type: "fatal", reason: "unhandledRejection" }); void shutdown(); });
