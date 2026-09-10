import { describe, expect, it } from "vitest";
import { closePane, paneIds, splitPane, updateRatio } from "./layout";
import type { LayoutNode } from "./types";

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

  it("preserves the tree for unchanged or clamped ratios and stale paths", () => {
    const split = splitPane(root, "one", "two", "horizontal");
    const tree = splitPane(split, "two", "three", "vertical");
    expect(updateRatio(tree, "1", 0.5)).toBe(tree);
    expect(updateRatio(tree, "00", 0.7)).toBe(tree);
    expect(updateRatio(tree, "1x", 0.7)).toBe(tree);
    const limited = updateRatio(tree, "1", 1);
    expect(updateRatio(limited, "1", 2)).toBe(limited);
    if (limited.type !== "split" || tree.type !== "split") throw new Error("Expected split layouts");
    expect(limited.first).toBe(tree.first);
  });

});
