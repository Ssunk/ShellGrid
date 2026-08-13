<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Check,
    FileDiff,
    FolderGit2,
    GitBranch,
    GitCommitHorizontal,
    Minus,
    Plus,
    RefreshCw,
    ShieldAlert,
    Undo2,
    X,
  } from "lucide-svelte";
  import { diffLineKind, fileName, gitStatusLabel, operationPaths, parentPath, restorePaths, stagedFiles, updateGitPanelError, visibleGitPanelError, workingFiles } from "../lib/git";
  import type { GitDiff, GitFileStatus, GitOperationResult, GitStatus } from "../lib/types";

  export let path: string;
  export let gitAvailable: boolean;
  export let onClose: () => void;

  let status: GitStatus | null = null;
  let staged: GitFileStatus[] = [];
  let working: GitFileStatus[] = [];
  let refreshing = false;
  let operation = "";
  let errors = { action: "", refresh: "" };
  let error = "";
  let notice = "";
  let commitMessage = "";
  let amend = false;
  let signoff = false;
  let newBranch = "";
  let showNewBranch = false;
  let showRemotePicker = false;
  let selectedRemote = "";
  let selectedFile: { file: GitFileStatus; staged: boolean } | null = null;
  let diff: GitDiff | null = null;
  let diffLoading = false;
  let loadedPath = "";

  $: error = visibleGitPanelError(errors);
  $: staged = status ? stagedFiles(status.files) : [];
  $: working = status ? workingFiles(status.files) : [];
  $: if (path && path !== loadedPath) {
    loadedPath = path;
    status = null;
    errors = { action: "", refresh: "" };
    notice = "";
    selectedFile = null;
    diff = null;
    amend = false;
    void refresh();
  }

  onMount(() => {
    const handleFocus = () => void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
    };
  });

  async function refresh(): Promise<void> {
    if (!gitAvailable || refreshing || operation || !path) return;
    const requestedPath = path;
    refreshing = true;
    try {
      const next = await invoke<GitStatus>("git_status", { path: requestedPath });
      if (path === requestedPath) {
        status = next;
        errors = updateGitPanelError(errors, "refresh", "");
      }
    } catch (reason) {
      errors = updateGitPanelError(errors, "refresh", messageOf(reason));
    } finally {
      refreshing = false;
    }
  }

  async function openDiff(file: GitFileStatus, stagedVersion: boolean): Promise<void> {
    errors = updateGitPanelError(errors, "action", "");
    selectedFile = { file, staged: stagedVersion };
    diff = null;
    diffLoading = true;
    try {
      diff = await invoke<GitDiff>("git_diff", { path, filePath: file.path, staged: stagedVersion });
    } catch (reason) {
      errors = updateGitPanelError(errors, "action", messageOf(reason));
    } finally {
      diffLoading = false;
    }
  }

  async function mutate(command: string, args: Record<string, unknown>, label: string): Promise<boolean> {
    if (operation) return false;
    operation = label;
    errors = updateGitPanelError(errors, "action", "");
    notice = "";
    try {
      const result = await invoke<GitOperationResult>(command, { path, ...args });
      notice = result.message;
      selectedFile = null;
      diff = null;
      return true;
    } catch (reason) {
      errors = updateGitPanelError(errors, "action", messageOf(reason));
      return false;
    } finally {
      operation = "";
      await refresh();
    }
  }

  async function commit(): Promise<void> {
    if (await mutate("git_commit", { message: commitMessage, amend, signoff }, amend ? "正在修补上次提交..." : "正在提交...")) {
      commitMessage = "";
      amend = false;
    }
  }

  async function restore(files: GitFileStatus[]): Promise<void> {
    const paths = restorePaths(files);
    if (paths.length === 0) return;
    const subject = paths.length === 1 ? `“${paths[0]}”的未暂存更改` : `${paths.length} 个文件的未暂存更改`;
    if (!window.confirm(`确定放弃${subject}吗？此操作无法撤销。`)) return;
    await mutate("git_restore", { paths }, "正在恢复工作树文件...");
  }

  async function toggleAmend(): Promise<void> {
    if (!amend) {
      commitMessage = "";
      return;
    }
    if (commitMessage.trim()) return;
    try {
      commitMessage = (await invoke<string | null>("git_head_message", { path })) ?? "";
    } catch {
      // 读取不到上次提交信息时保持输入框为空，仍可手动填写
    }
  }

  async function switchBranch(event: Event): Promise<void> {
    const branch = (event.currentTarget as HTMLSelectElement).value;
    if (!branch || branch === status?.branch) return;
    await mutate("git_switch_branch", { branch, create: false }, "正在切换分支...");
  }

  async function createBranch(): Promise<void> {
    if (await mutate("git_switch_branch", { branch: newBranch, create: true }, "正在创建分支...")) {
      newBranch = "";
      showNewBranch = false;
    }
  }

  async function push(): Promise<void> {
    if (!status) return;
    if (!status.upstream) {
      if (status.remotes.length === 0) {
        errors = updateGitPanelError(errors, "action", "仓库没有可用远端，请先在终端配置 remote");
        return;
      }
      selectedRemote = status.remotes.includes("origin") ? "origin" : status.remotes[0];
      showRemotePicker = true;
      return;
    }
    await mutate("git_push", { remote: null, forceWithLease: false }, "正在推送...");
  }

  async function pushWithUpstream(): Promise<void> {
    if (await mutate("git_push", { remote: selectedRemote, forceWithLease: false }, "正在建立 upstream 并推送...")) {
      showRemotePicker = false;
    }
  }

  async function forcePush(): Promise<void> {
    if (!status?.branch || !status.upstream) return;
    const confirmed = window.confirm(
      `确定将“${status.branch}”安全强制推送到“${status.upstream}”吗？\n\n将使用 git push --force-with-lease；如果远端已有未获取的新提交，Git 会拒绝推送。`,
    );
    if (!confirmed) return;
    await mutate("git_push", { remote: null, forceWithLease: true }, "正在安全强制推送...");
  }

  function handleCommitKey(event: KeyboardEvent): void {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
  }

  function messageOf(reason: unknown): string {
    return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "Git 操作失败";
  }
</script>

<aside class="git-panel" aria-label="Git 源码管理">
  <header class="git-panel-header">
    <FolderGit2 size={17} />
    <strong>源码管理</strong>
    <button class="icon-button" title="刷新 Git 状态" disabled={refreshing || Boolean(operation)} on:click={() => void refresh()}>
      <RefreshCw size={15} class={refreshing ? "spinning" : ""} />
    </button>
    <button class="icon-button" title="关闭源码管理" on:click={onClose}><X size={15} /></button>
  </header>

  <div class="git-workspace-path" title={path}>{path}</div>

  {#if !gitAvailable}
    <div class="git-empty"><FolderGit2 size={24} /><p>未找到 Git for Windows</p><span>安装 Git 后重启 ShellGrid 即可使用源码管理。</span></div>
  {:else if refreshing && !status}
    <div class="git-empty"><RefreshCw class="spinning" size={22} /><p>正在读取仓库状态...</p></div>
  {:else if status && !status.isRepository}
    <div class="git-empty"><FolderGit2 size={24} /><p>此文件夹不是 Git 仓库</p><span>工作区和终端仍可正常使用。</span></div>
  {:else if status}
    <section class="git-repository-bar">
      <GitBranch size={15} />
      {#if status.detached}
        <span class="git-detached">分离 HEAD</span>
      {:else}
        <select title="切换本地分支" value={status.branch ?? ""} disabled={Boolean(operation)} on:change={(event) => void switchBranch(event)}>
          {#each status.branches as branch}
            <option value={branch.name}>{branch.name}</option>
          {/each}
        </select>
      {/if}
      {#if status.ahead || status.behind}<span class="git-sync-count">↓{status.behind} ↑{status.ahead}</span>{/if}
      <button class="icon-button" title="新建并切换分支" disabled={Boolean(operation)} on:click={() => (showNewBranch = !showNewBranch)}><Plus size={15} /></button>
      <button class="icon-button" title={status.upstream ? "拉取（仅快进）" : "当前分支没有 upstream"} disabled={Boolean(operation) || !status.upstream} on:click={() => void mutate("git_pull", {}, "正在拉取...")}><ArrowDownToLine size={15} /></button>
      <button class="icon-button" title="推送" disabled={Boolean(operation) || status.detached} on:click={() => void push()}><ArrowUpFromLine size={15} /></button>
      <button class="icon-button git-force-push" title={status.upstream ? "安全强制推送（--force-with-lease）" : "当前分支没有 upstream，无法强制推送"} disabled={Boolean(operation) || status.detached || !status.upstream} on:click={() => void forcePush()}><ShieldAlert size={15} /></button>
    </section>

    {#if showNewBranch}
      <form class="git-inline-form" on:submit|preventDefault={() => void createBranch()}>
        <input aria-label="新分支名称" placeholder="新分支名称" spellcheck="false" bind:value={newBranch} />
        <button class="icon-button" title="创建分支" disabled={!newBranch.trim() || Boolean(operation)}><Check size={15} /></button>
        <button type="button" class="icon-button" title="取消" on:click={() => (showNewBranch = false)}><X size={15} /></button>
      </form>
    {/if}

    {#if showRemotePicker}
      <div class="git-inline-form remote-picker">
        <span>建立 upstream</span>
        <select aria-label="选择 Git 远端" bind:value={selectedRemote}>
          {#each status.remotes as remote}<option value={remote}>{remote}</option>{/each}
        </select>
        <button class="icon-button" title="确认并推送" disabled={!selectedRemote || Boolean(operation)} on:click={() => void pushWithUpstream()}><Check size={15} /></button>
        <button class="icon-button" title="取消" on:click={() => (showRemotePicker = false)}><X size={15} /></button>
      </div>
    {/if}

    {#if operation}<div class="git-progress">{operation}</div>{/if}
    {#if error}
      <div class="git-message error" role="alert">
        <span>{error}</span>
        <button class="icon-button" aria-label="关闭 Git 错误提示" title="关闭错误提示" on:click={() => (errors = { action: "", refresh: "" })}><X size={13} /></button>
      </div>
    {/if}
    {#if notice}<div class="git-message">{notice}</div>{/if}

    <div class="git-scroll">
      <section class="git-change-group">
        <header><span>已暂存</span><b>{staged.length}</b>{#if staged.length}<button class="icon-button" title="全部取消暂存" disabled={Boolean(operation)} on:click={() => void mutate("git_unstage", { paths: operationPaths(staged) }, "正在取消暂存...")}><Minus size={14} /></button>{/if}</header>
        {#each staged as file (`staged:${file.path}`)}
          <div class:selected={selectedFile?.staged && selectedFile.file.path === file.path} class="git-file-row">
            <button class="git-file-main" title={file.path} on:click={() => void openDiff(file, true)}>
              <FileDiff size={14} /><span><strong>{fileName(file.path)}</strong>{#if parentPath(file.path)}<small>{parentPath(file.path)}</small>{/if}</span><em title={gitStatusLabel(file.indexStatus)}>{file.indexStatus}</em>
            </button>
            <button class="icon-button" title="取消暂存" disabled={Boolean(operation)} on:click={() => void mutate("git_unstage", { paths: operationPaths([file]) }, "正在取消暂存...")}><Minus size={14} /></button>
          </div>
        {:else}<p class="git-group-empty">没有已暂存的更改</p>{/each}
      </section>

      <section class="git-change-group">
        <header><span>更改</span><b>{working.length}</b>{#if restorePaths(working).length}<button class="icon-button" title="放弃全部未暂存更改（不含未跟踪文件）" disabled={Boolean(operation)} on:click={() => void restore(working)}><Undo2 size={14} /></button>{/if}{#if working.length}<button class="icon-button" title="全部暂存" disabled={Boolean(operation)} on:click={() => void mutate("git_stage", { paths: operationPaths(working) }, "正在暂存...")}><Plus size={14} /></button>{/if}</header>
        {#each working as file (`working:${file.path}`)}
          <div class:selected={!selectedFile?.staged && selectedFile?.file.path === file.path} class="git-file-row">
            <button class="git-file-main" title={file.path} on:click={() => void openDiff(file, false)}>
              <FileDiff size={14} /><span><strong>{fileName(file.path)}</strong>{#if parentPath(file.path)}<small>{parentPath(file.path)}</small>{/if}</span><em title={gitStatusLabel(file.worktreeStatus)}>{file.worktreeStatus}</em>
            </button>
            {#if file.indexStatus !== "?"}<button class="icon-button" title="放弃未暂存更改（git restore）" disabled={Boolean(operation)} on:click={() => void restore([file])}><Undo2 size={14} /></button>{/if}
            <button class="icon-button" title="暂存" disabled={Boolean(operation)} on:click={() => void mutate("git_stage", { paths: operationPaths([file]) }, "正在暂存...")}><Plus size={14} /></button>
          </div>
        {:else}<p class="git-group-empty">工作树没有未暂存更改</p>{/each}
      </section>

    </div>

    {#if selectedFile}
      <section class="git-diff-view">
        <header><span title={selectedFile.file.path}>{selectedFile.staged ? "已暂存差异" : "工作树差异"} · {fileName(selectedFile.file.path)}</span><button class="icon-button" title="关闭差异" on:click={() => { selectedFile = null; diff = null; }}><X size={14} /></button></header>
        {#if diffLoading}<p class="git-group-empty">正在加载差异...</p>
        {:else if diff?.binary}<p class="git-group-empty">二进制文件不显示文本差异。</p>
        {:else if diff?.content}
          <pre>{#key selectedFile.file.path}{#each diff.content.split("\n") as line}<span class={`diff-${diffLineKind(line)}`}>{line}
</span>{/each}{/key}</pre>
          {#if diff.truncated}<p class="git-diff-truncated">差异过大，仅显示前 256 KiB。</p>{/if}
        {:else}<p class="git-group-empty">没有可显示的文本差异。</p>{/if}
      </section>
    {/if}

    <form class="git-commit" on:submit|preventDefault={() => void commit()}>
      <textarea aria-label="提交信息" placeholder="提交信息（Ctrl+Enter 提交）" rows="6" bind:value={commitMessage} on:keydown={handleCommitKey}></textarea>
      <div class="git-commit-options">
        <label title="修补上次提交（git commit --amend）"><input type="checkbox" bind:checked={amend} disabled={Boolean(operation)} on:change={() => void toggleAmend()} />修补提交</label>
        <label title="在提交信息末尾追加 Signed-off-by（git commit --signoff）"><input type="checkbox" bind:checked={signoff} disabled={Boolean(operation)} />Signed-off</label>
      </div>
      <button class="git-command-button" disabled={!commitMessage.trim() || (staged.length === 0 && !amend) || Boolean(operation)}><GitCommitHorizontal size={15} />{amend ? "修补提交" : "提交"}</button>
    </form>
  {/if}
</aside>
