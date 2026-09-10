import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, release, tmpdir, totalmem } from "node:os";
import type { LayoutNode, WorkspaceStateV1 } from "../../src/lib/types";
import type { ShellGridAPI } from "../../shared/desktop";
import { alive, check, delay, pwsh, until } from "./helpers";

const directory = process.env.SHELLGRID_TEST_DIRECTORY!;
const panes = Number(process.env.SHELLGRID_BENCH_PANES);
const visible = process.env.SHELLGRID_TEST_VISIBLE === "1";
let currentWindow: BrowserWindow;
let finished = false;
let shellPids: number[] = [];
let shellDirectory: string | undefined;
const started = Date.now();
function layout(ids: string[], depth = 0): LayoutNode {
  if (ids.length === 1) return { type: "pane", paneId: ids[0] };
  const middle = Math.ceil(ids.length / 2);
  return { type: "split", direction: depth % 2 ? "vertical" : "horizontal", ratio: 0.5,
    first: layout(ids.slice(0, middle), depth + 1), second: layout(ids.slice(middle), depth + 1) };
}
// Serialized into the real sandboxed renderer. No terminal text is returned or
// persisted; only lengths, known synthetic marker timings and session identity.
function rendererObserver() {
  const page = window as unknown as { shellgrid: ShellGridAPI; __sgBench: unknown };
  const state = {
    sessions: [] as { sessionId: string; shellPid: number; generation: number }[],
    pending: {} as Record<string, string>,
    buffers: {} as Record<string, string>,
    durations: [] as number[], chars: 0, start: 0,
    sentAt: {} as Record<string, number>, elapsedMs: 0, finishedChars: 0,
    arm(markers: Record<string, string>) {
      state.pending = markers; state.buffers = {}; state.durations = []; state.chars = 0; state.start = performance.now();
      state.sentAt = {}; state.elapsedMs = 0; state.finishedChars = 0;
    },
  };
  page.__sgBench = state;
  page.shellgrid.terminal.onEvent((event) => {
    if (event.type === "created") state.sessions.push(event);
    if (event.type !== "data") return;
    state.chars += event.data.length;
    if (!state.pending[event.sessionId]) return;
    const buffer = (state.buffers[event.sessionId] ?? "") + event.data;
    if (buffer.includes(state.pending[event.sessionId])) {
      const now = performance.now();
      state.durations.push(now - state.sentAt[event.sessionId]);
      state.elapsedMs = now - state.start;
      state.finishedChars = state.chars;
      delete state.pending[event.sessionId]; delete state.buffers[event.sessionId];
    } else state.buffers[event.sessionId] = buffer.slice(-1024);
  });
}
async function evaluate<T>(source: string): Promise<T> {
  return currentWindow.webContents.executeJavaScript(source, true) as Promise<T>;
}
async function processResources(shell: string) {
  const electron = app.getAppMetrics();
  const result = await promisify(execFile)(shell, ["-NoLogo", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object ProcessId -ne $PID | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const processes = JSON.parse(result.stdout || "[]") as { ProcessId: number; ParentProcessId: number; WorkingSetSize: string; KernelModeTime: string; UserModeTime: string }[];
  const electronPids = new Set(electron.map((metric) => metric.pid));
  const owned = new Set([...electronPids, ...shellPids]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of processes) if (owned.has(process.ParentProcessId) && !owned.has(process.ProcessId)) { owned.add(process.ProcessId); changed = true; }
  }
  const ptyProcesses = processes.filter((process) => owned.has(process.ProcessId) && !electronPids.has(process.ProcessId));
  return {
    electronWorkingSetMiB: electron.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0),
    electronCpuPercent: electron.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
    ptyWorkingSetMiB: ptyProcesses.reduce((sum, metric) => sum + Number(metric.WorkingSetSize) / 1024 ** 2, 0),
    ptyCpuSeconds: ptyProcesses.reduce((sum, metric) => sum + (Number(metric.KernelModeTime) + Number(metric.UserModeTime)) / 1e7, 0),
  };
}
async function batch(commands: string[], markers: string[]) {
  const sessions = await evaluate<{ sessionId: string; shellPid: number; generation: number }[]>("window.__sgBench.sessions");
  const expectations = Object.fromEntries(sessions.map((session, i) => [session.sessionId, markers[i]]));
  await evaluate("window.__sgBench.arm(" + JSON.stringify(expectations) + ");true");
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    await evaluate("window.__sgBench.sentAt[" + JSON.stringify(session.sessionId) + "]=performance.now();window.shellgrid.terminal.send(" + JSON.stringify({
      type: "input", generation: session.generation, sessionId: session.sessionId, data: commands[index] + "\r", binary: false,
    }) + ");true");
  }
  await until(() => evaluate<boolean>("Object.keys(window.__sgBench.pending).length===0"), "benchmark output", 60_000);
  await delay(100);
  return evaluate<{ durations: number[]; chars: number; elapsedMs: number }>("({durations:window.__sgBench.durations,chars:window.__sgBench.finishedChars,elapsedMs:window.__sgBench.elapsedMs})");
}
// Exercise actual pointer capture and ConPTY reflow with populated scrollback.
// DevTools metrics contain counts/timings only, never terminal contents.
async function measureDividerDrag() {
  if (panes === 1) return undefined;
  const contents = currentWindow.webContents;
  const bounds = await evaluate<{ x: number; y: number; left: number; width: number }>(`(() => {
    const divider = document.querySelector('.workspace > .split-root > .divider');
    const rect = divider.getBoundingClientRect();
    const parent = divider.parentElement.getBoundingClientRect();
    window.__sgDragSurfaces = Array.from(document.querySelectorAll('.terminal-surface'));
    window.__sgDragMoves = 0;
    divider.addEventListener('pointermove', () => window.__sgDragMoves++);
    window.__sgDragFrames = { intervals: [], previous: 0, request: 0 };
    const frames = window.__sgDragFrames;
    const frame = timestamp => {
      if (frames.previous) frames.intervals.push(timestamp - frames.previous);
      frames.previous = timestamp;
      frames.request = requestAnimationFrame(frame);
    };
    frames.request = requestAnimationFrame(frame);
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), left: parent.left, width: parent.width };
  })()`);
  contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Performance.enable");
  async function metrics(): Promise<Record<string, number>> {
    const result = await contents.debugger.sendCommand("Performance.getMetrics") as { metrics: { name: string; value: number }[] };
    return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  }
  const before = await metrics();
  const started = performance.now();
  contents.sendInputEvent({ type: "mouseMove", x: bounds.x, y: bounds.y });
  contents.sendInputEvent({ type: "mouseDown", x: bounds.x, y: bounds.y, button: "left", clickCount: 1 });
  const moves = 180;
  let x = bounds.x;
  for (let step = 0; step < moves; step++) {
    x = Math.round(bounds.left + bounds.width * (0.5 + 0.15 * Math.sin(step / (moves - 1) * Math.PI * 2)));
    contents.sendInputEvent({ type: "mouseMove", x, y: bounds.y, modifiers: ["leftbuttondown"] });
    await delay(8);
  }
  contents.sendInputEvent({ type: "mouseUp", x, y: bounds.y, button: "left", clickCount: 1 });
  await delay(250);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  const elapsedMs = performance.now() - started;
  const after = await metrics();
  const state = await evaluate<{
    deliveredMoves: number; stableTerminals: boolean; ratio: number;
    frameIntervalsMs: { samples: number; p50: number; p95: number; max: number; over50: number };
  }>(`(() => {
    cancelAnimationFrame(window.__sgDragFrames.request);
    const frames = window.__sgDragFrames.intervals.sort((a,b) => a-b);
    return {
      deliveredMoves: window.__sgDragMoves,
      stableTerminals: window.__sgDragSurfaces.every(el => el.isConnected),
      ratio: parseFloat(document.querySelector('.workspace > .split-root > .split-child').style.flexBasis) / 100,
      frameIntervalsMs: { samples: frames.length, p50: frames[Math.floor(frames.length * 0.5)] ?? 0,
        p95: frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] ?? 0,
        max: frames.at(-1) ?? 0, over50: frames.filter(ms => ms > 50).length }
    };
  })()`);
  check(state.deliveredMoves > 0 && state.stableTerminals && Math.abs(state.ratio - 0.5) < 0.01, "Divider drag did not preserve the terminals and final ratio");
  await contents.debugger.sendCommand("Performance.disable");
  contents.debugger.detach();
  return {
    method: "After 40000 output lines per pane: 180 native mouse moves requested at 8 ms intervals, sweeping the top divider from 35% to 65% and back to 50%; 250 ms and two animation frames settling. Native input can be coalesced (see deliveredMoves). Chromium Performance metrics and requestAnimationFrame intervals cover this whole phase, not input-to-paint latency.",
    moves, ...state, elapsedMs,
    layoutCount: after.LayoutCount - before.LayoutCount,
    layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    styleRecalcCount: after.RecalcStyleCount - before.RecalcStyleCount,
    styleRecalcMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
    taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
  };
}
async function test() {
  check([1, 4, 16].includes(panes), "Invalid pane benchmark count");
  const shell = await pwsh();
  // Keep the prompt length independent of the checkout/report path in A/B runs.
  shellDirectory = await mkdtemp(join(tmpdir(), "shellgrid-bench-"));
  const dataDirectory = join(process.env.LOCALAPPDATA!, "ShellGrid");
  await mkdir(dataDirectory, { recursive: true });
  const ids = Array.from({ length: panes }, (_, i) => "bench-" + i);
  const workspace: WorkspaceStateV1 = {
    schemaVersion: 1, rootPath: shellDirectory, layout: layout(ids),
    panes: Object.fromEntries(ids.map((id) => [id, { cwd: shellDirectory!, shell, args: ["-NoLogo", "-NoProfile"] }])),
  };
  await writeFile(join(dataDirectory, "workspace.json"), JSON.stringify(workspace));
  if (!visible) BrowserWindow.prototype.show = function () {};
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  dialog.showErrorBox = () => { void fail(new Error("Benchmark desktop initialization failed")); };
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.once("dom-ready", () => { void contents.executeJavaScript("(" + rendererObserver.toString() + ")()", true); });
  });
  require(resolve("dist-electron/main.cjs"));
  await until(() => BrowserWindow.getAllWindows().length > 0, "benchmark window");
  currentWindow = BrowserWindow.getAllWindows()[0];
  if (visible) {
    await until(() => currentWindow.isVisible(), "visible benchmark window");
    check(await evaluate("document.visibilityState === 'visible'"), "Benchmark renderer is hidden");
  }
  await until(() => evaluate<boolean>("Boolean(window.__sgBench) && window.__sgBench.sessions.length===" + panes +
    " && document.querySelectorAll('.session-status.running').length===" + panes).catch(() => false), "benchmark sessions", 40_000);
  shellPids = await evaluate<number[]>("window.__sgBench.sessions.map(s=>s.shellPid)");
  const startupMs = Date.now() - started;
  const warmMarkers = ids.map((_id, index) => "SGWARMP" + index);
  await batch(warmMarkers.map((marker) => "[Console]::Write(('SG'+'" + marker.slice(2) + "'))"), warmMarkers);
  app.getAppMetrics(); // Prime Electron CPU deltas before the idle interval.
  await delay(2000);
  const idle = await processResources(shell);
  const latency: number[] = [];
  for (let round = 0; round < 10; round++) {
    const markers = ids.map((_id, index) => "SGLAT" + round + "P" + index);
    const commands = markers.map((marker) => "[Console]::Write(('SG'+'" + marker.slice(2) + "'))");
    const result = await batch(commands, markers);
    latency.push(...result.durations);
  }
  const markers = ids.map((_id, index) => "SGENDP" + index);
  const commands = markers.map((marker) =>
    "for($i=0;$i -lt 40000;$i++){[Console]::WriteLine('0123456789012345678901234567890123456789')};[Console]::Write(('SG'+'" + marker.slice(2) + "'))");
  const beforeOutput = await processResources(shell);
  const samples: Awaited<ReturnType<typeof processResources>>[] = [];
  let sampling = false;
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void processResources(shell).then((sample) => samples.push(sample)).finally(() => { sampling = false; });
  }, 750);
  const throughput = await batch(commands, markers);
  clearInterval(timer);
  await until(() => !sampling, "resource sampler");
  samples.push(await processResources(shell));
  const dividerDrag = await measureDividerDrag();
  const sorted = latency.sort((a, b) => a - b);
  const elapsedMs = throughput.elapsedMs;
  const report = {
    paneCount: panes, windows: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, systemMemoryGiB: totalmem() / 1024 ** 3,
    electron: process.versions.electron, node: process.versions.node,
    build: "Electron release runtime + Vite production assets + direct node-pty ConPTY",
    windowMode: visible ? "visible" : "hidden",
    method: (visible ? "Visible" : "Hidden") + " real BrowserWindow; xterm consumes/ACKs output. Latency: renderer send to synthetic response arrival, 10 rounds per pane. 750 ms resource samples; Electron and PTY descendants (PowerShell, OpenConsole) working sets are separate. The resource sampler itself is excluded. PowerShell -NoProfile; no Agent CLI.",
    startupMs,
    latencyMs: { samples: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] },
    output: { chars: throughput.chars, elapsedMs, charsPerSecond: throughput.chars / elapsedMs * 1000, linesPerPane: 40000 },
    dividerDrag,
    idle, observedMax: {
      electronWorkingSetMiB: Math.max(...samples.map((sample) => sample.electronWorkingSetMiB)),
      ptyWorkingSetMiB: Math.max(...samples.map((sample) => sample.ptyWorkingSetMiB)),
      electronCpuPercent: Math.max(...samples.map((sample) => sample.electronCpuPercent)),
      ptyCpuSecondsDelta: samples.at(-1)!.ptyCpuSeconds - beforeOutput.ptyCpuSeconds,
    },
  };
  await writeFile(join(directory, "benchmark.json"), JSON.stringify(report, null, 2));
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (finished) return;
    void until(() => shellPids.every((pid) => !alive(pid)), "benchmark process cleanup").then(async () => {
      await rmdir(shellDirectory!);
      shellDirectory = undefined;
      finished = true; app.exit(0);
    }).catch(fail);
  });
  currentWindow.close();
}
async function fail(error: unknown) {
  if (finished) return;
  finished = true;
  if (shellDirectory) await rmdir(shellDirectory).catch(() => {});
  await writeFile(join(directory, "benchmark-error.json"), JSON.stringify({ error: error instanceof Error ? error.message : "Benchmark failed" }));
  app.exit(1);
}
void test().catch(fail);
