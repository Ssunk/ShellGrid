import { spawn, type ChildProcess } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { GitBranch, GitDiff, GitFileStatus, GitOperationResult, GitStatus } from "../../src/lib/types";
import type { GitMutation } from "../../shared/desktop";

export const MAX_DIFF_BYTES = 256 * 1024;
export const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const TERMINATION_TIMEOUT_MS = 5_000;
interface Output { code: number; stdout: Buffer; stderr: Buffer; truncated: boolean }
function boundedText(bytes: Buffer, limit: number): string { return bytes.subarray(0, limit).toString("utf8"); }
function detail(output: Output, success: boolean, fallback: string): string {
  const first = success ? output.stdout : output.stderr;
  const second = success ? output.stderr : output.stdout;
  return boundedText(first, MAX_MESSAGE_BYTES).trim() || boundedText(second, MAX_MESSAGE_BYTES).trim() || fallback;
}
function operationResult(output: Output, fallback: string): GitOperationResult {
  if (output.code !== 0) throw new Error(detail(output, false, "Git 操作失败（退出码 " + output.code + "）"));
  return { message: detail(output, true, fallback) };
}
export function validateFilePath(value: string): void {
  if (!value || value.includes("\0") || win32.isAbsolute(value) || isAbsolute(value) || value.includes(":")
    || value.split(/[\\/]/).includes("..")) throw new Error("Git 文件路径无效");
}
function literal(path: string): string { validateFilePath(path); return ":(literal)" + path; }
function emptyStatus(): GitStatus {
  return { isRepository: false, detached: false, ahead: 0, behind: 0, files: [], branches: [], remotes: [] };
}

/** Terminate the whole Windows process tree while the direct child PID still identifies it. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    return;
  }
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  await new Promise<void>((resolveTermination) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveTermination();
    };
    const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true, stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      try { killer.kill(); } catch { /* already exited */ }
      try { child.kill(); } catch { /* already exited */ }
      finish();
    }, TERMINATION_TIMEOUT_MS);
    killer.once("error", () => {
      try { child.kill(); } catch { /* already exited */ }
      finish();
    });
    killer.once("close", (code) => {
      if (code !== 0) {
        try { child.kill(); } catch { /* already exited */ }
      }
      finish();
    });
  });
}
export function parseStatus(bytes: Buffer): GitStatus {
  const records = bytes.toString("utf8").split("\0");
  const status = { ...emptyStatus(), isRepository: true };
  for (let index = 0; index < records.length; index++) {
    const row = records[index];
    if (row.startsWith("# branch.head ")) {
      const branch = row.slice(14);
      status.detached = branch === "(detached)" || branch === "(unknown)";
      if (!status.detached) status.branch = branch;
    } else if (row.startsWith("# branch.upstream ")) status.upstream = row.slice(18);
    else if (row.startsWith("# branch.ab ")) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(row);
      if (match) { status.ahead = Number(match[1]); status.behind = Number(match[2]); }
    } else if (row.startsWith("? ")) status.files.push({ path: row.slice(2), indexStatus: "?", worktreeStatus: "?" });
    else {
      const fields = row.startsWith("1 ") ? 9 : row.startsWith("2 ") ? 10 : row.startsWith("u ") ? 11 : 0;
      if (!fields) continue;
      // Split only metadata fields: the remaining filename may contain spaces.
      let offset = 0;
      for (let part = 1; part < fields; part++) {
        const space = row.indexOf(" ", offset);
        if (space < 0) { offset = -1; break; }
        offset = space + 1;
      }
      if (offset < 0) continue;
      const file: GitFileStatus = { path: row.slice(offset), indexStatus: row[2] ?? ".", worktreeStatus: row[3] ?? "." };
      if (fields === 10) file.originalPath = records[++index];
      status.files.push(file);
    }
  }
  return status;
}
export function parseBranches(bytes: Buffer): GitBranch[] {
  return bytes.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const [name, upstream, head] = line.split("\t");
    return { name: name.trim(), ...(upstream?.trim() ? { upstream: upstream.trim() } : {}), current: head?.trim() === "*" };
  });
}
export class GitService {
  private readonly children = new Set<ChildProcess>();
  private readonly terminations = new Map<ChildProcess, Promise<void>>();
  private stopping = false;
  constructor(private readonly executable: string | null, private readonly timeoutMs = GIT_TIMEOUT_MS) {}
  async output(cwd: string, args: string[], limit = MAX_STATUS_BYTES): Promise<Output> {
    if (!this.executable) throw new Error("未找到 Git，请先安装 Git for Windows 后重启应用");
    if (this.stopping) throw new Error("应用正在退出，无法启动 Git 操作");
    return new Promise((resolveOutput, reject) => {
      const child = spawn(this.executable!, ["-c", "color.ui=false", "-c", "core.quotepath=false", "-C", cwd, ...args], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      this.children.add(child);
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let size = 0, errorSize = 0, truncated = false, settled = false, timedOut = false;
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        void this.terminate(child).finally(() => rejectOnce(new Error("Git 操作超时")));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, limit - size);
        if (chunk.length > remaining) truncated = true;
        if (remaining) stdout.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, MAX_MESSAGE_BYTES - errorSize);
        if (remaining) stderr.push(chunk.subarray(0, remaining));
        errorSize += Math.min(chunk.length, remaining);
      });
      child.on("error", () => {
        this.children.delete(child);
        rejectOnce(new Error("无法启动 Git"));
      });
      child.on("close", (code) => {
        this.children.delete(child);
        if (settled) return;
        if (timedOut) { rejectOnce(new Error("Git 操作超时")); return; }
        settled = true;
        clearTimeout(timeout);
        resolveOutput({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated });
      });
    });
  }
  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) return existing;
    const termination = terminateProcessTree(child).finally(() => this.terminations.delete(child));
    this.terminations.set(child, termination);
    return termination;
  }
  async cancelActive(): Promise<void> {
    await Promise.allSettled([...this.children].map((child) => this.terminate(child)));
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.cancelActive();
  }
  async checked(cwd: string, args: string[], limit = MAX_STATUS_BYTES): Promise<Output> {
    const output = await this.output(cwd, args, limit);
    operationResult(output, "");
    if (output.truncated && limit === MAX_STATUS_BYTES) throw new Error("Git 输出超过 16 MiB 限制");
    return output;
  }
  async repositoryRoot(path: string): Promise<string | null> {
    if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error("工作区目录不存在");
    const output = await this.output(path, ["rev-parse", "--show-toplevel"]);
    return output.code === 0 ? output.stdout.toString("utf8").trim() || null : null;
  }
  private async requiredRoot(path: string): Promise<string> {
    const root = await this.repositoryRoot(path);
    if (!root) throw new Error("当前工作区不是 Git 仓库");
    return root;
  }
  async status(path: string): Promise<GitStatus> {
    const root = await this.repositoryRoot(path);
    if (!root) return emptyStatus();
    const status = parseStatus((await this.checked(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])).stdout);
    status.repoRoot = root;
    status.branches = parseBranches((await this.checked(root, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)", "refs/heads"])).stdout);
    if (status.branch && !status.branches.some((branch) => branch.name === status.branch)) {
      status.branches.unshift({ name: status.branch, upstream: status.upstream, current: true });
    }
    status.remotes = (await this.checked(root, ["remote"])).stdout.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return status;
  }
  async diff(path: string, filePath: string, staged: boolean): Promise<GitDiff> {
    const root = await this.requiredRoot(path);
    const spec = literal(filePath);
    const output = await this.checked(root, ["diff", "--no-ext-diff", "--no-color", ...(staged ? ["--cached"] : []), "--", spec], MAX_DIFF_BYTES);
    if (!staged && output.stdout.length === 0) {
      const untracked = await this.untrackedDiff(root, filePath);
      if (untracked) return untracked;
    }
    const content = output.stdout.toString("utf8");
    return { content, binary: content.includes("Binary files ") || content.includes("GIT binary patch"), truncated: output.truncated };
  }
  private async untrackedDiff(root: string, filePath: string): Promise<GitDiff | null> {
    if ((await this.output(root, ["ls-files", "--error-unmatch", "--", literal(filePath)])).code === 0) return null;
    const fullPath = await realpath(resolve(root, filePath)).catch(() => null);
    if (!fullPath) return null;
    const actualRoot = await realpath(root);
    const rel = relative(actualRoot, fullPath);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("文件不在当前 Git 仓库内");
    const file = await open(fullPath, "r").catch(() => null);
    if (!file) return null;
    const data = Buffer.alloc(MAX_DIFF_BYTES + 1);
    let size = 0;
    try {
      if (!(await file.stat()).isFile()) return null;
      while (size < data.length) {
        const { bytesRead } = await file.read(data, size, data.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
    } finally { await file.close(); }
    const bytes = data.subarray(0, size);
    const truncated = size > MAX_DIFF_BYTES;
    if (bytes.subarray(0, 8000).includes(0)) return { content: "", binary: true, truncated };
    const body = boundedText(bytes, MAX_DIFF_BYTES);
    let content = "diff --git a/" + filePath + " b/" + filePath + "\nnew file mode 100644\n--- /dev/null\n+++ b/" + filePath + "\n";
    if (body) {
      const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
      content += "@@ -0,0 +1," + lines + " @@\n" + (body.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => "+" + line).join("");
    }
    return { content, binary: false, truncated };
  }
  private async headExists(root: string): Promise<boolean> { return (await this.output(root, ["rev-parse", "--verify", "HEAD"])).code === 0; }
  async headMessage(path: string): Promise<string | null> {
    const root = await this.requiredRoot(path);
    if (!(await this.headExists(root))) return null;
    return (await this.checked(root, ["log", "-1", "--pretty=%B"], MAX_MESSAGE_BYTES)).stdout.toString("utf8").trimEnd();
  }
  async mutate(request: GitMutation): Promise<GitOperationResult> {
    const root = await this.requiredRoot(request.path);
    let args: string[], message: string;
    switch (request.type) {
      case "stage": case "unstage": case "restore": {
        if (!request.paths.length) throw new Error("没有可操作的文件");
        const command = request.type === "stage" ? ["add", "--"]
          : request.type === "restore" ? ["restore", "--worktree", "--"]
            : await this.headExists(root) ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "--"];
        args = [...command, ...request.paths.map(literal)];
        message = request.type === "stage" ? "已暂存所选文件" : request.type === "restore" ? "已恢复所选文件" : "已取消暂存所选文件";
        break;
      }
      case "commit":
        if (!request.message.trim()) throw new Error("请输入提交信息");
        if (request.amend && !(await this.headExists(root))) throw new Error("仓库还没有提交，无法修补上次提交");
        args = ["commit", "-m", request.message.trim(), ...(request.amend ? ["--amend"] : []), ...(request.signoff ? ["--signoff"] : [])];
        message = request.amend ? "提交已修补" : "提交已创建";
        break;
      case "switchBranch": {
        const branch = request.branch.trim();
        if (!branch) throw new Error("请输入分支名称");
        if (request.create) await this.checked(root, ["check-ref-format", "--branch", branch]);
        args = ["switch", request.create ? "-c" : "--", branch];
        message = request.create ? "分支已创建并切换" : "分支已切换";
        break;
      }
      case "pull": args = ["pull", "--ff-only"]; message = "已拉取远端更新"; break;
      case "push": {
        const status = await this.status(request.path);
        if (!status.branch || status.detached) throw new Error("分离 HEAD 状态下不能从面板推送");
        args = ["push", ...(request.forceWithLease ? ["--force-with-lease"] : [])];
        if (!status.upstream) {
          const remote = request.remote?.trim();
          if (!remote) throw new Error("当前分支没有 upstream，请先选择远端");
          if (!status.remotes.includes(remote)) throw new Error("选择的 Git 远端不存在");
          args.push("--set-upstream", "--", remote, status.branch);
        }
        message = request.forceWithLease ? "安全强制推送完成" : "推送完成";
        break;
      }
    }
    return operationResult(await this.output(root, args, MAX_MESSAGE_BYTES), message);
  }
}
