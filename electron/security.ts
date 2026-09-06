import type { GitDiffRequest, GitMutation } from "../shared/desktop";
import { record, textValue } from "../shared/protocol";
import { isAbsolute } from "node:path";
import { validateFilePath } from "./services/git";

export function externalUrl(value: unknown): string {
  if (!textValue(value, 16_384)) throw new Error("链接格式无效");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("链接格式无效"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许打开 http 或 https 链接");
  return url.href;
}
export function directoryPath(value: unknown): string {
  if (!textValue(value) || !isAbsolute(value)) throw new Error("目录路径无效");
  return value;
}
export function gitDiffRequest(value: unknown): GitDiffRequest {
  if (!record(value) || !textValue(value.filePath) || typeof value.staged !== "boolean") throw new Error("Git 差异参数无效");
  validateFilePath(value.filePath);
  return { path: directoryPath(value.path), filePath: value.filePath, staged: value.staged };
}
export function gitMutation(value: unknown): GitMutation {
  if (!record(value)) throw new Error("Git 操作参数无效");
  const path = directoryPath(value.path);
  const invalid = () => { throw new Error("Git 操作参数无效"); };
  switch (value.type) {
    case "stage": case "unstage": case "restore":
      if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 10_000
        || !value.paths.every((entry) => textValue(entry))) return invalid();
      value.paths.forEach(validateFilePath);
      return { type: value.type, path, paths: value.paths as string[] };
    case "commit":
      if (!textValue(value.message, 32_767) || typeof value.amend !== "boolean" || typeof value.signoff !== "boolean") return invalid();
      return { type: "commit", path, message: value.message, amend: value.amend, signoff: value.signoff };
    case "switchBranch":
      if (!textValue(value.branch, 1024) || typeof value.create !== "boolean") return invalid();
      return { type: "switchBranch", path, branch: value.branch, create: value.create };
    case "pull": return { type: "pull", path };
    case "push":
      if (!(value.remote === null || textValue(value.remote, 1024)) || typeof value.forceWithLease !== "boolean") return invalid();
      return { type: "push", path, remote: value.remote as string | null, forceWithLease: value.forceWithLease };
    default: return invalid();
  }
}
export function trustedUrl(actual: string, expected: string): boolean {
  try {
    const url = new URL(actual), entry = new URL(expected);
    return url.protocol === entry.protocol && url.host === entry.host && url.pathname === entry.pathname && !url.search;
  } catch { return false; }
}
