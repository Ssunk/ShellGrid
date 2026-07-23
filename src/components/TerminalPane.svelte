<script lang="ts">
  import { getContext, onMount } from "svelte";
  import { SplitSquareHorizontal, SplitSquareVertical, X, SquareTerminal } from "lucide-svelte";
  import { APP_CONTEXT, type AppController } from "../lib/appContext";
  import type { PaneLaunchInfo, SessionState } from "../lib/types";

  export let paneId: string;
  export let active: boolean;
  export let launch: PaneLaunchInfo;
  export let session: SessionState | undefined;
  const app = getContext<AppController>(APP_CONTEXT);
  let host: HTMLDivElement;
  let observer: ResizeObserver;

  onMount(() => {
    app.mountTerminal(paneId, host);
    observer = new ResizeObserver(() => app.resizeTerminal(paneId));
    observer.observe(host);
    return () => observer.disconnect();
  });
</script>

<section role="application" class:active class="terminal-pane" on:pointerdown={() => app.setActivePane(paneId)}>
  <header class="pane-header">
    <SquareTerminal size={14} strokeWidth={1.8} />
    <span class="pane-title" title={launch.cwd}>{launch.title || launch.cwd}</span>
    <span class:running={session?.running} class:error={Boolean(session?.error)} class="session-status">
      {session?.error ? "错误" : session?.running ? "运行中" : session?.exitCode !== undefined ? `已退出 ${session.exitCode}` : "启动中"}
    </span>
    <button class="icon-button" title="左右分割 (Ctrl+Shift+H)" on:click|stopPropagation={() => app.split(paneId, "horizontal")}>
      <SplitSquareHorizontal size={15} />
    </button>
    <button class="icon-button" title="上下分割 (Ctrl+Shift+V)" on:click|stopPropagation={() => app.split(paneId, "vertical")}>
      <SplitSquareVertical size={15} />
    </button>
    <button class="icon-button close-button" title="关闭窗格 (Ctrl+Shift+W)" on:click|stopPropagation={() => app.close(paneId)}>
      <X size={15} />
    </button>
  </header>
  <div class="terminal-host" bind:this={host}></div>
</section>
