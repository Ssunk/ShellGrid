import type { PaneLaunchInfo } from "./types";
import { writeTerminal } from "./terminalRegistry";

interface ClientCallbacks {
  onCreated(paneId: string, sessionId: string): void;
  onExit(paneId: string, exitCode: number): void;
  onError(paneId: string | undefined, message: string): void;
  onDisconnected(): void;
}

interface ControlMessage {
  type: string;
  requestId?: string;
  paneId?: string;
  sessionId?: string;
  exitCode?: number;
  message?: string;
}

interface OutputQueue {
  chunks: Uint8Array[];
  timer?: number;
}

export class TerminalClient {
  private socket?: WebSocket;
  private connected?: Promise<void>;
  private sessions = new Map<string, string>();
  private panesBySession = new Map<string, string>();
  private requests = new Map<string, string>();
  private queues = new Map<string, OutputQueue>();
  private pendingOutput = new Map<string, Uint8Array[]>();
  private pendingResize = new Map<string, { cols: number; rows: number }>();
  private focusedPane?: string;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly callbacks: ClientCallbacks,
  ) {}

  connect(): Promise<void> {
    if (this.connected) return this.connected;
    this.connected = new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.url}?token=${encodeURIComponent(this.token)}`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("无法连接本机终端服务"));
      socket.onmessage = (event) => this.receive(event.data as string | ArrayBuffer);
      socket.onclose = () => this.handleDisconnect(socket);
      this.socket = socket;
    });
    return this.connected;
  }

  // 连接断开后清空全部会话状态：后端会在下一个连接建立时回收旧会话，
  // 这里同步丢弃映射、未完成请求和批处理队列，让每个窗格可以重新创建会话。
  private handleDisconnect(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.connected = undefined;
    this.sessions.clear();
    this.panesBySession.clear();
    this.requests.clear();
    this.pendingOutput.clear();
    this.pendingResize.clear();
    for (const queue of this.queues.values()) {
      if (queue.timer !== undefined) window.clearTimeout(queue.timer);
    }
    this.queues.clear();
    this.callbacks.onDisconnected();
  }

  async create(paneId: string, launch: PaneLaunchInfo, cols: number, rows: number): Promise<void> {
    if (this.sessions.has(paneId) || [...this.requests.values()].includes(paneId)) return;
    await this.connect();
    const requestId = crypto.randomUUID();
    this.requests.set(requestId, paneId);
    this.sendJson({ type: "create", requestId, paneId, ...launch, cols, rows });
  }

  input(paneId: string, data: string): void {
    const sessionId = this.sessions.get(paneId);
    if (!sessionId || this.socket?.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(data);
    const frame = new Uint8Array(17 + payload.length);
    frame[0] = 1;
    frame.set(uuidBytes(sessionId), 1);
    frame.set(payload, 17);
    this.socket.send(frame);
  }

  resize(paneId: string, cols: number, rows: number): void {
    const sessionId = this.sessions.get(paneId);
    if (sessionId) {
      this.sendJson({ type: "resize", sessionId, cols, rows });
    } else {
      // 会话尚未创建完成：先记住尺寸，待 created 后补发。否则窗格创建早期 fit 得到的
      // 真实行列会因 sessionId 缺失被丢弃，PTY 停留在 create 时的默认尺寸，里面的
      // shell/agent 会按错误行列绘制而错位。
      this.pendingResize.set(paneId, { cols, rows });
    }
  }

  focus(paneId: string): void {
    if (this.focusedPane === paneId) return;
    const previous = this.focusedPane && this.sessions.get(this.focusedPane);
    if (previous) this.sendJson({ type: "set_priority", sessionId: previous, focused: false });
    this.focusedPane = paneId;
    const current = this.sessions.get(paneId);
    if (current) this.sendJson({ type: "set_priority", sessionId: current, focused: true });
  }

  closePane(paneId: string): void {
    const sessionId = this.sessions.get(paneId);
    if (sessionId) {
      this.sendJson({ type: "close", sessionId });
      this.sessions.delete(paneId);
      this.panesBySession.delete(sessionId);
      this.pendingOutput.delete(sessionId);
    }
    const queue = this.queues.get(paneId);
    if (queue?.timer !== undefined) window.clearTimeout(queue.timer);
    this.queues.delete(paneId);
    this.pendingResize.delete(paneId);
  }

  isRunning(paneId: string): boolean {
    return this.sessions.has(paneId);
  }

  private sendJson(value: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private receive(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      const message = JSON.parse(data) as ControlMessage;
      if (message.type === "created" && message.requestId && message.sessionId && message.paneId) {
        this.requests.delete(message.requestId);
        this.sessions.set(message.paneId, message.sessionId);
        this.panesBySession.set(message.sessionId, message.paneId);
        this.callbacks.onCreated(message.paneId, message.sessionId);
        // 补发创建期间被缓存的尺寸，纠正 PTY 行列，避免新窗格里的 shell/agent 错位。
        const size = this.pendingResize.get(message.paneId);
        if (size) {
          this.pendingResize.delete(message.paneId);
          this.sendJson({ type: "resize", sessionId: message.sessionId, cols: size.cols, rows: size.rows });
        }
        const pending = this.pendingOutput.get(message.sessionId);
        if (pending) {
          this.pendingOutput.delete(message.sessionId);
          for (const chunk of pending) this.enqueue(message.paneId, chunk);
        }
      } else if (message.type === "exit" && message.sessionId) {
        this.pendingOutput.delete(message.sessionId);
        const paneId = this.panesBySession.get(message.sessionId);
        if (paneId) {
          this.sessions.delete(paneId);
          this.panesBySession.delete(message.sessionId);
          this.callbacks.onExit(paneId, message.exitCode ?? 0);
        }
      } else if (message.type === "error") {
        if (message.sessionId) this.pendingOutput.delete(message.sessionId);
        const paneId = message.sessionId ? this.panesBySession.get(message.sessionId) : undefined;
        if (message.requestId) this.requests.delete(message.requestId);
        this.callbacks.onError(paneId, message.message ?? "终端服务发生未知错误");
      }
      return;
    }
    const frame = new Uint8Array(data);
    if (frame.length < 17 || frame[0] !== 2) return;
    const sessionId = bytesUuid(frame.subarray(1, 17));
    const paneId = this.panesBySession.get(sessionId);
    if (paneId) {
      this.enqueue(paneId, frame.slice(17));
    } else {
      const pending = this.pendingOutput.get(sessionId) ?? [];
      if (pending.length < 64) pending.push(frame.slice(17));
      this.pendingOutput.set(sessionId, pending);
    }
  }

  private enqueue(paneId: string, chunk: Uint8Array): void {
    const queue = this.queues.get(paneId) ?? { chunks: [] };
    queue.chunks.push(chunk);
    if (queue.timer === undefined) {
      const delay = paneId === this.focusedPane ? 8 : 33;
      queue.timer = window.setTimeout(() => this.flush(paneId), delay);
    }
    this.queues.set(paneId, queue);
  }

  private flush(paneId: string): void {
    const queue = this.queues.get(paneId);
    if (!queue) return;
    queue.timer = undefined;
    let size = 0;
    const selected: Uint8Array[] = [];
    while (queue.chunks.length > 0 && size + queue.chunks[0].length <= 64 * 1024) {
      const chunk = queue.chunks.shift()!;
      selected.push(chunk);
      size += chunk.length;
    }
    if (selected.length === 0 && queue.chunks.length > 0) {
      selected.push(queue.chunks.shift()!);
      size = selected[0].length;
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of selected) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    writeTerminal(paneId, output);
    if (queue.chunks.length > 0) {
      queue.timer = window.setTimeout(() => this.flush(paneId), paneId === this.focusedPane ? 8 : 33);
    }
  }
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function bytesUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
