import { app } from "electron";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostFixture } from "./host-fixture";
import { check, readPids } from "./helpers";

const directory = process.env.SHELLGRID_TEST_DIRECTORY!;
void app.whenReady().then(async () => {
  const fixture = JSON.parse(await readFile(join(directory, "profile-fixture.json"), "utf8")) as { shell: string; pidPath: string };
  await rm(fixture.pidPath, { force: true });
  const host = new HostFixture();
  await host.start();
  host.listener = (event) => { if (event.type === "data") host.send({ type: "ack", generation: 1, sessionId: event.sessionId, chars: event.data.length }); };
  const session = await host.created(host.create(fixture.shell, directory, ["-NoLogo"]));
  const pids = await readPids(fixture.pidPath);
  check(pids[0] === session.shellPid, "Crash fixture PID mismatch");
  await writeFile(join(directory, "crash-ready.json"), JSON.stringify({ mainPid: process.pid, hostPid: host.host.pid, pids }));
}).catch(() => app.exit(1));
