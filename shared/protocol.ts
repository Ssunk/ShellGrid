import type { PaneLaunchInfo } from "../src/lib/types";
import type { SessionProxy } from "../src/lib/proxy";
import { isValidProxyUrl } from "../src/lib/proxy";

export const OUTPUT_BATCH_MS = 5;
export const FLOW_HIGH = 100_000;
export const FLOW_LOW = 5_000;
export const ACK_CHARS = 5_000;
export const MAX_INPUT_CHARS = 1_048_576;
export const MAX_SESSIONS = 16;

export interface ConnectionInfo {
  generation: number;
  windowsPty: { backend: "conpty"; buildNumber: number };
}
interface Envelope { generation: number }
export interface CreateCommand extends Envelope {
  type: "create";
  requestId: string;
  paneId: string;
  launch: PaneLaunchInfo;
  cols: number;
  rows: number;
  focused: boolean;
  proxy?: SessionProxy;
}
export type TerminalCommand =
  | CreateCommand
  | (Envelope & { type: "input"; sessionId: string; data: string; binary: boolean })
  | (Envelope & { type: "resize"; sessionId: string; cols: number; rows: number })
  | (Envelope & { type: "setPriority"; sessionId: string; focused: boolean })
  | (Envelope & { type: "ack"; sessionId: string; chars: number })
  | (Envelope & { type: "close"; sessionId: string })
  | (Envelope & { type: "close"; requestId: string });

export type TerminalEvent =
  | (Envelope & { type: "created"; requestId: string; paneId: string; sessionId: string; shellPid: number })
  | (Envelope & { type: "data"; sessionId: string; data: string })
  | (Envelope & { type: "exit"; sessionId: string; exitCode: number })
  | (Envelope & { type: "error"; requestId?: string; sessionId?: string; message: string });

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function textValue(value: unknown, limit = 32_767, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0)
    && value.length <= limit && !value.includes("\0");
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}
export function dimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 32_767;
}
export function validLaunch(value: unknown): value is PaneLaunchInfo {
  return record(value) && textValue(value.cwd) && textValue(value.shell)
    && (value.title === undefined || textValue(value.title, 32_767, true))
    && Array.isArray(value.args) && value.args.length <= 256
    && value.args.every((arg) => textValue(arg, 32_767, true))
    && value.args.reduce((sum: number, arg: string) => sum + arg.length + 3, 0) <= 30_000;
}
export function validCommand(value: unknown): value is TerminalCommand {
  if (!record(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) return false;
  if (value.type === "create") {
    return uuid(value.requestId) && textValue(value.paneId, 256) && validLaunch(value.launch)
      && dimension(value.cols) && dimension(value.rows) && typeof value.focused === "boolean"
      && (value.proxy === undefined || (record(value.proxy) && textValue(value.proxy.url, 4096)
        && isValidProxyUrl(value.proxy.url)
        && (value.proxy.noProxy === undefined || textValue(value.proxy.noProxy, 32_767, true))));
  }
  if (value.type === "close") return uuid(value.sessionId) !== uuid(value.requestId);
  if (!uuid(value.sessionId)) return false;
  switch (value.type) {
    case "input": return typeof value.data === "string" && value.data.length <= MAX_INPUT_CHARS && typeof value.binary === "boolean";
    case "resize": return dimension(value.cols) && dimension(value.rows);
    case "setPriority": return typeof value.focused === "boolean";
    case "ack": return Number.isSafeInteger(value.chars) && (value.chars as number) > 0 && (value.chars as number) <= 2 ** 31;
    default: return false;
  }
}
export function validEvent(value: unknown): value is TerminalEvent {
  if (!record(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) return false;
  switch (value.type) {
    case "created": return uuid(value.requestId) && textValue(value.paneId, 256) && uuid(value.sessionId)
      && Number.isSafeInteger(value.shellPid) && (value.shellPid as number) > 0;
    case "data": return uuid(value.sessionId) && typeof value.data === "string";
    case "exit": return uuid(value.sessionId) && Number.isInteger(value.exitCode);
    case "error": return textValue(value.message, 8192)
      && (value.requestId === undefined || uuid(value.requestId)) && (value.sessionId === undefined || uuid(value.sessionId));
    default: return false;
  }
}
