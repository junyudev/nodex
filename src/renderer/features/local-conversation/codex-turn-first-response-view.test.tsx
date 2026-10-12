import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAfterPaintMarker } from "./codex-turn-first-response-view";

const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

it("waits for two visible frames again if the document hides before the paint callback", async () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const onPaint = vi.fn();
  const view = render(<CodexAfterPaintMarker onPaint={onPaint} />);
  const frame = async () => {
    const next = frames.entries().next().value;
    if (!next) throw new Error("Missing scheduled frame");
    frames.delete(next[0]);
    await act(async () => {
      next[1](0);
      await Promise.resolve();
    });
  };
  await frame();
  visibility = "hidden";
  await frame();
  expect(onPaint).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  visibility = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  await frame();
  await frame();
  expect(onPaint).toHaveBeenCalledOnce();
  view.unmount();
  expect(frames.size).toBe(0);
});

it("cancels scheduled paint work when the marker unmounts", () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(12);
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const onPaint = vi.fn();
  const view = render(<CodexAfterPaintMarker onPaint={onPaint} />);
  view.unmount();
  expect(cancel).toHaveBeenCalledWith(12);
  expect(onPaint).not.toHaveBeenCalled();
});
