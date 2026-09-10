import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDividerDrag } from "./dividerDrag";
import type { SplitDirection } from "./types";

const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup(direction: SplitDirection = "horizontal") {
  const container = document.createElement("div");
  const divider = document.createElement("div");
  container.append(divider);
  document.body.append(container);
  const bounds = vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 800, height: 600 } as DOMRect);
  let captured = false;
  divider.setPointerCapture = vi.fn(() => { captured = true; });
  divider.hasPointerCapture = vi.fn(() => captured);
  divider.releasePointerCapture = vi.fn(() => { captured = false; });
  const updateRatio = vi.fn();
  let stop!: () => void;
  divider.addEventListener("pointerdown", (event) => {
    stop = startDividerDrag(event, direction, updateRatio);
    cleanups.push(stop);
  });
  function pointer(type: string, x: number, y = 350, pointerId = 7) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    divider.dispatchEvent(event);
  }
  pointer("pointerdown", 500);
  return { divider, bounds, updateRatio, pointer, stop: () => stop() };
}

describe("divider pointer scheduling", () => {
  it("coalesces a burst of pointer moves into one measurement and the latest ratio", () => {
    const { pointer, bounds, updateRatio } = setup();
    for (let x = 501; x <= 660; x++) pointer("pointermove", x);
    expect(bounds).not.toHaveBeenCalled();
    expect(updateRatio).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(bounds).toHaveBeenCalledOnce();
    expect(updateRatio).toHaveBeenCalledExactlyOnceWith(0.7);
  });

  it("commits the release coordinates before the scheduled frame and releases capture", () => {
    const { divider, pointer, updateRatio } = setup();
    pointer("pointermove", 600);
    pointer("pointerup", 740);
    expect(updateRatio).toHaveBeenCalledExactlyOnceWith(0.8);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    vi.advanceTimersToNextFrame();
    pointer("pointermove", 820);
    expect(updateRatio).toHaveBeenCalledTimes(1);
  });

  it.each(["pointercancel", "lostpointercapture"])("flushes the last movement on %s without using invalid end coordinates", (type) => {
    const { pointer, updateRatio } = setup("vertical");
    pointer("pointermove", 500, 500);
    pointer(type, 0, 0);
    expect(updateRatio).toHaveBeenCalledExactlyOnceWith(0.75);
    vi.advanceTimersToNextFrame();
    expect(updateRatio).toHaveBeenCalledTimes(1);
  });

  it("ignores other pointers and does not change a ratio for a click without movement", () => {
    const { pointer, updateRatio } = setup();
    pointer("pointermove", 740, 350, 99);
    pointer("pointerup", 740, 350, 99);
    vi.advanceTimersToNextFrame();
    pointer("pointerup", 500);
    expect(updateRatio).not.toHaveBeenCalled();
  });

  it("remeasures changed container bounds at the frame and ignores zero-size layouts", () => {
    const { pointer, bounds, updateRatio } = setup();
    pointer("pointermove", 700);
    bounds.mockReturnValue({ left: 100, top: 50, width: 1000, height: 600 } as DOMRect);
    vi.advanceTimersToNextFrame();
    expect(updateRatio).toHaveBeenCalledExactlyOnceWith(0.6);
    pointer("pointermove", 740);
    bounds.mockReturnValue({ left: 100, top: 50, width: 0, height: 0 } as DOMRect);
    vi.advanceTimersToNextFrame();
    expect(updateRatio).toHaveBeenCalledTimes(1);
  });

  it("cancels queued updates and removes listeners when a split unmounts", () => {
    const { divider, pointer, stop, updateRatio } = setup();
    pointer("pointermove", 740);
    stop();
    vi.advanceTimersToNextFrame();
    pointer("pointerup", 820);
    expect(updateRatio).not.toHaveBeenCalled();
    expect(divider.releasePointerCapture).toHaveBeenCalledOnce();
  });
});
