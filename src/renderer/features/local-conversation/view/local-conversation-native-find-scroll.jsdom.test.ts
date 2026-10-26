import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createLocalConversationNativeFindScroll } from "./local-conversation-native-find-scroll";

function frames() {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  return {
    pending,
    flush: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback(0);
      }
    },
  };
}

function fixture(input: { targetTop?: number; scrollTop?: number } = {}) {
  vi.useFakeTimers();
  const frame = frames();
  const viewport = document.createElement("div");
  const geometry = { height: 1_600, targetTop: input.targetTop ?? 800, clientHeight: 400 };
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => geometry.height },
    clientHeight: { get: () => geometry.clientHeight },
    offsetHeight: { get: () => geometry.clientHeight },
    clientTop: { value: 0 },
  });
  viewport.scrollTop = input.scrollTop ?? 600;
  viewport.getBoundingClientRect = () => new DOMRect(0, 10, 500, geometry.clientHeight);
  document.body.append(viewport);
  const newMark = () => {
    const mark = document.createElement("mark");
    mark.getBoundingClientRect = () => new DOMRect(0, geometry.targetTop, 100, 20);
    const scroll = vi.fn();
    mark.scrollIntoView = scroll;
    viewport.append(mark);
    return { mark, scroll };
  };
  const first = newMark();
  let target: HTMLElement | null = first.mark;
  const readTarget = vi.fn(() => target);
  const finished = vi.fn();
  const abort = new AbortController();
  const operation = createLocalConversationNativeFindScroll({
    scrollElement: viewport,
    readTarget,
    signal: abort.signal,
    onFinish: finished,
  });
  return {
    ...first,
    viewport,
    geometry,
    frame,
    readTarget,
    finished,
    abort,
    operation,
    newMark,
    setTarget: (next: HTMLElement | null) => {
      target = next;
    },
    scrollEnd: () => viewport.dispatchEvent(new Event("scrollend")),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("native Find scroll lifetime", () => {
  test.each([
    { scrollTop: 600, targetTop: 200 },
    { scrollTop: 0, targetTop: 20 },
    { scrollTop: 1_200, targetTop: 380 },
  ])(
    "finishes an already positioned request without scrollend at scrollTop $scrollTop",
    async (input) => {
      const value = fixture(input);
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.scroll).toHaveBeenCalledOnce();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.scroll).toHaveBeenCalledOnce();
      expect(value.frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("compensation retires a pending no-motion confirmation before its layout frame", async () => {
    const value = fixture({ targetTop: 200 });
    value.geometry.targetTop = 800;
    value.geometry.height += 100;
    value.operation.resume();
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.scroll).toHaveBeenCalledTimes(2);
    expect(value.frame.pending.size).toBe(0);
    value.geometry.targetTop = 200;
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test("a replacement mark requires its own native request and layout confirmation", async () => {
    const value = fixture({ targetTop: 200 });
    value.mark.remove();
    const replacement = value.newMark();
    value.setTarget(replacement.mark);
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).not.toHaveBeenCalled();
    expect(replacement.scroll).toHaveBeenCalledOnce();
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.scroll).toHaveBeenCalledOnce();
  });

  test("changed dimensions invalidate a pending no-motion confirmation", async () => {
    const value = fixture({ targetTop: 200 });
    value.geometry.height += 100;
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.scroll).toHaveBeenCalledTimes(2);
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test("abort cancels a pending no-motion confirmation without another native request", async () => {
    const value = fixture({ targetTop: 200 });
    value.abort.abort();
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.scroll).toHaveBeenCalledOnce();
    expect(value.frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an in-flight request cannot finish merely because its target moves to center after requesting", async () => {
    const value = fixture();
    value.scroll.mockImplementationOnce(() => {
      value.geometry.targetTop = 200;
    });
    value.operation.resume();
    value.frame.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.frame.pending.size).toBe(0);
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test("resumes native center once after compensation and ignores its early scrollend", async () => {
    const value = fixture();
    expect(value.scroll).toHaveBeenCalledExactlyOnceWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    value.geometry.height += 1_460;
    value.operation.resume();
    value.operation.resume();
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.frame.pending.size).toBe(1);
    value.frame.flush();
    expect(value.scroll).toHaveBeenCalledTimes(2);
    value.scrollEnd();
    expect(value.finished).not.toHaveBeenCalled();
    value.geometry.targetTop = 200;
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    value.operation.resume();
    value.scrollEnd();
    value.frame.flush();
    expect(value.scroll).toHaveBeenCalledTimes(2);
  });

  test("waits for a same-query mark remount without scrolling the detached mark", async () => {
    const value = fixture();
    value.mark.remove();
    value.setTarget(null);
    value.operation.resume();
    for (let i = 0; i < 5; i += 1) {
      value.frame.flush();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.scroll).toHaveBeenCalledOnce();
    const replacement = value.newMark();
    value.setTarget(replacement.mark);
    value.geometry.targetTop = 200;
    value.frame.flush();
    expect(replacement.scroll).toHaveBeenCalledExactlyOnceWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    expect(value.finished).not.toHaveBeenCalled();
    value.frame.flush();
    expect(value.frame.pending.size).toBe(0);
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("retargets a new connected mark at scrollend before accepting its geometry", async () => {
    const value = fixture();
    value.mark.remove();
    const replacement = value.newMark();
    value.setTarget(replacement.mark);
    value.geometry.targetTop = 200;
    value.scrollEnd();
    expect(value.frame.pending.size).toBe(1);
    expect(value.finished).not.toHaveBeenCalled();
    value.frame.flush();
    expect(replacement.scroll).toHaveBeenCalledOnce();
    value.scrollEnd();
    expect(value.finished).not.toHaveBeenCalled();
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test("content growth requires a fresh native request before completion", async () => {
    const value = fixture();
    value.geometry.targetTop = 200;
    value.geometry.height += 100;
    value.scrollEnd();
    expect(value.finished).not.toHaveBeenCalled();
    expect(value.frame.pending.size).toBe(1);
    value.frame.flush();
    expect(value.scroll).toHaveBeenCalledTimes(2);
    value.scrollEnd();
    expect(value.finished).not.toHaveBeenCalled();
    value.frame.flush();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test("uses the current padded viewport center after footer changes", async () => {
    const value = fixture();
    value.viewport.style.scrollPaddingBottom = "20%";
    value.geometry.targetTop = 200;
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).not.toHaveBeenCalled();
    value.geometry.targetTop = 160;
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
  });

  test.each([
    { scrollTop: 0, targetTop: 20 },
    { scrollTop: 1_200, targetTop: 380 },
  ])("accepts a visible native edge clamp at scrollTop $scrollTop", async (input) => {
    const value = fixture();
    value.viewport.scrollTop = input.scrollTop;
    value.geometry.targetTop = input.targetTop;
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.scroll).toHaveBeenCalledOnce();
  });

  test("resumes and missing-mark polling share the original 1500ms deadline", async () => {
    const value = fixture();
    await vi.advanceTimersByTimeAsync(1_400);
    value.mark.remove();
    value.setTarget(null);
    value.operation.resume();
    value.frame.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const replacement = value.newMark();
    value.setTarget(replacement.mark);
    value.operation.resume();
    value.frame.flush();
    expect(replacement.scroll).not.toHaveBeenCalled();
  });

  test("abort and repeated cancel release pending resources without another scroll", async () => {
    const value = fixture();
    value.operation.resume();
    value.abort.abort();
    value.operation.cancel();
    value.operation.resume();
    value.frame.flush();
    value.scrollEnd();
    await Promise.resolve();
    expect(value.finished).toHaveBeenCalledOnce();
    expect(value.scroll).toHaveBeenCalledOnce();
    expect(value.frame.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("already aborted construction finishes asynchronously without reading or scrolling", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    abort.abort();
    const readTarget = vi.fn();
    const onFinish = vi.fn();
    createLocalConversationNativeFindScroll({
      scrollElement: document.createElement("div"),
      readTarget,
      signal: abort.signal,
      onFinish,
    });
    expect(onFinish).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(readTarget).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
