import { stat } from "node:fs/promises";
import type { Socket } from "node:net";
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
  async create(command: CreateCommand, callbacks: PtyCallbacks, signal: AbortSignal): Promise<ManagedPty> {
    if (!(await stat(command.launch.cwd).catch(() => null))?.isDirectory()) throw new Error("启动目录不存在");
    if (signal.aborted) throw new Error("终端创建已取消");
    let pty: nodePty.IPty | undefined;
    let exited = false, closing = false;
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    let termination: Promise<void> | undefined;
    let cancelPidWait = () => {};
    const stop = (): Promise<void> => {
      if (termination) return termination;
      closing = true;
      cancelPidWait();
      signal.removeEventListener("abort", abort);
      termination = (async () => {
        if (!pty || exited) return;
        try { pty.resume(); } catch { /* already exited */ }
        try { pty.kill(); } catch { /* already exited */ }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exit, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2500);
        })]);
        if (timer) clearTimeout(timer);
      })();
      return termination;
    };
    const abort = () => { void stop(); };
    try {
      if (signal.aborted) throw new Error("终端创建已取消");
      pty = nodePty.spawn(command.launch.shell, shellArguments(command.launch.shell, command.launch.args), {
        name: "xterm-256color", cols: command.cols, rows: command.rows,
        cwd: command.launch.cwd, env: sessionEnvironment(command),
        useConptyDll: true, conptyInheritCursor: false, handleFlowControl: false,
      });
      pty.onData((data) => { if (!closing) callbacks.data(data); });
      pty.onExit(({ exitCode }) => {
        exited = true;
        releaseExitedResources(pty!);
        resolveExit();
        signal.removeEventListener("abort", abort);
        if (!closing) callbacks.exit(exitCode);
      });
      signal.addEventListener("abort", abort, { once: true });
      // node-pty fills pid only after its ConPTY output channel is ready.
      // Wait briefly so the protocol gets the real Shell PID instead of 0.
      const shellPid = await new Promise<number>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearInterval(interval); clearTimeout(timeout); cancelPidWait = () => {};
          if (error) reject(error); else resolve(pty!.pid);
        };
        const check = () => {
          if (pty!.pid > 0) finish();
          else if (exited) finish(new Error("终端启动失败"));
        };
        const interval = setInterval(check, 10);
        const timeout = setTimeout(() => finish(new Error("终端服务启动超时")), 15_000);
        cancelPidWait = () => finish(new Error("终端创建已取消"));
        check();
      });
      if (signal.aborted) throw new Error("终端创建已取消");
      return {
        shellPid,
        write: (data, binary) => {
          // onBinary is a byte string (legacy mouse encoding), never UTF-8 encode it.
          if (!closing && !exited) pty!.write(binary ? Buffer.from(data, "binary") : data);
        },
        resize: (cols, rows) => { if (!closing && !exited) pty!.resize(cols, rows); },
        setPriority: (focused) => {
          if (!closing && !exited) {
            try { setPriority(pty!.pid, focused ? constants.priority.PRIORITY_NORMAL : constants.priority.PRIORITY_BELOW_NORMAL); }
            catch { /* process may have just exited */ }
          }
        },
        pause: () => { if (!closing && !exited) pty!.pause(); },
        resume: () => { if (!closing && !exited) pty!.resume(); },
        close: stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
