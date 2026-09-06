import { lstat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { release } from "node:os";
import type { EnvironmentStatus } from "../../src/lib/types";

async function exists(path: string): Promise<boolean> {
  return lstat(path).then((stat) => !stat.isDirectory(), () => false);
}
export async function findExecutable(name: string, installed: [string, string][] = []): Promise<string | null> {
  const candidates = installed.flatMap(([variable, relative]) => process.env[variable] ? [join(process.env[variable]!, relative)] : []);
  candidates.push(...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ""), name)));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}
export async function environment(): Promise<EnvironmentStatus> {
  const [pwshPath, gitPath] = await Promise.all([
    findExecutable("pwsh.exe", [["ProgramFiles", "PowerShell\\7\\pwsh.exe"], ["ProgramFiles(x86)", "PowerShell\\7\\pwsh.exe"], ["ProgramFiles", "PowerShell\\7-preview\\pwsh.exe"], ["LOCALAPPDATA", "Microsoft\\WindowsApps\\pwsh.exe"]]),
    findExecutable("git.exe", [["ProgramFiles", "Git\\cmd\\git.exe"], ["ProgramFiles(x86)", "Git\\cmd\\git.exe"], ["LOCALAPPDATA", "Programs\\Git\\cmd\\git.exe"]]),
  ]);
  const windowsBuild = Number(release().split(".")[2]) || 0;
  const windowsSupported = process.platform === "win32" && process.arch === "x64" && windowsBuild >= 18362;
  return {
    windowsSupported, windowsBuild, electronVersion: process.versions.electron ?? "",
    chromeVersion: process.versions.chrome ?? "", nodeVersion: process.versions.node,
    pwshAvailable: pwshPath !== null, pwshPath, gitAvailable: gitPath !== null, gitPath,
    message: !windowsSupported ? "ShellGrid 需要 Windows x64 10 1903 或更高版本"
      : !pwshPath ? "未找到 PowerShell 7（pwsh.exe），请先安装后重启应用" : null,
  };
}
