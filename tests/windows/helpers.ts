import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { findExecutable } from "../../electron/services/environment";

export { delay };
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await delay(30);
  }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function psQuote(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
export async function pwsh(): Promise<string> {
  const path = await findExecutable("pwsh.exe", [["ProgramFiles", "PowerShell\\7\\pwsh.exe"]]);
  if (!path) throw new Error("PowerShell 7 is required for Windows verification");
  return path;
}
export async function priorityClass(pid: number): Promise<string> {
  const result = await promisify(execFile)(await pwsh(), ["-NoLogo", "-NoProfile", "-Command",
    "(Get-Process -Id " + pid + ").PriorityClass"], { windowsHide: true });
  return result.stdout.trim();
}
