<script lang="ts">
  import { getContext } from "svelte";
  import type { LayoutNode, PaneLaunchInfo, SessionState } from "../lib/types";
  import { APP_CONTEXT, type AppController } from "../lib/appContext";
  import TerminalPane from "./TerminalPane.svelte";

  export let node: LayoutNode;
  export let path = "";
  export let activePaneId: string;
  export let panes: Record<string, PaneLaunchInfo>;
  export let sessions: Record<string, SessionState>;
  const app = getContext<AppController>(APP_CONTEXT);

  function dragDivider(event: PointerEvent): void {
    if (node.type !== "split") return;
    const divider = event.currentTarget as HTMLElement;
    const container = divider.parentElement!;
    divider.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      const ratio = node.type === "split" && node.direction === "horizontal"
        ? (moveEvent.clientX - bounds.left) / bounds.width
        : (moveEvent.clientY - bounds.top) / bounds.height;
      app.updateRatio(path, ratio);
    };
    const done = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", done);
      divider.removeEventListener("pointercancel", done);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", done);
    divider.addEventListener("pointercancel", done);
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
