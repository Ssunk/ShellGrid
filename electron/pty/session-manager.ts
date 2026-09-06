import { randomUUID } from "node:crypto";
import { FLOW_HIGH, FLOW_LOW, MAX_SESSIONS, OUTPUT_BATCH_MS, validCommand, type CreateCommand, type TerminalEvent } from "../../shared/protocol";

export interface ManagedPty {
  shellPid: number;
  write(data: string, binary: boolean): void;
  resize(cols: number, rows: number): void;
  setPriority(focused: boolean): void;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}
export interface PtyCallbacks {
  data(data: string): void;
  exit(exitCode: number): void;
}
export interface PtyFactory {
  create(command: CreateCommand, callbacks: PtyCallbacks, signal: AbortSignal): Promise<ManagedPty>;
}
interface Session {
  command: CreateCommand;
  id: string;
  abort: AbortController;
  pty?: ManagedPty;
  creation?: Promise<void>;
  chunks: string[];
  outstanding: number;
  sentOutstanding: number;
  paused: boolean;
  created: boolean;
  closed: boolean;
  exitCode?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private requests = new Map<string, Session>();
  private panes = new Map<string, Session>();
  private closing = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    readonly generation: number,
    private readonly factory: PtyFactory,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly countChanged: (count: number) => void = () => {},
  ) {}
  get size(): number { return this.sessions.size; }

  handle(value: unknown): void {
    if (this.stopped) return;
    if (!validCommand(value)) { this.error("终端消息格式无效"); return; }
    if (value.generation !== this.generation) return;
    if (value.type === "create") { this.create(value); return; }
    const state = "sessionId" in value ? this.sessions.get(value.sessionId) : this.requests.get(value.requestId);
    if (!state || state.closed) return;
    if (value.type === "close") { void this.close(state); return; }
    try {
      switch (value.type) {
        case "input": state.pty?.write(value.data, value.binary); break;
        case "resize":
          state.command.cols = value.cols; state.command.rows = value.rows;
          state.pty?.resize(value.cols, value.rows);
          break;
        case "setPriority":
          state.command.focused = value.focused;
          state.pty?.setPriority(value.focused);
          break;
        case "ack":
          if (value.chars > state.sentOutstanding) { this.error("终端消费确认无效", state); return; }
          state.sentOutstanding -= value.chars;
          state.outstanding -= value.chars;
          if (state.paused && state.outstanding < FLOW_LOW) {
            state.paused = false; state.pty?.resume();
          }
          break;
      }
    } catch { this.error("终端操作失败", state); }
  }
  private create(command: CreateCommand): void {
    if (this.requests.has(command.requestId) || this.panes.has(command.paneId)) {
      this.emit({ type: "error", generation: this.generation, requestId: command.requestId, message: "窗格已有正在创建或运行的会话" });
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      this.emit({ type: "error", generation: this.generation, requestId: command.requestId, message: "最多支持 16 个终端会话" });
      return;
    }
    const state: Session = {
      command: structuredClone(command), id: randomUUID(), abort: new AbortController(),
      chunks: [], outstanding: 0, sentOutstanding: 0, paused: false, created: false, closed: false,
    };
    this.sessions.set(state.id, state);
    this.requests.set(command.requestId, state);
    this.panes.set(command.paneId, state);
    this.countChanged(this.size);
    const previous = this.closing.get(command.paneId);
    state.creation = (async () => {
      if (previous) await previous;
      if (state.closed) return;
      try {
        const pty = await this.factory.create(state.command, {
          data: (data) => this.data(state, data),
          exit: (exitCode) => this.exit(state, exitCode),
        }, state.abort.signal);
        state.pty = pty;
        if (state.closed) { await pty.close(); return; }
        state.created = true;
        this.emit({ type: "created", generation: this.generation, requestId: command.requestId,
          paneId: command.paneId, sessionId: state.id, shellPid: pty.shellPid });
        if (state.paused) pty.pause();
        this.flush(state);
        pty.resize(state.command.cols, state.command.rows);
        pty.setPriority(state.command.focused);
        if (state.exitCode !== undefined) this.exit(state, state.exitCode);
      } catch {
        if (!state.closed) {
          this.error("无法启动终端，请检查启动目录和 PowerShell", state);
          // close asynchronously; it waits for this creation promise to settle.
          void this.close(state);
        }
      }
    })();
  }
  private data(state: Session, data: string): void {
    if (state.closed || !data.length) return;
    state.chunks.push(data);
    state.outstanding += data.length;
    if (!state.paused && state.outstanding > FLOW_HIGH) {
      state.paused = true; state.pty?.pause();
    }
    if (state.created && state.timer === undefined) {
      state.timer = setTimeout(() => this.flush(state), OUTPUT_BATCH_MS);
    }
  }
  private flush(state: Session): void {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.created || state.closed || !state.chunks.length) return;
    const data = state.chunks.join("");
    state.chunks = [];
    state.sentOutstanding += data.length;
    this.emit({ type: "data", generation: this.generation, sessionId: state.id, data });
  }
  private exit(state: Session, exitCode: number): void {
    if (state.closed) return;
    state.exitCode = exitCode;
    if (!state.created) return;
    this.flush(state);
    this.emit({ type: "exit", generation: this.generation, sessionId: state.id, exitCode });
    // node-pty onExit means the output pipe has drained. Renderer waits for the
    // corresponding xterm write callbacks before presenting this exit.
    this.remove(state);
  }
  private remove(state: Session): void {
    state.closed = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.chunks = [];
    this.sessions.delete(state.id);
    if (this.requests.get(state.command.requestId) === state) this.requests.delete(state.command.requestId);
    if (this.panes.get(state.command.paneId) === state) this.panes.delete(state.command.paneId);
    this.countChanged(this.size);
  }
  private close(state: Session): Promise<void> {
    if (state.closed) return this.closing.get(state.command.paneId) ?? Promise.resolve();
    this.remove(state);
    state.abort.abort();
    const closing = (async () => {
      await state.creation;
      await state.pty?.close();
    })();
    this.closing.set(state.command.paneId, closing);
    void closing.finally(() => {
      if (this.closing.get(state.command.paneId) === closing) this.closing.delete(state.command.paneId);
    });
    return closing;
  }
  private error(message: string, state?: Session): void {
    this.emit({ type: "error", generation: this.generation, message,
      ...(state?.created ? { sessionId: state.id } : state ? { requestId: state.command.requestId } : {}) });
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.sessions.values()].map((state) => this.close(state)));
    await Promise.allSettled([...this.closing.values()]);
  }
}
