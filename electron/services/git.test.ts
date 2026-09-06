import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, MAX_DIFF_BYTES, parseBranches, parseStatus } from "./git";

const directories: string[] = [];
const git = new GitService("git.exe");
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "shellgrid-git-"));
  directories.push(directory); return directory;
}
async function repository() {
  const path = await temporary();
  await git.checked(path, ["init", "-b", "main"]);
  for (const [key, value] of [
    ["user.name", "ShellGrid Test"], ["user.email", "shellgrid@example.invalid"],
    ["core.autocrlf", "false"], ["commit.gpgsign", "false"], ["core.hooksPath", join(path, ".empty-hooks")],
  ]) await git.checked(path, ["config", key, value]);
  return path;
}
const stage = (path: string, paths: string[]) => git.mutate({ type: "stage", path, paths });
const commit = (path: string, message: string, amend = false, signoff = false) => git.mutate({ type: "commit", path, message, amend, signoff });
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("Git service migration", () => {
  it("parses porcelain v2 branch, rename, conflict and Unicode paths without splitting filenames", () => {
    const parsed = parseStatus(Buffer.from(
      "# branch.oid abc\0# branch.head feature/ui\0# branch.upstream origin/feature/ui\0# branch.ab +2 -1\0" +
      "1 M. N... 100644 100644 100644 a b src/main.ts\0" +
      "2 RM N... 100644 100644 100644 a b R100 src/新 name.ts\0src/old name.ts\0" +
      "u UU N... 100644 100644 100644 100644 a b c conflict name.txt\0? notes/计划.txt\0"));
    expect(parsed).toMatchObject({ branch: "feature/ui", upstream: "origin/feature/ui", ahead: 2, behind: 1 });
    expect(parsed.files[1]).toMatchObject({ path: "src/新 name.ts", originalPath: "src/old name.ts" });
    expect(parsed.files[2]).toMatchObject({ path: "conflict name.txt", indexStatus: "U", worktreeStatus: "U" });
    expect(parsed.files[3]).toMatchObject({ path: "notes/计划.txt", indexStatus: "?" });
    expect(parseBranches(Buffer.from("feature\torigin/feature\t*\nmain\torigin/main\t \n"))).toEqual([
      { name: "feature", upstream: "origin/feature", current: true },
      { name: "main", upstream: "origin/main", current: false },
    ]);
  });
  it("reports non-repositories and missing Git", async () => {
    const path = await temporary();
    expect((await git.status(path)).isRepository).toBe(false);
    await expect(new GitService(null).status(path)).rejects.toThrow("未找到 Git");
  });
  it("previews text, empty and binary untracked files and bounds large diffs", async () => {
    const path = await repository();
    await writeFile(join(path, "notes.txt"), "line1\nline2");
    await writeFile(join(path, "empty.txt"), "");
    await writeFile(join(path, "blank-lines.txt"), "first\n\nlast\n");
    await writeFile(join(path, "blob.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(path, "large.txt"), "x".repeat(MAX_DIFF_BYTES + 100));
    const notes = await git.diff(path, "notes.txt", false);
    expect(notes).toMatchObject({ binary: false, truncated: false });
    expect(notes.content).toContain("@@ -0,0 +1,2 @@\n+line1\n+line2");
    expect((await git.diff(path, "empty.txt", false)).content).not.toContain("@@");
    expect((await git.diff(path, "blank-lines.txt", false)).content).toContain("+first\n+\n+last\n");
    expect(await git.diff(path, "blob.bin", false)).toMatchObject({ binary: true, content: "" });
    expect((await git.diff(path, "large.txt", false)).truncated).toBe(true);
    await stage(path, ["large.txt"]);
    const staged = await git.diff(path, "large.txt", true);
    expect(staged.truncated).toBe(true);
    expect(Buffer.byteLength(staged.content)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });
  it("treats bracket paths literally for diff, stage, unstage and restore", async () => {
    const path = await repository();
    await writeFile(join(path, "star[1]file.txt"), "original\n");
    await writeFile(join(path, "star1file.txt"), "other\n");
    expect((await git.diff(path, "star[1]file.txt", false)).content).not.toContain("star1file.txt");
    await stage(path, ["star[1]file.txt"]);
    let files = (await git.status(path)).files.filter((file) => file.indexStatus !== "?");
    expect(files.map((file) => file.path)).toEqual(["star[1]file.txt"]);
    // Unborn HEAD cancellation must use rm --cached without deleting the file.
    await git.mutate({ type: "unstage", path, paths: ["star[1]file.txt"] });
    expect(await readFile(join(path, "star[1]file.txt"), "utf8")).toBe("original\n");
    await stage(path, ["star[1]file.txt"]);
    await commit(path, "initial");
    await writeFile(join(path, "star[1]file.txt"), "changed\n");
    await stage(path, ["star[1]file.txt"]);
    await git.mutate({ type: "unstage", path, paths: ["star[1]file.txt"] });
    await git.mutate({ type: "restore", path, paths: ["star[1]file.txt"] });
    expect(await readFile(join(path, "star[1]file.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(path, "star1file.txt"), "utf8")).toBe("other\n");
    files = (await git.status(path)).files;
    expect(files).toHaveLength(1);
  });
  it("preserves staged content on restore and supports amend, signoff and branch switching", async () => {
    const path = await repository();
    await writeFile(join(path, "hello world.txt"), "你好\n");
    await stage(path, ["hello world.txt"]);
    await expect(commit(path, "no HEAD", true)).rejects.toThrow();
    await commit(path, "initial commit");
    expect((await git.status(path)).files).toEqual([]);
    expect((await git.diff(path, "hello world.txt", false)).content).toBe("");
    await writeFile(join(path, "hello world.txt"), "staged\n");
    await stage(path, ["hello world.txt"]);
    await writeFile(join(path, "hello world.txt"), "unstaged\n");
    await git.mutate({ type: "restore", path, paths: ["hello world.txt"] });
    expect(await readFile(join(path, "hello world.txt"), "utf8")).toBe("staged\n");
    expect(await git.headMessage(path)).toBe("initial commit");
    await commit(path, "amended commit", true, true);
    expect(await git.headMessage(path)).toContain("Signed-off-by: ShellGrid Test <shellgrid@example.invalid>");
    expect((await git.checked(path, ["rev-list", "--count", "HEAD"])).stdout.toString().trim()).toBe("1");
    await git.mutate({ type: "switchBranch", path, branch: "feature/git-panel", create: true });
    expect((await git.status(path)).branch).toBe("feature/git-panel");
    await git.mutate({ type: "switchBranch", path, branch: "main", create: false });
    expect((await git.status(path)).branch).toBe("main");
  });
  it("pushes to a local bare remote, establishes upstream, pulls and uses force-with-lease for amendments", async () => {
    const path = await repository(), remote = await temporary();
    await git.checked(remote, ["init", "--bare"]);
    await writeFile(join(path, "force.txt"), "initial\n");
    await stage(path, ["force.txt"]); await commit(path, "initial");
    await git.checked(path, ["remote", "add", "origin", remote]);
    await expect(git.mutate({ type: "push", path, remote: null, forceWithLease: false })).rejects.toThrow("upstream");
    await git.mutate({ type: "push", path, remote: "origin", forceWithLease: false });
    expect((await git.status(path)).upstream).toBe("origin/main");
    await git.mutate({ type: "pull", path });
    await writeFile(join(path, "force.txt"), "rewritten\n");
    await stage(path, ["force.txt"]); await commit(path, "rewritten", true);
    await expect(git.mutate({ type: "push", path, remote: null, forceWithLease: false })).rejects.toThrow();
    await git.mutate({ type: "push", path, remote: null, forceWithLease: true });
    const local = (await git.checked(path, ["rev-parse", "HEAD"])).stdout;
    const remoteHead = (await git.checked(remote, ["rev-parse", "main"])).stdout;
    expect(local).toEqual(remoteHead);
    await git.checked(path, ["checkout", "--detach"]);
    expect((await git.status(path)).detached).toBe(true);
    await expect(git.mutate({ type: "push", path, remote: null, forceWithLease: true })).rejects.toThrow("分离 HEAD");
  });
  it("rejects on timeout after terminating Git hooks and other descendant processes", async () => {
    const path = await temporary();
    const shortTimeout = new GitService("git.exe", 200);
    const started = Date.now();
    await expect(shortTimeout.output(path, ["-c", "alias.shellgrid-wait=!ping.exe -n 30 127.0.0.1", "shellgrid-wait"]))
      .rejects.toThrow("Git 操作超时");
    expect(Date.now() - started).toBeLessThan(10_000);
    await shortTimeout.shutdown();
  }, 10_000);
});
