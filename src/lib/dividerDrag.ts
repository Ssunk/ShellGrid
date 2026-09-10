import type { SplitDirection } from "./types";

/** Track one captured pointer, committing at most once per frame and once on release. */
export function startDividerDrag(event: PointerEvent, direction: SplitDirection, updateRatio: (ratio: number) => void): () => void {
  const divider = event.currentTarget as HTMLElement;
  const container = divider.parentElement!;
  const pointerId = event.pointerId;
  const horizontal = direction === "horizontal";
  const startX = event.clientX, startY = event.clientY;
  let position: { x: number; y: number } | undefined;
  let frame: number | undefined;
  let moved = false;
  let active = true;

  const flush = () => {
    frame = undefined;
    if (!active || !position || !container.isConnected) return;
    const latest = position;
    position = undefined;
    const bounds = container.getBoundingClientRect();
    const size = horizontal ? bounds.width : bounds.height;
    if (size <= 0) return;
    updateRatio(horizontal ? (latest.x - bounds.left) / size : (latest.y - bounds.top) / size);
  };
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    moved = true;
    position = { x: moveEvent.clientX, y: moveEvent.clientY };
    if (frame === undefined) frame = requestAnimationFrame(flush);
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    position = undefined;
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", done);
    divider.removeEventListener("pointercancel", done);
    divider.removeEventListener("lostpointercapture", done);
    if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
  };
  const done = (endEvent: PointerEvent) => {
    if (endEvent.pointerId !== pointerId) return;
    if (endEvent.type === "pointerup" && (moved || endEvent.clientX !== startX || endEvent.clientY !== startY)) {
      position = { x: endEvent.clientX, y: endEvent.clientY };
    }
    if (frame !== undefined) cancelAnimationFrame(frame);
    // Commit the final position even if pointerup arrives before the frame.
    flush();
    cleanup();
  };
  divider.setPointerCapture(pointerId);
  event.preventDefault();
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", done);
  divider.addEventListener("pointercancel", done);
  divider.addEventListener("lostpointercapture", done);
  return cleanup;
}
