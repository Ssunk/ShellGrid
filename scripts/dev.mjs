import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
import { root } from "./run.mjs";

await import("./build-electron.mjs");
const verifyUi = process.argv.includes("--test");
const env = { ...process.env, SHELLGRID_DEV_URL: "http://127.0.0.1:1420/" };
let entry = ".";
if (verifyUi) {
  const directory = join(root, "artifacts", "dev-ui-" + Date.now());
  await mkdir(directory, { recursive: true });
  entry = join(directory, "ui-smoke.cjs");
  await build({ absWorkingDir: root, entryPoints: ["tests/windows/ui-smoke.ts"], outfile: entry,
    bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"] });
  Object.assign(env, { LOCALAPPDATA: join(directory, "localappdata"),
    SHELLGRID_TEST_DIRECTORY: directory, SHELLGRID_TEST_VISIBLE: "1" });
  delete env.SHELLGRID_TEST_RESOURCES;
  console.log("Visible development UI verification; report: " + join(directory, "ui-report.json"));
}
const server = await createServer({ root });
await server.listen();
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [entry], { cwd: root, env, stdio: "inherit", windowsHide: false });
child.once("exit", async (code) => { await server.close(); process.exit(code ?? 0); });
process.once("SIGINT", () => { child.kill(); void server.close(); });
process.once("SIGTERM", () => { child.kill(); void server.close(); });
