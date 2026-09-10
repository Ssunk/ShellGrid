import { app, BrowserWindow, dialog } from "electron";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { alive, check, delay, pwsh, until } from "./helpers";

const directory = process.env.SHELLGRID_TEST_DIRECTORY!;
const visible = process.env.SHELLGRID_TEST_VISIBLE === "1";
const dataDirectory = join(process.env.LOCALAPPDATA!, "ShellGrid");
const workspacePath = join(dataDirectory, "workspace.json");
const results: string[] = [];
const answers: number[] = [];
let prompts = 0;
let currentWindow: BrowserWindow | undefined;
let finished = false;
const shellPids = new Set<number>();
const reportPath = join(directory, "ui-report.json");
const timeout = setTimeout(() => { void fail(new Error("UI verification timeout")); }, 75_000);
async function fail(error: unknown) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  await writeFile(reportPath, JSON.stringify({ visible, passed: results, error: error instanceof Error ? error.message : "UI verification failed" }, null, 2));
  app.exit(1);
}
async function evaluate<T>(script: string): Promise<T> {
  return currentWindow!.webContents.executeJavaScript(script, true) as Promise<T>;
}
async function running(count: number) {
  await until(() => evaluate<boolean>("document.querySelectorAll('.session-status.running').length === " + count), "UI running panes " + count, 25_000);
}
async function collectPids() {
  for (const pid of await evaluate<number[]>("window.__sgCreated.map(e => e.shellPid)")) shellPids.add(pid);
}
async function consoleSize(marker: string): Promise<{ cols: number; rows: number }> {
  await evaluate("document.querySelectorAll('.terminal-surface textarea')[1].focus();true");
  await currentWindow!.webContents.insertText("[Console]::Write(('SG'+'" + marker + "')+[Console]::WindowWidth+','+[Console]::WindowHeight+';')");
  currentWindow!.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  currentWindow!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  const query = "(()=>{const m=window.__sgText.match(/SG" + marker + "(\\d+),(\\d+);/);return m?{cols:Number(m[1]),rows:Number(m[2])}:null})()";
  await until(() => evaluate<boolean>("Boolean(" + query + ")"), "ConPTY dimensions after UI resize");
  return evaluate(query);
}
async function dragDivider(ratio: number): Promise<void> {
  const bounds = await evaluate<{ x: number; y: number; target: number }>(`(() => {
    const divider = document.querySelector('.workspace > .split-root > .divider');
    const rect = divider.getBoundingClientRect();
    const parent = divider.parentElement.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), target: Math.round(parent.x + parent.width * ${ratio}) };
  })()`);
  const contents = currentWindow!.webContents;
  contents.sendInputEvent({ type: "mouseMove", x: bounds.x, y: bounds.y });
  contents.sendInputEvent({ type: "mouseDown", x: bounds.x, y: bounds.y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseMove", x: bounds.target, y: bounds.y, modifiers: ["leftbuttondown"] });
  contents.sendInputEvent({ type: "mouseUp", x: bounds.target, y: bounds.y, button: "left", clickCount: 1 });
  await until(() => evaluate<boolean>("Math.abs(parseFloat(document.querySelector('.workspace > .split-root > .split-child').style.flexBasis)/100-" + ratio + ")<0.002"), "final divider ratio");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
}
async function test() {
  await mkdir(dataDirectory, { recursive: true });
  const shell = await pwsh();
  await writeFile(workspacePath, JSON.stringify({
    schemaVersion: 1, layout: { type: "pane", paneId: "legacy-pane" },
    panes: { "legacy-pane": { cwd: directory, shell, args: ["-NoLogo", "-NoProfile"] } },
    proxy: { enabled: true, url: "broken proxy" },
  }));
  // These hooks exist only in the external verification harness, never in the app.
  if (!visible) BrowserWindow.prototype.show = function () {};
  dialog.showMessageBox = (async () => {
    prompts++;
    return { response: answers.shift() ?? 0, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  dialog.showErrorBox = () => { void fail(new Error("Desktop initialization failed")); };
  if (process.env.SHELLGRID_TEST_RESOURCES) {
    Object.defineProperty(app, "isPackaged", { value: true });
    Object.defineProperty(process, "resourcesPath", { value: process.env.SHELLGRID_TEST_RESOURCES });
    require(join(process.env.SHELLGRID_TEST_RESOURCES, "app.asar", "dist-electron", "main.cjs"));
  } else require(resolve("dist-electron/main.cjs"));
  await until(() => BrowserWindow.getAllWindows().length > 0, "main window");
  currentWindow = BrowserWindow.getAllWindows()[0];
  if (visible) await until(() => currentWindow!.isVisible(), "visible UI test window");
  await until(() => evaluate<boolean>("Boolean(window.shellgrid && document.querySelector('.terminal-pane'))").catch(() => false), "sandboxed renderer bootstrap");
  if (visible) check(await evaluate("document.visibilityState === 'visible'"), "UI test renderer is hidden");
  await running(1);
  check(await evaluate("window.shellgrid !== undefined"), "Sandbox preload did not load");
  check(await evaluate("typeof window.require === 'undefined' && typeof window.process === 'undefined'"), "Node globals escaped the preload");
  check(await evaluate("(async()=>{const b=await window.shellgrid.getBootstrap();return b.workspace.layout.paneId==='legacy-pane' && b.workspace.rootPath===" +
    JSON.stringify(directory) + " && !b.workspace.proxy && !('wsUrl' in b) && b.environment.electronVersion==='42.8.1'})()"), "Legacy Bootstrap compatibility failed");
  check(await evaluate("(async()=>{try{await window.shellgrid.openExternal('file:///C:/Windows');return false}catch{return true}})()"), "External protocol boundary failed");
  results.push("sandbox, context isolation, typed preload and legacy workspace Bootstrap");
  await evaluate("window.__sgFirst=document.querySelector('.terminal-surface');window.__sgCreated=[];window.__sgText='';window.shellgrid.terminal.onEvent(e=>{if(e.type==='created')window.__sgCreated.push(e);if(e.type==='data')window.__sgText=(window.__sgText+e.data).slice(-262144)});true");
  await evaluate("document.querySelector('.toolbar-group button[title^=\"左右分割\"]').click();true");
  await running(2);
  check(await evaluate("Array.from(document.querySelectorAll('.terminal-surface')).includes(window.__sgFirst)"), "Layout split rebuilt the original xterm");
  await collectPids();
  const geometry = await evaluate<boolean>("Array.from(document.querySelectorAll('.terminal-surface')).every(el=>el.getBoundingClientRect().width>100 && el.getBoundingClientRect().height>100)");
  check(geometry, "Terminal hosts did not receive actual dimensions");
  currentWindow.setSize(1100, 740);
  currentWindow.webContents.setZoomLevel(0.5);
  await delay(150);
  currentWindow.webContents.setZoomLevel(0);
  currentWindow.setSize(1280, 800);
  await delay(150);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  check(await evaluate("Array.from(document.querySelectorAll('.terminal-surface')).includes(window.__sgFirst)"), "Zoom/resize rebuilt xterm");
  const initialSize = await consoleSize("INITIALSIZE");
  await dragDivider(0.65);
  const smallerSize = await consoleSize("SMALLERSIZE");
  check(smallerSize.cols < initialSize.cols && smallerSize.rows === initialSize.rows,
    `Divider resize did not reach ConPTY (${initialSize.cols}x${initialSize.rows} -> ${smallerSize.cols}x${smallerSize.rows})`);
  await dragDivider(0.5);
  const restoredSize = await consoleSize("RESTOREDSIZE");
  check(restoredSize.cols === initialSize.cols && restoredSize.rows === initialSize.rows, "Final divider dimensions were not restored");
  check(await evaluate("Array.from(document.querySelectorAll('.terminal-surface')).includes(window.__sgFirst)"), "Divider drag rebuilt xterm");
  results.push("divider release commits final ratio, resizes real ConPTY and preserves xterm");
  // Real xterm onData -> preload -> MessagePort -> ConPTY -> renderer.
  await evaluate("document.querySelectorAll('.terminal-surface textarea')[1].focus();true");
  await currentWindow.webContents.insertText("[Console]::Write(('UI'+'-输入成功'))");
  currentWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  currentWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await until(() => evaluate<boolean>("window.__sgText.includes('UI-输入成功')"), "Unicode keyboard terminal input");
  results.push("stable xterm across split, live resize/zoom and Unicode input");
  answers.push(1);
  await evaluate("document.querySelectorAll('.terminal-pane .close-button')[1].click();true");
  await running(1);
  await until(() => [...shellPids].every((pid) => !alive(pid)), "closed pane process cleanup");
  check(await evaluate("document.querySelector('.terminal-surface')===window.__sgFirst"), "Pane collapse rebuilt xterm");
  results.push("pane close terminates the session and preserves the surviving xterm");
  const promptBefore = prompts;
  answers.push(0);
  currentWindow.close();
  await until(() => prompts === promptBefore + 1, "cancel close dialog");
  await delay(120);
  check(!currentWindow.isDestroyed(), "Cancel closed the window");
  await running(1);
  results.push("window close cancellation preserves the running terminal");

  await evaluate("(async()=>{const b=await window.shellgrid.getBootstrap();await window.shellgrid.saveWorkspace(b.workspace)})()");
  const backup = join(dataDirectory, "test-workspace-backup.json");
  await rename(workspacePath, backup);
  await mkdir(workspacePath);
  const beforeFailure = prompts;
  answers.push(1, 0);
  currentWindow.close();
  await until(() => prompts >= beforeFailure + 2, "save failure confirmation");
  await delay(100);
  check(!currentWindow.isDestroyed(), "Cancel after save failure closed the app");
  await running(1);
  await rmdir(workspacePath);
  await rename(backup, workspacePath);
  results.push("save failure confirmation cancellation preserves the application");

  await evaluate("document.querySelector('.toolbar-group button[title^=\"左右分割\"]').click();true");
  await running(2);
  await collectPids();
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (finished) return;
    void (async () => {
      const saved = JSON.parse(await readFile(workspacePath, "utf8")) as { layout: { type: string }; panes: Record<string, unknown> };
      check(saved.layout.type === "split" && Object.keys(saved.panes).length === 2, "Final close missed the latest layout");
      await until(() => [...shellPids].every((pid) => !alive(pid)), "final close process cleanup");
      results.push("confirmed window close saves latest layout and reaps sessions without recursion");
      finished = true; clearTimeout(timeout);
      await writeFile(reportPath, JSON.stringify({ visible, passed: results }, null, 2));
      app.exit(0);
    })().catch(fail);
  });
  answers.push(1);
  currentWindow.close();
}
void test().catch(fail);
