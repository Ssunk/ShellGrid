import { run, npmCli } from "./run.mjs";

await run(process.execPath, [npmCli, "run", "build:web"]);
await import("./build-electron.mjs");
