import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { constants, setPriority } from "node:os";
import * as nodePty from "node-pty";
import type { CreateCommand } from "../../shared/protocol";
import type { ManagedPty, PtyCallbacks, PtyFactory } from "./session-manager";
import { sessionEnvironment, shellArguments } from "./launch";

// node-pty 1.2.0-beta.15 exposes no dispose API. In its Windows DLL path,
// natural EOF leaves the input socket and ConoutConnection worker alive.
// Release those I/O resources only after onExit (output EOF), without another
// native kill racing the process watcher. Recheck this adapter when upgrading
// node-pty; the real Windows resource regression covers repeated natural exits.
function releaseExitedResources(pty: nodePty.IPty): void {
  const windowsPty = pty as nodePty.IPty & {
    _agent: { inSocket: Socket; _conoutSocketWorker: { dispose(): void } };
  };
  windowsPty._agent.inSocket.destroy();
  windowsPty._agent._conoutSocketWorker.dispose();
}

export class NodePtyFactory implements PtyFactory {
  constructor(private readonly launcherPath: string, private readonly mainPid: number) {}
  async create(command: CreateCommand, callbacks: PtyCallbacks, signal: AbortSignal): Promise<ManagedPty> {
    if (!(await stat(command.launch.cwd).catch(() => null))?.isDirectory()) throw new Error("启动目录不存在");
    if (signal.aborted) throw new Error("终端创建已取消");
    const pipeName = "\\\\.\\pipe\\shellgrid-" + this.mainPid + "-" + randomUUID();
    let socket: Socket | undefined;
    let pty: nodePty.IPty | undefined;
    let ready = false, exited = false, closing = false;
    let shellPid = 0, reportedExit: number | undefined;
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    let resolveReady!: (pid: number) => void, rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Reject may happen before the server has finished listening.
    void readyPromise.catch(() => {});
    const server = createServer((client) => {
      if (socket || closing || signal.aborted) { client.destroy(); return; }
      socket = client;
      client.setEncoding("utf8");
      let pending = "";
      client.on("error", () => fail("启动器控制管道中断"));
      client.on("close", () => {
        if (!ready) rejectReady(new Error("启动器未完成启动"));
        // The guardian closes its Job on pipe disconnect. Leave the independent
        // output pipe open until node-pty reports EOF, including forced exits.
      });
      client.on("data", (data: string) => {
        pending += data;
        if (pending.length > 8192) { fail("启动器控制消息无效"); return; }
        let separator: number;
        while ((separator = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, separator);
          pending = pending.slice(separator + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (typeof message !== "object" || message === null) throw new Error();
            const event = message as Record<string, unknown>;
            if (event.type === "ready" && !ready && Number.isSafeInteger(event.shellPid) && (event.shellPid as number) > 0) {
              ready = true; resolveReady(event.shellPid as number);
            } else if (event.type === "exit" && Number.isInteger(event.exitCode)) reportedExit = event.exitCode as number;
            else fail("无法启动受 Job Object 保护的终端进程");
          } catch { fail("启动器控制消息无效"); }
        }
      });
      client.write(JSON.stringify({
        type: "start", shell: command.launch.shell, args: shellArguments(command.launch.shell, command.launch.args),
        cwd: command.launch.cwd, focused: command.focused,
      }) + "\n");
    });
    const fail = (message: string) => {
      rejectReady(new Error(message));
      socket?.destroy();
    };
    let termination: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (termination) return termination;
      closing = true;
      rejectReady(new Error("终端创建已取消"));
      signal.removeEventListener("abort", abort);
      socket?.end('{"type":"close"}\n');
      socket?.destroy();
      server.close();
      try { pty?.resume(); } catch { /* already exited */ }
      termination = (async () => {
        if (!pty || exited) return;
        // Prefer the guardian's pipe shutdown. In particular, never call native
        // kill repeatedly while node-pty is already handling the launcher exit.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exit, new Promise<void>((resolve) => {
          timer = setTimeout(() => { if (!exited) { try { pty!.kill(); } catch { /* already exited */ } } resolve(); }, 2500);
        })]);
        if (timer) clearTimeout(timer);
      })();
      return termination;
    };
    const abort = () => { void stop(); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { fail("启动终端超时"); abort(); }, 15_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", () => reject(new Error("无法创建启动器控制管道")));
        server.once("close", () => reject(new Error("启动器控制管道已关闭")));
        server.listen(pipeName, resolve);
      });
      if (signal.aborted) throw new Error("终端创建已取消");
      pty = nodePty.spawn(this.launcherPath, [pipeName, String(this.mainPid), String(process.pid)], {
        name: "xterm-256color", cols: command.cols, rows: command.rows,
        cwd: command.launch.cwd, env: sessionEnvironment(command),
        useConptyDll: true, conptyInheritCursor: false, handleFlowControl: false,
      });
      pty.onData((data) => { if (!closing) callbacks.data(data); });
      pty.onExit(({ exitCode }) => {
        exited = true;
        releaseExitedResources(pty!);
        resolveExit(); clearTimeout(timeout);
        rejectReady(new Error("启动器在初始化期间退出"));
        socket?.destroy();
        server.close();
        signal.removeEventListener("abort", abort);
        if (!closing) callbacks.exit(reportedExit ?? exitCode);
      });
      shellPid = await readyPromise;
      clearTimeout(timeout);
      if (signal.aborted) throw new Error("终端创建已取消");
    } catch (error) {
      clearTimeout(timeout);
      await stop();
      throw error;
    }
    return {
      shellPid,
      start: () => { if (!closing) socket?.write('{"type":"resume"}\n'); },
      write: (data, binary) => {
        // onBinary is a byte string (legacy mouse encoding), never UTF-8 encode it.
        if (!closing && !exited) pty!.write(binary ? Buffer.from(data, "binary") : data);
      },
      resize: (cols, rows) => { if (!closing && !exited) pty!.resize(cols, rows); },
      setPriority: (focused) => {
        if (!closing && !exited) {
          try { setPriority(shellPid, focused ? constants.priority.PRIORITY_NORMAL : constants.priority.PRIORITY_BELOW_NORMAL); }
          catch { /* process may have just exited */ }
        }
      },
      pause: () => { if (!closing && !exited) pty!.pause(); },
      resume: () => { if (!closing && !exited) pty!.resume(); },
      close: stop,
    };
  }
}
