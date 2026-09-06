import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./run.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 is required");
const directory = join(root, "artifacts", "benchmark-" + Date.now());
await mkdir(directory, { recursive: true });
const script = join(directory, "benchmark.cjs");
await build({ absWorkingDir: root, entryPoints: ["tests/windows/benchmark.ts"], outfile: script,
  bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"] });
const results = [];
for (const panes of [1, 4, 16]) {
  const sampleDirectory = join(directory, String(panes));
  await mkdir(sampleDirectory);
  const env = { ...process.env, LOCALAPPDATA: join(sampleDirectory, "localappdata"),
    SHELLGRID_TEST_DIRECTORY: sampleDirectory, SHELLGRID_BENCH_PANES: String(panes) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.SHELLGRID_DEV_URL;
  const child = spawn(electron, [script], { cwd: root, env, stdio: "ignore", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 150_000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  clearTimeout(timeout);
  if (code !== 0) throw new Error("Benchmark " + panes + " failed; see " + sampleDirectory);
  results.push(JSON.parse(await readFile(join(sampleDirectory, "benchmark.json"), "utf8")));
  console.log("Measured " + panes + " panes");
}
await writeFile(join(root, "artifacts", "windows-benchmark.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log("Report: artifacts/windows-benchmark.json");
