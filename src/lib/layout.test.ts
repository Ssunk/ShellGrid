import { describe, expect, it } from "vitest";
import { closePane, paneIds, sanitizeWorkspace, splitPane, updateRatio } from "./layout";
import type { LayoutNode, WorkspaceStateV1 } from "./types";

const root: LayoutNode = { type: "pane", paneId: "one" };

describe("layout tree", () => {
  it("splits a pane at 50/50", () => {
    const result = splitPane(root, "one", "two", "horizontal");
    expect(result).toMatchObject({ type: "split", ratio: 0.5, direction: "horizontal" });
    expect(paneIds(result)).toEqual(["one", "two"]);
  });

  it("collapses the empty branch when a pane closes", () => {
    const split = splitPane(root, "one", "two", "vertical");
    expect(closePane(split, "one")).toEqual({ type: "pane", paneId: "two" });
  });

  it("limits ratios", () => {
    const split = splitPane(root, "one", "two", "vertical");
    expect((updateRatio(split, "", 0.01) as { ratio: number }).ratio).toBe(0.15);
    expect((updateRatio(split, "", 0.99) as { ratio: number }).ratio).toBe(0.85);
  });

  it("caps the workspace at sixteen panes", () => {
    let tree: LayoutNode = root;
    for (let index = 2; index <= 20; index += 1) {
      tree = splitPane(tree, "one", `pane-${index}`, "horizontal");
    }
    expect(paneIds(tree)).toHaveLength(16);
  });

  it("rejects malformed persisted state", () => {
    const fallback: WorkspaceStateV1 = {
      schemaVersion: 1,
      layout: root,
      panes: { one: { cwd: "C:\\", shell: "pwsh.exe", args: ["-NoLogo"] } },
    };
    expect(sanitizeWorkspace({ schemaVersion: 1, layout: { type: "wat" } }, fallback)).toBe(fallback);
  });
});
