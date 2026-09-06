import type { PaneLaunchInfo } from "./types";
import type { SessionProxy } from "./proxy";
import type { TerminalBridge } from "../../shared/desktop";
import { ACK_CHARS, MAX_INPUT_CHARS, validEvent, type ConnectionInfo, type TerminalCommand } from "../../shared/protocol";
import { configureTerminals, writeTerminal } from "./terminalRegistry";

interface ClientCallbacks {
  onCreated(paneId: string, sessionId: string): void;
  onExit(paneId: string, exitCode: number): void;
  onError(paneId: string | undefined, message: string): void;
  onDisconnected(): void;
}
interface Request { id: string; paneId: string; sent: boolean }
interface Session {
  paneId: string;
  id: string;
  pendingWrites: number;
  consumed: number;
  exitCode?: number;
}
export class TerminalClient {
  private connection?: Promise<void>;
  private info?: ConnectionInfo;
  private epoch = 0;
  private disposed = false;
  private sessions = new Map<string, Session>();
  private panesBySession = new Map<string, Session>();
  private requests = new Map<string, Request>();
  private requestByPane = new Map<string, Request>();
  private pendingResize = new Map<string, { cols: number; rows: number }>();
  private focusedPane?: string;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly bridge: TerminalBridge, private readonly callbacks: ClientCallbacks) {
    this.unsubscribe = [
      bridge.onEvent((event) => this.receive(event)),
      bridge.onDisconnected(() => this.disconnected()),
    ];
  }
  connect(): Promise<void> {
    if (this.connection) return this.connection;
    const epoch = this.epoch;
    const connecting = this.bridge.connect().then((info) => {
      if (this.disposed || this.epoch !== epoch) throw new Error("终端连接已过期");
      this.info = info;
      configureTerminals(info.windowsPty);
    }).catch((error: unknown) => {
      if (this.epoch === epoch) this.disconnected();
      throw error;
    });
    this.connection = connecting;
    return connecting;
  }
  private disconnected(): void {
    if (this.disposed) return;
    this.epoch++;
    this.info = undefined;
    this.connection = undefined;
    this.sessions.clear(); this.panesBySession.clear();
    this.requests.clear(); this.requestByPane.clear(); this.pendingResize.clear();
    this.callbacks.onDisconnected();
  }
  async create(paneId: string, launch: PaneLaunchInfo, cols: number, rows: number, proxy?: SessionProxy): Promise<void> {
    if (this.disposed || this.sessions.has(paneId) || this.requestByPane.has(paneId)) return;
    // Reserve before awaiting connect: concurrent mounts cannot create two shells.
    const request: Request = { id: crypto.randomUUID(), paneId, sent: false };
    this.requests.set(request.id, request);
    this.requestByPane.set(paneId, request);
    await this.connect().catch(() => {});
    if (!this.info || this.requests.get(request.id) !== request) return;
    request.sent = true;
    const size = this.pendingResize.get(paneId) ?? { cols, rows };
    this.send({
      type: "create", generation: this.info.generation, requestId: request.id, paneId,
      launch, ...size, focused: this.focusedPane === paneId, proxy,
    });
  }
  input(paneId: string, data: string, binary = false): void {
    const session = this.sessions.get(paneId);
    if (!session || session.exitCode !== undefined || !this.info) return;
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + MAX_INPUT_CHARS);
      if (!binary && end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      this.send({ type: "input", generation: this.info.generation, sessionId: session.id, data: data.slice(offset, end), binary });
      offset = end;
    }
  }
  resize(paneId: string, cols: number, rows: number): void {
    const session = this.sessions.get(paneId);
    if (session && this.info) this.send({ type: "resize", generation: this.info.generation, sessionId: session.id, cols, rows });
    else this.pendingResize.set(paneId, { cols, rows });
  }
  focus(paneId: string): void {
    if (this.focusedPane === paneId) return;
    const previous = this.focusedPane && this.sessions.get(this.focusedPane);
    if (previous && this.info) this.send({ type: "setPriority", generation: this.info.generation, sessionId: previous.id, focused: false });
    this.focusedPane = paneId;
    const current = this.sessions.get(paneId);
    if (current && this.info) this.send({ type: "setPriority", generation: this.info.generation, sessionId: current.id, focused: true });
  }
  closePane(paneId: string): void {
    const pending = this.requestByPane.get(paneId);
    if (pending) {
      if (pending.sent && this.info) this.send({ type: "close", generation: this.info.generation, requestId: pending.id });
      this.requests.delete(pending.id); this.requestByPane.delete(paneId);
    }
    const session = this.sessions.get(paneId);
    if (session) {
      if (this.info) this.send({ type: "close", generation: this.info.generation, sessionId: session.id });
      this.sessions.delete(paneId); this.panesBySession.delete(session.id);
    }
    this.pendingResize.delete(paneId);
  }
  isRunning(paneId: string): boolean { return this.sessions.has(paneId); }
  private send(command: TerminalCommand): void { if (this.info && !this.disposed) this.bridge.send(command); }
  private receive(value: unknown): void {
    if (!validEvent(value) || !this.info || value.generation !== this.info.generation) return;
    const event = value;
    if (event.type === "created") {
      const request = this.requests.get(event.requestId);
      if (!request || request.paneId !== event.paneId || this.requestByPane.get(event.paneId) !== request) {
        this.send({ type: "close", generation: event.generation, sessionId: event.sessionId });
        return;
      }
      this.requests.delete(event.requestId); this.requestByPane.delete(event.paneId);
      const session: Session = { paneId: event.paneId, id: event.sessionId, pendingWrites: 0, consumed: 0 };
      this.sessions.set(event.paneId, session); this.panesBySession.set(session.id, session);
      const size = this.pendingResize.get(event.paneId);
      this.pendingResize.delete(event.paneId);
      if (size) this.send({ type: "resize", generation: event.generation, sessionId: session.id, ...size });
      this.send({ type: "setPriority", generation: event.generation, sessionId: session.id, focused: this.focusedPane === event.paneId });
      this.callbacks.onCreated(event.paneId, session.id);
    } else if (event.type === "data") {
      const session = this.panesBySession.get(event.sessionId);
      if (!session) return;
      session.pendingWrites++;
      const accepted = writeTerminal(session.paneId, event.data, () => {
        session.pendingWrites--;
        if (this.panesBySession.get(session.id) !== session || this.info?.generation !== event.generation) return;
        session.consumed += event.data.length;
        while (session.consumed >= ACK_CHARS) {
          this.send({ type: "ack", generation: event.generation, sessionId: session.id, chars: ACK_CHARS });
          session.consumed -= ACK_CHARS;
        }
        this.finishExit(session);
      });
      if (!accepted) {
        this.closePane(session.paneId);
        this.callbacks.onError(session.paneId, "终端显示实例不存在，会话已关闭");
      }
    } else if (event.type === "exit") {
      const session = this.panesBySession.get(event.sessionId);
      if (!session) return;
      session.exitCode = event.exitCode;
      this.finishExit(session);
    } else {
      const request = event.requestId ? this.requests.get(event.requestId) : undefined;
      if (event.requestId && !request) return;
      const paneId = request?.paneId ?? (event.sessionId ? this.panesBySession.get(event.sessionId)?.paneId : undefined);
      if (event.sessionId && !paneId) return;
      if (request) { this.requests.delete(request.id); this.requestByPane.delete(request.paneId); }
      if (event.sessionId && paneId) this.closePane(paneId);
      this.callbacks.onError(paneId, event.message);
    }
  }
  private finishExit(session: Session): void {
    if (session.exitCode === undefined || session.pendingWrites !== 0) return;
    if (session.consumed && this.info) this.send({ type: "ack", generation: this.info.generation, sessionId: session.id, chars: session.consumed });
    this.sessions.delete(session.paneId); this.panesBySession.delete(session.id);
    this.callbacks.onExit(session.paneId, session.exitCode);
  }
  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.bridge.disconnect();
    this.sessions.clear(); this.panesBySession.clear(); this.requests.clear(); this.requestByPane.clear();
  }
}
