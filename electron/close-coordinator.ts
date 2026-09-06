import type { WorkspaceStateV1 } from "../src/lib/types";

interface CloseDependencies {
  hasSessions(): boolean;
  confirm(message: string): Promise<boolean>;
  snapshot(): Promise<WorkspaceStateV1>;
  save(workspace: WorkspaceStateV1): Promise<void>;
  stop(): Promise<void>;
  finish(): void;
}
export class CloseCoordinator {
  private pending?: Promise<boolean>;
  allowClose = false;
  constructor(private readonly dependencies: CloseDependencies) {}
  request(): Promise<boolean> {
    if (this.allowClose) return Promise.resolve(true);
    if (this.pending) return this.pending;
    this.pending = this.close().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async close(): Promise<boolean> {
    const d = this.dependencies;
    if (d.hasSessions() && !(await d.confirm("仍有终端正在运行，确定退出并终止它们吗？"))) return false;
    try { await d.save(await d.snapshot()); }
    catch { if (!(await d.confirm("工作区保存失败，仍要退出吗？"))) return false; }
    await d.stop();
    this.allowClose = true;
    d.finish();
    return true;
  }
}
