import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./run.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 is required");
const directory = join(root, "artifacts", "windows-" + Date.now());
await mkdir(directory, { recursive: true });
const uiOnly = process.argv.includes("--ui-only");
const visible = process.argv.includes("--visible");
const selected = uiOnly ? ["ui-smoke"] : process.argv.includes("--host-only") ? ["host-smoke", "worker-lifecycle"] : ["host-smoke", "worker-lifecycle", "ui-smoke"];
await build({
  absWorkingDir: root, entryPoints: selected.map((name) => "tests/windows/" + name + ".ts"),
  outdir: join(directory, "code"), outExtension: { ".js": ".cjs" }, platform: "node", format: "cjs",
  target: "node24", bundle: true, external: ["electron", "node-pty", "@xterm/headless"],
});
const env = { ...process.env, SHELLGRID_TEST_DIRECTORY: directory, LOCALAPPDATA: join(directory, "localappdata"),
  SHELLGRID_TEST_VISIBLE: visible ? "1" : "0" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SHELLGRID_DEV_URL;
if (process.argv.includes("--packaged")) {
  const resources = join(root, "release", "win-unpacked", "resources");
  env.SHELLGRID_TEST_RESOURCES = resources;
  env.SHELLGRID_TEST_HOST_PATH = join(resources, "app.asar.unpacked", "dist-electron", "pty-host.cjs");
}
function child(name) {
  return spawn(electron, [join(directory, "code", name + ".cjs")], { cwd: root, env, windowsHide: !visible, stdio: "ignore" });
}
async function runChild(name, timeout = 180_000) {
  const process = child(name);
  const timer = setTimeout(() => process.kill(), timeout);
  const code = await new Promise((resolve, reject) => { process.once("exit", resolve); process.once("error", reject); });
  clearTimeout(timer);
  if (code !== 0) throw new Error(name + " failed; see " + directory);
}
if (uiOnly) {
  await runChild("ui-smoke");
  console.log("PASS: desktop UI; report " + join(directory, "ui-report.json"));
  process.exit(0);
}
await runChild("host-smoke");
const report = { date: new Date().toISOString(), electron: "42.8.1", nodePty: "1.2.0-beta.15", host: JSON.parse(await readFile(join(directory, "host-report.json"), "utf8")) };
console.log("PASS: Windows ConPTY lifecycle and flow control");
if (!process.argv.includes("--host-only")) {
  await runChild("ui-smoke");
  report.ui = JSON.parse(await readFile(join(directory, "ui-report.json"), "utf8"));
  console.log("PASS: sandboxed renderer, IPC, stable panes and window close");
}
const reportName = visible ? "windows-verification-visible.json" : "windows-verification.json";
await writeFile(join(root, "artifacts", reportName), JSON.stringify(report, null, 2));
console.log("Report: artifacts/" + reportName);
