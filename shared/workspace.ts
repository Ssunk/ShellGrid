import type { LayoutNode, WorkspaceStateV1 } from "../src/lib/types";
import { sanitizeProxy } from "../src/lib/proxy";
import { MAX_PANES, MAX_RATIO, MIN_RATIO } from "../src/lib/layout";
import { record, textValue, validLaunch } from "./protocol";

// Reconstruct the schema explicitly: session IDs, output, environment snapshots and
// unknown fields must never make it into persisted user data.
export function parseWorkspace(value: unknown, loading = false): WorkspaceStateV1 {
  if (!record(value) || value.schemaVersion !== 1) throw new Error("不支持的工作区版本");
  const ids = new Set<string>();
  function layout(node: unknown, depth = 0): LayoutNode {
    if (!record(node) || depth >= MAX_PANES) throw new Error("工作区布局无效");
    if (node.type === "pane") {
      if (!textValue(node.paneId, 256) || ids.has(node.paneId)) throw new Error("工作区包含无效或重复窗格");
      ids.add(node.paneId);
      if (ids.size > MAX_PANES) throw new Error("最多支持 16 个窗格");
      return { type: "pane", paneId: node.paneId };
    }
    if (node.type !== "split" || (node.direction !== "horizontal" && node.direction !== "vertical")
      || typeof node.ratio !== "number" || !Number.isFinite(node.ratio) || node.ratio < MIN_RATIO || node.ratio > MAX_RATIO) {
      throw new Error("工作区分割比例或方向无效");
    }
    return { type: "split", direction: node.direction, ratio: node.ratio, first: layout(node.first, depth + 1), second: layout(node.second, depth + 1) };
  }
  const parsedLayout = layout(value.layout);
  if (!record(value.panes)) throw new Error("工作区缺少启动信息");
  const panes: WorkspaceStateV1["panes"] = {};
  for (const [id, launch] of Object.entries(value.panes)) {
    if (!textValue(id, 256) || !validLaunch(launch)) throw new Error("窗格启动信息无效");
    Object.defineProperty(panes, id, { enumerable: true, configurable: true, writable: true,
      value: { cwd: launch.cwd, shell: launch.shell, args: [...launch.args], ...(launch.title === undefined ? {} : { title: launch.title }) } });
  }
  for (const id of ids) if (!Object.hasOwn(panes, id)) throw new Error("窗格缺少启动信息");
  let rootPath = value.rootPath;
  if ((rootPath === undefined || rootPath === null) && loading) rootPath = panes[ids.values().next().value!].cwd;
  if (rootPath !== undefined && rootPath !== null && !textValue(rootPath)) throw new Error("工作区目录无效");
  const proxy = sanitizeProxy(value.proxy);
  if (value.proxy != null && !proxy && !loading) throw new Error("代理配置无效");
  return {
    schemaVersion: 1, layout: parsedLayout, panes,
    ...(typeof rootPath === "string" ? { rootPath } : {}),
    ...(proxy ? { proxy: { enabled: proxy.enabled, url: proxy.url, ...(proxy.noProxy ? { noProxy: proxy.noProxy } : {}) } } : {}),
  };
}
