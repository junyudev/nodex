import { afterEach, expect, test, vi } from "vite-plus/test";
import { act } from "@testing-library/react";
import { render } from "../../../test/dom";
import { createThreadResponseSpaceController } from "./local-conversation-response-space";
import { LocalConversationResponseSpaceElement } from "./local-conversation-response-space-element";

const harness = vi.hoisted(() => ({ element: null as HTMLDivElement | null }));
const scroll = {
  get scrollElement() {
    return harness.element;
  },
  getScrollElement: () => harness.element,
  getScrollDistanceFromBottomPx: () => 0,
  getLastScrollDistanceFromBottomPx: () => 0,
  getUnroundedScrollDistanceFromBottomPx: (fallback: number) => fallback,
  compensateScrollToDistanceFromBottomPx: vi.fn(),
  scrollToDistanceFromBottomPx: vi.fn(),
  holdViewport: vi.fn(),
  addScrollListener: () => () => {},
  addUserScrollListener: () => () => {},
};
vi.mock("./local-conversation-thread-scroll-controller", () => ({
  useLocalConversationThreadScrollController: () => scroll,
}));
afterEach(() => {
  harness.element = null;
  vi.unstubAllGlobals();
});

test("coalesces viewport and footer resize into one frame and cancels it on release", async () => {
  const element = document.createElement("div");
  const wrapper = document.createElement("div");
  const footer = document.createElement("div");
  footer.dataset.threadScrollFooter = "true";
  wrapper.append(element, footer);
  harness.element = element;
  const observers: Array<{
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const owner = createThreadResponseSpaceController(scroll);
  const reconcile = vi.spyOn(owner, "reconcileViewport");
  const view = render(
    <LocalConversationResponseSpaceElement controller={owner} onReleased={() => {}} />,
  );
  expect(reconcile).toHaveBeenCalledOnce();
  const observer = observers[0];
  if (!observer) throw new Error("missing viewport observer");
  expect(observer.observe.mock.calls.map(([target]) => target)).toEqual([element, footer]);
  const entries: ResizeObserverEntry[] = [element, footer].map((target) => ({
    target,
    contentRect: target.getBoundingClientRect(),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  }));
  await act(async () => {
    observer.callback(entries, observer as unknown as ResizeObserver);
    observer.callback(entries, observer as unknown as ResizeObserver);
    window.dispatchEvent(new Event("resize"));
  });
  expect(frames.size).toBe(1);
  expect(reconcile).toHaveBeenCalledOnce();
  await act(async () => {
    const [id, callback] = [...frames][0]!;
    frames.delete(id);
    callback(0);
  });
  expect(reconcile).toHaveBeenCalledTimes(2);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(frames.size).toBe(1);
  view.unmount();
  expect(cancelFrame).toHaveBeenCalledWith(2);
  expect(frames.size).toBe(0);
  expect(observer.unobserve.mock.calls.map(([target]) => target)).toEqual([element, footer]);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
});
