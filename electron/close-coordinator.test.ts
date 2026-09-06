import { describe, expect, it, vi } from "vitest";
import { CloseCoordinator } from "./close-coordinator";
import type { WorkspaceStateV1 } from "../src/lib/types";

const workspace: WorkspaceStateV1 = { schemaVersion: 1, layout: { type: "pane", paneId: "p" }, panes: { p: { cwd: "C:\\", shell: "pwsh.exe", args: [] } } };
function setup() {
  const dependencies = {
    hasSessions: () => true, confirm: vi.fn(async () => true), snapshot: vi.fn(async () => workspace),
    save: vi.fn(async (_state: WorkspaceStateV1) => {}), stop: vi.fn(async () => {}), finish: vi.fn(),
  };
  return { dependencies, coordinator: new CloseCoordinator(dependencies) };
}
describe("main process window close", () => {
  it("cancel keeps the window and all sessions running", async () => {
    const { coordinator, dependencies: d } = setup();
    d.confirm.mockResolvedValue(false);
    expect(await coordinator.request()).toBe(false);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.stop).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
    expect(coordinator.allowClose).toBe(false);
  });
  it("gets the latest renderer state and saves before stopping processes and allowing final close", async () => {
    const { coordinator, dependencies: d } = setup();
    expect(await coordinator.request()).toBe(true);
    expect(d.save).toHaveBeenCalledWith(workspace);
    expect(d.save.mock.invocationCallOrder[0]).toBeLessThan(d.stop.mock.invocationCallOrder[0]);
    expect(d.stop.mock.invocationCallOrder[0]).toBeLessThan(d.finish.mock.invocationCallOrder[0]);
    expect(coordinator.allowClose).toBe(true);
    await coordinator.request();
    expect(d.finish).toHaveBeenCalledOnce();
  });
  it("prompts on snapshot or save failure and honors cancellation before process cleanup", async () => {
    const { coordinator, dependencies: d } = setup();
    d.save.mockRejectedValue(new Error("disk"));
    d.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await coordinator.request()).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
    expect(d.confirm).toHaveBeenLastCalledWith("工作区保存失败，仍要退出吗？");
    expect(await coordinator.request()).toBe(true);
    expect(d.stop).toHaveBeenCalledOnce();
  });
  it("coalesces repeated close events while a dialog is pending", async () => {
    const { coordinator, dependencies: d } = setup();
    let confirm!: (answer: boolean) => void;
    d.confirm.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const first = coordinator.request(), second = coordinator.request();
    expect(first).toBe(second);
    confirm(true);
    await first;
    expect(d.save).toHaveBeenCalledOnce();
    expect(d.stop).toHaveBeenCalledOnce();
  });
});
