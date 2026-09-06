import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./run.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 is required");
const directory = join(root, "artifacts", "windows-" + Date.now());
await mkdir(directory, { recursive: true });
const uiOnly = process.argv.includes("--ui-only");
const selected = uiOnly ? ["ui-smoke"] : process.argv.includes("--host-only") ? ["host-smoke", "worker-lifecycle"] : ["host-smoke", "worker-lifecycle", "crash-main", "ui-smoke"];
await build({
  absWorkingDir: root, entryPoints: selected.map((name) => "tests/windows/" + name + ".ts"),
  outdir: join(directory, "code"), outExtension: { ".js": ".cjs" }, platform: "node", format: "cjs",
  target: "node24", bundle: true, external: ["electron", "node-pty", "@xterm/headless"],
});
const env = { ...process.env, SHELLGRID_TEST_DIRECTORY: directory, LOCALAPPDATA: join(directory, "localappdata") };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SHELLGRID_DEV_URL;
if (process.argv.includes("--packaged")) {
  const resources = join(root, "release", "win-unpacked", "resources");
  env.SHELLGRID_TEST_RESOURCES = resources;
  env.SHELLGRID_TEST_HOST_PATH = join(resources, "app.asar.unpacked", "dist-electron", "pty-host.cjs");
  env.SHELLGRID_TEST_LAUNCHER_PATH = join(resources, "bin", "shellgrid-launcher.exe");
}
function child(name) {
  return spawn(electron, [join(directory, "code", name + ".cjs")], { cwd: root, env, windowsHide: true, stdio: "ignore" });
}
async function runChild(name, timeout = 180_000) {
  const process = child(name);
  const timer = setTimeout(() => process.kill(), timeout);
  const code = await new Promise((resolve, reject) => { process.once("exit", resolve); process.once("error", reject); });
  clearTimeout(timer);
  if (code !== 0) throw new Error(name + " failed; see " + directory);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
if (uiOnly) {
  await runChild("ui-smoke");
  console.log("PASS: desktop UI; report " + join(directory, "ui-report.json"));
  process.exit(0);
}
await runChild("host-smoke");
const report = { date: new Date().toISOString(), electron: "42.8.1", nodePty: "1.2.0-beta.15", host: JSON.parse(await readFile(join(directory, "host-report.json"), "utf8")) };
console.log("PASS: Windows ConPTY lifecycle and flow control");
if (!process.argv.includes("--host-only")) {
  const main = child("crash-main");
  let ready;
  const deadline = Date.now() + 30_000;
  while (!ready) {
    try { ready = JSON.parse(await readFile(join(directory, "crash-ready.json"), "utf8")); } catch { /* wait for isolated startup */ }
    if (Date.now() > deadline || main.exitCode !== null) { main.kill(); throw new Error("Crash fixture failed to start"); }
    await delay(50);
  }
  main.kill();
  const cleanupDeadline = Date.now() + 8000;
  while (ready.pids.some(alive) && Date.now() < cleanupDeadline) await delay(50);
  if (ready.pids.some(alive)) {
    // Only known fixture PIDs; never kill a process by executable name.
    for (const pid of [ready.hostPid, ...ready.pids]) if (alive(pid)) process.kill(pid);
    throw new Error("Forced main exit left fixture descendants alive");
  }
  report.mainCrash = "PowerShell and immediate Profile child reaped";
  console.log("PASS: forced Electron main termination");
  await runChild("ui-smoke");
  report.ui = JSON.parse(await readFile(join(directory, "ui-report.json"), "utf8"));
  console.log("PASS: sandboxed renderer, IPC, stable panes and window close");
}
await writeFile(join(root, "artifacts", "windows-verification.json"), JSON.stringify(report, null, 2));
console.log("Report: artifacts/windows-verification.json");
