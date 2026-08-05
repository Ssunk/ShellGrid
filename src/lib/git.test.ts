import { describe, expect, it } from "vitest";
import { diffLineKind, fileName, operationPaths, parentPath, restorePaths, stagedFiles, updateGitPanelError, visibleGitPanelError, workingFiles } from "./git";
import type { GitFileStatus } from "./types";

const files: GitFileStatus[] = [
  { path: "src/staged.ts", indexStatus: "M", worktreeStatus: "." },
  { path: "src/partial.ts", indexStatus: "M", worktreeStatus: "M" },
  { path: "notes/new file.txt", indexStatus: "?", worktreeStatus: "?" },
];

describe("git status presentation", () => {
  it("keeps partially staged files in both groups", () => {
    expect(stagedFiles(files).map((file) => file.path)).toEqual(["src/staged.ts", "src/partial.ts"]);
    expect(workingFiles(files).map((file) => file.path)).toEqual(["src/partial.ts", "notes/new file.txt"]);
  });

  it("splits display paths without losing spaces", () => {
    expect(fileName("notes/new file.txt")).toBe("new file.txt");
    expect(parentPath("notes/new file.txt")).toBe("notes");
  });

  it("classifies unified diff lines", () => {
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("delete");
    expect(diffLineKind("@@ -1 +1 @@")).toBe("meta");
  });

  it("includes both sides of a rename in git operations", () => {
    expect(operationPaths([
      { path: "new name.ts", originalPath: "old name.ts", indexStatus: "R", worktreeStatus: "." },
      { path: "new name.ts", indexStatus: "M", worktreeStatus: "M" },
    ])).toEqual(["new name.ts", "old name.ts"]);
  });

  it("restores only tracked worktree paths", () => {
    expect(restorePaths([
      { path: "src/partial.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "notes/new file.txt", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/partial.ts", indexStatus: ".", worktreeStatus: "M" },
    ])).toEqual(["src/partial.ts"]);
  });

  it("keeps operation errors visible when a later status refresh succeeds", () => {
    let errors = { action: "", refresh: "" };
    errors = updateGitPanelError(errors, "action", "提交失败：请检查用户信息");
    errors = updateGitPanelError(errors, "refresh", "");

    expect(visibleGitPanelError(errors)).toBe("提交失败：请检查用户信息");
  });
});
