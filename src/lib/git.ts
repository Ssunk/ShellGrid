import type { GitFileStatus } from "./types";

export interface GitPanelErrors {
  action: string;
  refresh: string;
}

export function updateGitPanelError(errors: GitPanelErrors, source: keyof GitPanelErrors, message: string): GitPanelErrors {
  return { ...errors, [source]: message };
}

export function visibleGitPanelError(errors: GitPanelErrors): string {
  return errors.action || errors.refresh;
}

export function stagedFiles(files: GitFileStatus[]): GitFileStatus[] {
  return files.filter((file) => file.indexStatus !== "." && file.indexStatus !== "?");
}

export function workingFiles(files: GitFileStatus[]): GitFileStatus[] {
  return files.filter((file) => file.worktreeStatus !== "." || file.indexStatus === "?");
}

export function gitStatusLabel(code: string): string {
  return {
    M: "修改",
    A: "新增",
    D: "删除",
    R: "重命名",
    C: "复制",
    U: "冲突",
    T: "类型",
    "?": "未跟踪",
  }[code] ?? code;
}

export function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

export function parentPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

export function operationPaths(files: GitFileStatus[]): string[] {
  return [...new Set(files.flatMap((file) => file.originalPath ? [file.path, file.originalPath] : [file.path]))];
}

export function restorePaths(files: GitFileStatus[]): string[] {
  return [...new Set(files.filter((file) => file.indexStatus !== "?").map((file) => file.path))];
}

export function diffLineKind(line: string): "add" | "delete" | "meta" | "plain" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  return "plain";
}
