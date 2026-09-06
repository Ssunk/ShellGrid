import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
import { run, root } from "./run.mjs";

await import("./build-electron.mjs");
const server = await createServer({ root });
await server.listen();
const env = { ...process.env, SHELLGRID_DEV_URL: "http://127.0.0.1:1420/" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { cwd: root, env, stdio: "inherit", windowsHide: true });
child.once("exit", async (code) => { await server.close(); process.exit(code ?? 0); });
process.once("SIGINT", () => { child.kill(); void server.close(); });
process.once("SIGTERM", () => { child.kill(); void server.close(); });
