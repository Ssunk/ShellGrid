import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceStateV1 } from "../../src/lib/types";
import { parseWorkspace } from "../../shared/workspace";

export class WorkspaceStore {
  private queue: Promise<void> = Promise.resolve();
  private writable = true;
  warning: string | null = null;
  constructor(readonly path: string) {}

  async load(fallback: WorkspaceStateV1): Promise<WorkspaceStateV1> {
    let contents: string;
    try { contents = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.writable = false;
        this.warning = "无法读取工作区文件；为保护原文件，本次会话不能保存工作区";
      }
      return fallback;
    }
    try { return parseWorkspace(JSON.parse(contents), true); }
    catch {
      try {
        await rename(this.path, join(dirname(this.path), "workspace.corrupt-" + Date.now() + "-" + randomUUID() + ".json"));
        this.warning = "工作区文件损坏，已保留备份并使用默认布局";
      } catch {
        this.writable = false;
        this.warning = "无法保留损坏的工作区文件；为保护原文件，本次会话不能保存工作区";
      }
      return fallback;
    }
  }

  save(value: unknown): Promise<void> {
    // Snapshot before queuing, so subsequent renderer changes cannot alter this save.
    const bytes = JSON.stringify(parseWorkspace(value), null, 2);
    const pending = this.queue.then(async () => {
      if (!this.writable) throw new Error(this.warning ?? "工作区文件不可写");
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, ".workspace-" + randomUUID() + ".tmp");
      try {
        const file = await open(temporary, "wx");
        try { await file.writeFile(bytes, "utf8"); await file.sync(); }
        finally { await file.close(); }
        // libuv uses MoveFileExW(REPLACE_EXISTING) on Windows; same-directory rename.
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
