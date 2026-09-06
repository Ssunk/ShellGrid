import { randomUUID } from "node:crypto";
import { NodePtyFactory } from "../../electron/pty/node-pty-factory";
import { delay } from "./helpers";

function resources(): Record<string, number> {
  return process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, type) => {
    counts[type] = (counts[type] ?? 0) + 1; return counts;
  }, {});
}
process.parentPort!.on("message", (event) => {
  if (event.data.type === "stop") { process.exit(0); return; }
  const { shell, cwd } = event.data as { shell: string; cwd: string };
  void (async () => {
    const before = resources();
    const factory = new NodePtyFactory();
    for (let index = 0; index < 4; index++) {
      let exited!: () => void;
      const exit = new Promise<void>((resolve) => { exited = resolve; });
      const pty = await factory.create({
        type: "create", generation: 1, requestId: randomUUID(), paneId: "resource-" + index,
        launch: { shell, cwd, args: ["-NoLogo", "-NoProfile", "-Command", "exit 0"] }, cols: 80, rows: 24, focused: true,
      }, { data: () => {}, exit: () => exited() }, new AbortController().signal);
      await exit;
    }
    await delay(1800);
    const after = resources();
    process.parentPort!.postMessage({ type: "result", ok:
      (after.MessagePort ?? 0) <= (before.MessagePort ?? 0) && (after.PipeWrap ?? 0) <= (before.PipeWrap ?? 0),
    before, after });
  })().catch(() => process.parentPort!.postMessage({ type: "result", ok: false }));
});
