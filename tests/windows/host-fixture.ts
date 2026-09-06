import { MessageChannelMain, utilityProcess, type UtilityProcess, type MessagePortMain } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CreateCommand, TerminalCommand, TerminalEvent } from "../../shared/protocol";
import { check, until } from "./helpers";

export class HostFixture {
  host!: UtilityProcess;
  port!: MessagePortMain;
  events: TerminalEvent[] = [];
  gone = false;
  count = 0;
  exitCode?: number;
  fatalReason?: string;
  listener?: (event: TerminalEvent) => void;
  async start(): Promise<void> {
    const hostPath = process.env.SHELLGRID_TEST_HOST_PATH ?? resolve("dist-electron/pty-host.cjs");
    const launcherPath = process.env.SHELLGRID_TEST_LAUNCHER_PATH ?? resolve("native/launcher/target/release/shellgrid-launcher.exe");
    this.host = utilityProcess.fork(hostPath, [], { serviceName: "ShellGrid verification PTY Host", stdio: "ignore" });
    const { port1, port2 } = new MessageChannelMain();
    this.port = port2;
    this.port.on("message", ({ data }: { data: TerminalEvent }) => {
      // Do not accumulate terminal payloads in the fixture or verification report.
      if (data.type !== "data") this.events.push(data);
      this.listener?.(data);
    });
    this.port.start();
    this.host.once("exit", (code) => { this.exitCode = code; this.gone = true; this.port.close(); });
    let ready = false;
    this.host.on("message", (data: { type: string; count?: number; reason?: string }) => {
      if (data.type === "ready") ready = true;
      if (data.type === "count") this.count = data.count!;
      if (data.type === "fatal") this.fatalReason = data.reason;
    });
    this.host.once("spawn", () => this.host.postMessage({ type: "connect", generation: 1, launcherPath, mainPid: process.pid }, [port1]));
    await until(() => ready || this.gone, "PTY Host ready");
    check(ready, "PTY Host exited before ready");
  }
  send(command: TerminalCommand) { this.port.postMessage(command); }
  create(shell: string, cwd: string, args: string[], paneId = randomUUID()): CreateCommand {
    const command: CreateCommand = { type: "create", generation: 1, requestId: randomUUID(), paneId,
      launch: { cwd, shell, args }, cols: 100, rows: 30, focused: true };
    this.send(command);
    return command;
  }
  async created(request: CreateCommand): Promise<Extract<TerminalEvent, { type: "created" }>> {
    await until(() => this.gone || this.events.some((event) => (event.type === "created" || event.type === "error") && event.requestId === request.requestId), "PTY session created");
    const result = this.events.find((event) => (event.type === "created" || event.type === "error") && event.requestId === request.requestId);
    check(result?.type === "created", "PTY creation failed");
    return result;
  }
  async stop(): Promise<void> {
    if (this.gone) return;
    this.host.postMessage({ type: "shutdown" });
    try { await until(() => this.gone, "PTY Host clean shutdown", 8000); }
    finally { if (!this.gone) this.host.kill(); }
  }
}
