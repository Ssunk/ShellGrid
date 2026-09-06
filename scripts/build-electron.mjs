import { build } from "esbuild";
import { root } from "./run.mjs";

export async function buildElectron() {
  await build({
    absWorkingDir: root,
    entryPoints: ["electron/main.ts", "electron/preload.ts", "electron/pty-host.ts"],
    bundle: true, platform: "node", target: "node24", format: "cjs",
    outdir: "dist-electron", outExtension: { ".js": ".cjs" },
    external: ["electron", "node-pty"], logLevel: "info",
  });
}
await buildElectron();
