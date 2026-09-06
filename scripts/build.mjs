import { run, npmCli } from "./run.mjs";

await run("cargo", ["build", "--release", "--locked", "--manifest-path", "native/launcher/Cargo.toml"]);
await run(process.execPath, [npmCli, "run", "build:web"]);
await import("./build-electron.mjs");
