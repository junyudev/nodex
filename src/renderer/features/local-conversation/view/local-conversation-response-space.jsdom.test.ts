import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createThreadResponseSpaceController } from "./local-conversation-response-space";

function fixture() {
  let viewport: HTMLDivElement | null = document.createElement("div");
  let distance = 200;
  let clientHeight = 800;
  let scrollHeight = 2_000;
  let spacerTop = 500;
  const calls: number[] = [];
  Object.defineProperty(viewport, "clientHeight", { get: () => clientHeight });
  Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight });
  viewport.style.setProperty("--thread-scroll-padding-bottom", "100px");
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 }) as DOMRect;
  const spacer = document.createElement("div");
  spacer.getBoundingClientRect = () =>
    ({ top: spacerTop, bottom: spacerTop + 100, height: 100 }) as DOMRect;
  const hold = vi.fn();
  const released = vi.fn();
  const scroll = {
    getScrollElement: () => viewport,
    getScrollDistanceFromBottomPx: () => distance,
    getLastScrollDistanceFromBottomPx: () => distance,
    getUnroundedScrollDistanceFromBottomPx: (fallback: number) => fallback,
    compensateScrollToDistanceFromBottomPx: (next: number) => {
      distance = next;
      calls.push(next);
    },
    scrollToDistanceFromBottomPx: (next: number) => {
      distance = next;
      calls.push(next);
    },
    holdViewport: hold,
  };
  const owner = createThreadResponseSpaceController(scroll);
  owner.updateContext(scroll, true, released);
  owner.setElement(spacer);
  return {
    owner,
    calls,
    hold,
    released,
    spacer,
    scroll,
    get distance() {
      return distance;
    },
    setDistance: (next: number) => {
      distance = next;
    },
    setViewportHeight: (next: number) => {
      clientHeight = next;
    },
    setScrollHeight: (next: number) => {
      scrollHeight = next;
    },
    setSpacerTop: (next: number) => {
      spacerTop = next;
    },
    retireViewport: () => {
      viewport = null;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("thread response space", () => {
  test("places at one native pixel with a fixed bounded response space under reduced motion", () => {
    const f = fixture();
    f.owner.place();
    expect(f.hold).toHaveBeenCalledOnce();
    expect(f.owner.getHeightPx()).toBe(460);
    expect(f.spacer.style.height).toBe("460px");
    expect(f.calls).toEqual([1]);
  });
  test("consumes only positive layout growth and never grows after collapse", () => {
    const f = fixture();
    f.owner.place();
    f.owner.consumeGrowth(100.25);
    expect(f.owner.getHeightPx()).toBe(359.75);
    f.owner.consumeGrowth(-100);
    expect(f.owner.getHeightPx()).toBe(359.75);
    f.owner.consumeGrowth(500);
    f.owner.consumeGrowth(-500);
    expect(f.owner.getHeightPx()).toBe(0);
    expect(f.calls).toEqual([1]);
  });
  test("accumulates real upward user deltas once per frame without discarding sub-24px changes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const f = fixture();
    f.owner.place();
    f.setDistance(13);
    f.owner.handleUserScroll(6, 1);
    f.owner.handleUserScroll(13, 6);
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(f.owner.getHeightPx()).toBe(448);
    expect(f.distance).toBe(1);
  });
  test("ignores toward-bottom deltas but reaching exact zero clears space", () => {
    const f = fixture();
    f.owner.place();
    f.owner.handleUserScroll(100, 200);
    expect(f.owner.getHeightPx()).toBe(460);
    f.owner.handleUserScroll(0, 100);
    expect(f.owner.getHeightPx()).toBe(0);
  });
  test("retires queued decay when its viewport is replaced", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    const f = fixture();
    f.owner.place();
    f.owner.handleUserScroll(101, 1);
    f.retireViewport();
    frames[0]?.(0);
    expect(f.owner.getHeightPx()).toBe(460);
  });
  test("trims for viewport or footer shrink with equal scroll compensation", () => {
    const f = fixture();
    f.owner.place();
    f.setDistance(300);
    f.setViewportHeight(600);
    f.owner.reconcileViewport();
    expect(f.owner.getHeightPx()).toBe(260);
    expect(f.distance).toBe(100);
    f.setViewportHeight(1_000);
    f.owner.reconcileViewport();
    expect(f.owner.getHeightPx()).toBe(260);
  });
  test("retains visible space then collapses at the one physical-pixel content edge", () => {
    const f = fixture();
    f.owner.place();
    f.setDistance(500);
    f.setSpacerTop(698.5);
    f.owner.collapseIfHidden();
    expect(f.owner.getHeightPx()).toBe(460);
    f.setSpacerTop(699);
    f.owner.collapseIfHidden();
    expect(f.owner.getHeightPx()).toBe(0);
    expect(f.distance).toBe(40);
    expect(f.released).toHaveBeenCalledOnce();
  });
  test("clears space only when native content truly fits at exact bottom", () => {
    const f = fixture();
    f.owner.place();
    f.setScrollHeight(800);
    f.owner.handleScroll(1);
    expect(f.owner.getHeightPx()).toBe(460);
    f.owner.handleScroll(0);
    expect(f.owner.getHeightPx()).toBe(0);
  });
});
