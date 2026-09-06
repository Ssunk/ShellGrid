import type { LayoutNode, PaneLaunchInfo, SplitDirection } from "./types";

export const MAX_PANES = 16;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export function paneIds(node: LayoutNode): string[] {
  return node.type === "pane"
    ? [node.paneId]
    : [...paneIds(node.first), ...paneIds(node.second)];
}

export function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function splitPane(
  node: LayoutNode,
  targetId: string,
  newId: string,
  direction: SplitDirection,
): LayoutNode {
  if (paneIds(node).length >= MAX_PANES) return node;
  if (node.type === "pane") {
    if (node.paneId !== targetId) return node;
    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: node,
      second: { type: "pane", paneId: newId },
    };
  }
  const first = splitPane(node.first, targetId, newId, direction);
  if (first !== node.first) return { ...node, first };
  const second = splitPane(node.second, targetId, newId, direction);
  return second === node.second ? node : { ...node, second };
}

export function closePane(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.type === "pane") return node.paneId === targetId ? null : node;
  const first = closePane(node.first, targetId);
  const second = closePane(node.second, targetId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function updateRatio(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.type === "pane" || path.length === 0) {
    return node.type === "split" && path.length === 0 ? { ...node, ratio: clampRatio(ratio) } : node;
  }
  const branch = path[0];
  const rest = path.slice(1);
  if (branch === "0") return { ...node, first: updateRatio(node.first, rest, ratio) };
  if (branch === "1") return { ...node, second: updateRatio(node.second, rest, ratio) };
  return node;
}

export function makePaneLaunch(cwd: string, shell = "pwsh.exe"): PaneLaunchInfo {
  return { cwd, shell, args: ["-NoLogo"] };
}
