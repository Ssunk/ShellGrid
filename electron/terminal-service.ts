import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebFrameMain } from "electron";
import type { ConnectionInfo } from "../shared/protocol";

export class TerminalService {
  private host?: UtilityProcess;
  private generation = 0;
  private count = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private stopHost?: () => Promise<void>;
  constructor(
    private readonly hostPath: string,
    private readonly launcherPath: string,
    private readonly windowsBuild: number,
    private readonly disconnected: (generation: number) => void,
  ) {}
  get hasSessions(): boolean { return this.count > 0; }
  connect(frame: WebFrameMain, requestId: string): Promise<void> {
    const task = this.queue.then(async () => {
      await this.stopHost?.();
      const generation = ++this.generation;
      const host = utilityProcess.fork(this.hostPath, [], { serviceName: "ShellGrid PTY Host", stdio: "ignore" });
      this.host = host;
      const { port1, port2 } = new MessageChannelMain();
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      let stopped = false;
      host.once("exit", () => {
        resolveExit(); port1.close(); port2.close();
        if (this.host !== host) return;
        this.host = undefined; this.count = 0; this.stopHost = undefined;
        this.disconnected(generation);
      });
      let stopPromise: Promise<void> | undefined;
      this.stopHost = () => stopPromise ??= (async () => {
        stopped = true;
        host.postMessage({ type: "shutdown" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise<void>((resolve) => {
          timer = setTimeout(() => { host.kill(); resolve(); }, 5000);
        })]);
        if (timer) clearTimeout(timer);
        // After kill, wait for the actual host exit before a replacement can start.
        await exited;
      })();
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("终端服务启动超时")), 15_000);
          const onExit = () => { clearTimeout(timeout); reject(new Error("终端服务启动失败")); };
          host.once("exit", onExit);
          host.on("message", (message: { type?: string; generation?: number; count?: number }) => {
            if (this.host !== host) return;
            if (message.type === "count" && Number.isInteger(message.count)) this.count = message.count!;
            if (message.type === "ready" && message.generation === generation) {
              clearTimeout(timeout); host.removeListener("exit", onExit); resolve();
            }
          });
          host.once("spawn", () => {
            if (stopped) return;
            host.postMessage({ type: "connect", generation, launcherPath: this.launcherPath, mainPid: process.pid }, [port1]);
          });
        });
        // Bundled ConPTY 1.25 implements modern reflow even on Windows 10. xterm
        // uses 21376 as its feature threshold, independently of the OS build.
        const info: ConnectionInfo = { generation, windowsPty: { backend: "conpty", buildNumber: Math.max(21376, this.windowsBuild) } };
        if (stopped || frame.isDestroyed()) throw new Error("终端窗口已关闭");
        frame.postMessage("terminal:port", { requestId, info }, [port2]);
      } catch (error) { await this.stopHost?.(); throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async stop(): Promise<void> {
    const stopping = this.stopHost?.();
    const task = this.queue.then(async () => { await stopping; await this.stopHost?.(); });
    this.queue = task.catch(() => {});
    await task;
  }
}
