<script lang="ts">
  import { getContext } from "svelte";
  import type { LayoutNode, PaneLaunchInfo, SessionState } from "../lib/types";
  import { APP_CONTEXT, type AppController } from "../lib/appContext";
  import { startDividerDrag } from "../lib/dividerDrag";
  import TerminalPane from "./TerminalPane.svelte";

  export let node: LayoutNode;
  export let path = "";
  export let activePaneId: string;
  export let panes: Record<string, PaneLaunchInfo>;
  export let sessions: Record<string, SessionState>;
  const app = getContext<AppController>(APP_CONTEXT);
  let stopDrag: (() => void) | undefined;

  function dividerLifecycle(_divider: HTMLElement) {
    return { destroy: () => { stopDrag?.(); stopDrag = undefined; } };
  }

  function dragDivider(event: PointerEvent): void {
    if (node.type !== "split" || event.button !== 0) return;
    stopDrag?.();
    const dragPath = path;
    stopDrag = startDividerDrag(event, node.direction, (ratio) => app.updateRatio(dragPath, ratio));
  }
</script>

{#if node.type === "pane"}
  <TerminalPane paneId={node.paneId} active={activePaneId === node.paneId} launch={panes[node.paneId]} session={sessions[node.paneId]} />
{:else}
  <div class:vertical={node.direction === "vertical"} class="split-root">
    <div class="split-child" style:flex-basis={`${node.ratio * 100}%`}>
      <svelte:self node={node.first} path={`${path}0`} {activePaneId} {panes} {sessions} />
    </div>
    <div
      use:dividerLifecycle
      class:vertical={node.direction === "vertical"}
      class="divider"
      role="separator"
      aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
      on:pointerdown={dragDivider}
    ></div>
    <div class="split-child" style:flex-basis={`${(1 - node.ratio) * 100}%`}>
      <svelte:self node={node.second} path={`${path}1`} {activePaneId} {panes} {sessions} />
    </div>
  </div>
{/if}
