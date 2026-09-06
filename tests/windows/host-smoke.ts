import { app, utilityProcess } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { HostFixture } from "./host-fixture";
import { alive, check, delay, priorityClass, psQuote, pwsh, until } from "./helpers";

const results: string[] = [];
const testRoot = process.env.SHELLGRID_TEST_DIRECTORY!;
let host: HostFixture | undefined;
async function test(): Promise<void> {
  await app.whenReady();
  await mkdir(testRoot, { recursive: true });
  const shell = await pwsh();
  host = new HostFixture();
  await host.start();
  const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 10_000, allowProposedApi: true, logLevel: "off",
    windowsPty: { backend: "conpty", buildNumber: 21376 } });
  let received = 0, consumed = 0, acknowledged = 0, hold = true;
  let outputSession = "";
  host.listener = (event) => {
    if (event.type !== "data") return;
    outputSession = event.sessionId;
    received += event.data.length;
    terminal.write(event.data, () => {
      consumed += event.data.length;
      if (!hold && consumed > acknowledged) {
        host!.send({ type: "ack", generation: 1, sessionId: event.sessionId, chars: consumed - acknowledged });
        acknowledged = consumed;
      }
    });
  };
  const output = host.create(shell, testRoot, ["-NoLogo", "-NoProfile", "-Command",
    "for($i=0;$i -lt 18000;$i++){[Console]::WriteLine(('SEQ-{0:D5}' -f $i))};[Console]::Write('OUTPUT-END');exit 7"]);
  const outputCreated = await host.created(output);
  await until(() => received > 100_000, "real PTY flow high watermark", 30_000);
  await delay(350);
  const pausedAt = received;
  await delay(350);
  check(received === pausedAt, "PTY output did not pause under backpressure");
  check(received < 512_000, "Unacknowledged output exceeded bounded buffering");
  hold = false;
  if (consumed > acknowledged) {
    host.send({ type: "ack", generation: 1, sessionId: outputSession, chars: consumed - acknowledged });
    acknowledged = consumed;
  }
  await until(() => host!.events.some((event) => event.type === "exit" && event.sessionId === outputCreated.sessionId), "tail output and exit", 40_000);
  await new Promise<void>((resolveWrite) => terminal.write("", resolveWrite));
  const lines = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)!.translateToString(true));
  check(lines.some((line) => line.includes("OUTPUT-END")), "Tail output missing after normal exit");
  const sequence = lines.filter((line) => /^SEQ-\d{5}$/.test(line)).map((line) => Number(line.slice(4)));
  check(sequence.length > 9900 && sequence.at(-1) === 17999, "Output scrollback incomplete");
  check(sequence.every((value, index) => index === 0 || value === sequence[index - 1] + 1), "Output order changed");
  check(host.events.some((event) => event.type === "exit" && event.sessionId === outputCreated.sessionId && event.exitCode === 7), "Incorrect exit code");
  await until(() => !alive(outputCreated.shellPid), "normal exit closes PowerShell");
  terminal.dispose();
  results.push("real ConPTY output ordering, tail, pause/resume and normal exit");

  // Canceled creation never publishes a session.
  host.listener = (event) => { if (event.type === "data") host!.send({ type: "ack", generation: 1, sessionId: event.sessionId, chars: event.data.length }); };
  const canceled = Array.from({ length: 8 }, () => {
    const request = host!.create(shell, testRoot, ["-NoLogo", "-NoProfile"]);
    host!.send({ type: "close", generation: 1, requestId: request.requestId });
    return request.requestId;
  });
  await delay(1000);
  check(!host.events.some((event) => event.type === "created" && canceled.includes(event.requestId)), "Canceled creation published a session");
  const failed = host.create(join(testRoot, "missing-pwsh.exe"), testRoot, []);
  await until(() => host!.events.some((event) => event.type === "error" && event.requestId === failed.requestId), "startup failure");
  results.push("cancel during creation and failed executable startup");

  // Ctrl+C must interrupt the foreground command without terminating the Shell.
  let observed = "";
  let interactiveId = "";
  const interactiveScreen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true, logLevel: "off",
    windowsPty: { backend: "conpty", buildNumber: 21376 } });
  interactiveScreen.onData((data) => {
    if (interactiveId) host!.send({ type: "input", generation: 1, sessionId: interactiveId, data, binary: false });
  });
  host.listener = (event) => {
    if (event.type === "created") { interactiveId = event.sessionId; return; }
    if (event.type !== "data") return;
    observed += event.data;
    interactiveScreen.write(event.data, () => {
      host!.send({ type: "ack", generation: 1, sessionId: event.sessionId, chars: event.data.length });
    });
  };
  const interactive = await host.created(host.create(shell, testRoot, ["-NoLogo", "-NoProfile"]));
  await until(() => observed.includes("9;9;"), "interactive prompt integration");
  observed = "";
  host.send({ type: "input", generation: 1, sessionId: interactive.sessionId, binary: false,
    data: "[Console]::Write('BEGIN-SLEEP'); Start-Sleep -Seconds 60\r" });
  await until(() => observed.includes("BEGIN-SLEEP"), "foreground command started");
  await delay(300);
  host.send({ type: "input", generation: 1, sessionId: interactive.sessionId, binary: false, data: "\x03" });
  await delay(300);
  observed = "";
  host.send({ type: "input", generation: 1, sessionId: interactive.sessionId, binary: false,
    data: "[Console]::Write(('CTRL'+'-ALIVE'))\r" });
  await until(() => observed.includes("CTRL-ALIVE"), "PowerShell survives Ctrl+C");
  check(alive(interactive.shellPid), "Ctrl+C killed PowerShell");
  interactiveScreen.resize(132, 44);
  host.send({ type: "resize", generation: 1, sessionId: interactive.sessionId, cols: 132, rows: 44 });
  await delay(150);
  observed = "";
  const sizePath = join(testRoot, "console-size.txt");
  host.send({ type: "input", generation: 1, sessionId: interactive.sessionId, binary: false,
    data: "[IO.File]::WriteAllText(" + psQuote(sizePath) + ",('{0},{1}' -f [Console]::WindowWidth,[Console]::WindowHeight))\r" });
  await until(async () => (await readFile(sizePath, "utf8").catch(() => "")) === "132,44", "live ConPTY resize");
  host.send({ type: "setPriority", generation: 1, sessionId: interactive.sessionId, focused: false });
  await until(async () => await priorityClass(interactive.shellPid) === "BelowNormal", "background Shell priority");
  host.send({ type: "setPriority", generation: 1, sessionId: interactive.sessionId, focused: true });
  await until(async () => await priorityClass(interactive.shellPid) === "Normal", "foreground Shell priority");
  host.send({ type: "close", generation: 1, sessionId: interactive.sessionId });
  await until(() => !alive(interactive.shellPid), "pane close closes shell");
  interactiveScreen.dispose();
  results.push("Ctrl+C, cwd-only integration, actual dimensions, resize and real Shell PID priority");

  host = new HostFixture(); await host.start();
  host.listener = (event) => { if (event.type === "data") host!.send({ type: "ack", generation: 1, sessionId: event.sessionId, chars: event.data.length }); };
  const requests = Array.from({ length: 16 }, () => host!.create(shell, testRoot, ["-NoLogo", "-NoProfile"]));
  const concurrent = await Promise.all(requests.map((request) => host!.created(request)));
  check(new Set(concurrent.map((event) => event.shellPid)).size === 16, "Concurrent sessions share a shell");
  await host.stop();
  await until(() => concurrent.every((event) => !alive(event.shellPid)), "16 session cleanup");
  results.push("16 independent sessions and complete host shutdown");
  const resourceHost = utilityProcess.fork(join(__dirname, "worker-lifecycle.cjs"), [], { stdio: "ignore" });
  let resourceResult: { ok: boolean; before?: Record<string, number>; after?: Record<string, number> } | undefined;
  let resourceExited = false;
  resourceHost.once("exit", () => { resourceExited = true; });
  resourceHost.on("message", (message) => { if (message.type === "result") resourceResult = message; });
  resourceHost.once("spawn", () => resourceHost.postMessage({
    shell, cwd: testRoot,
  }));
  try {
    await until(() => !!resourceResult || resourceExited, "repeated natural-exit resource cleanup", 30_000);
    check(resourceResult?.ok, "node-pty leaked output workers or pipe handles across natural exits");
    resourceHost.postMessage({ type: "stop" });
    await until(() => resourceExited, "resource regression Host shutdown");
  } finally { if (!resourceExited) resourceHost.kill(); }
  results.push("repeated natural exits release node-pty output workers and input pipe handles");
  await writeFile(join(testRoot, "host-report.json"), JSON.stringify({ passed: results, pausedAt, totalChars: received }, null, 2));
}
void test().then(() => app.exit(0)).catch(async (error: unknown) => {
  await host?.stop().catch(() => {});
  await writeFile(join(testRoot, "host-report.json"), JSON.stringify({
    passed: results, error: error instanceof Error ? error.message : "Windows host verification failed",
    eventTypes: host?.events.map((event) => event.type), hostGone: host?.gone, count: host?.count,
    hostExitCode: host?.exitCode, fatalReason: host?.fatalReason,
  }, null, 2));
  app.exit(1);
});
