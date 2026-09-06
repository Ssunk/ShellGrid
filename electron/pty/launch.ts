import type { CreateCommand } from "../../shared/protocol";

// Only reports cwd. User profiles still load before this prompt wrapper.
export const SHELL_INTEGRATION = "$global:__ShellGridOriginalPrompt=$function:prompt; function global:prompt { try { [Console]::Write(\"" + "\x60" + "e]9;9;$((Get-Location).Path)" + "\x60" + "e\\\") } catch {}; & $global:__ShellGridOriginalPrompt }";
export function shellArguments(shell: string, args: string[]): string[] {
  const name = shell.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  if ((name !== "pwsh" && name !== "pwsh.exe") || args.some((arg) =>
    /^-(command|c|encodedcommand|enc|e|file|f|commandwithargs)$/i.test(arg))) return [...args];
  return [...args, "-NoExit", "-Command", SHELL_INTEGRATION];
}
export function sessionEnvironment(command: CreateCommand, base = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ShellGrid" };
  // Electron-only switches must not change Node CLI behavior inside PowerShell.
  for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ASAR|NODE_OPTIONS)$/i.test(key)) delete env[key];
  if (command.proxy) {
    const proxy = command.proxy.url.trim();
    for (const key of Object.keys(env)) if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) delete env[key];
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = proxy;
    if (command.proxy.noProxy?.trim()) {
      env.NO_PROXY = command.proxy.noProxy.trim();
    }
  }
  return env;
}
