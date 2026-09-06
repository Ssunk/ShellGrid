import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./run.mjs";

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) throw new Error("Installer upgrade verification expects a release semver");
const next = match[1] + "." + match[2] + "." + (Number(match[3]) + 1);
await run(process.execPath, [
  join(root, "node_modules", "electron-builder", "cli.js"),
  "--win", "nsis", "msi", "--x64", "--publish", "never",
  "--config.extraMetadata.version=" + next,
  "--config.directories.output=" + join(root, "artifacts", "upgrade-packages"),
]);
