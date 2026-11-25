import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act } from "@testing-library/react";
import { useCallback, useEffect, type ReactNode } from "react";
import { installAsyncRequestAnimationFrame } from "../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../test/dom";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";

function ControllerProbe({
  onController,
}: {
  onController: (controller: LocalConversationThreadScrollControllerValue) => void;
}) {
  const controller = useLocalConversationThreadScrollController();
  useEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return null;
}

function installContentResizeObserver() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  class TestResizeObserver {
    private readonly record: { callback: ResizeObserverCallback; targets: Element[] };

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [] };
      observers.push(this.record);
    }

    disconnect() {}

    observe(target: Element) {
      this.record.targets.push(target);
    }

    unobserve() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
    writable: true,
  });
  return (target: Element) => {
    for (const observer of observers.filter((record) => record.targets.includes(target)))
      observer.callback([], observer as unknown as ResizeObserver);
  };
}

describe("LocalConversationThreadScrollLayout", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalElectronBridge = window.electronBridge;
  const originalApi = window.api;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    installAsyncRequestAnimationFrame();
  });

  afterEach(() => {
    if (typeof originalResizeObserver === "undefined") {
      Reflect.deleteProperty(
        globalThis as typeof globalThis & {
          ResizeObserver?: typeof ResizeObserver;
        },
        "ResizeObserver",
      );
    } else {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
        writable: true,
      });
    }

    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: originalGetBoundingClientRect,
      writable: true,
    });

    if (typeof originalApi === "undefined") Reflect.deleteProperty(window, "api");
    else Object.defineProperty(window, "api", { configurable: true, value: originalApi });

    if (typeof originalMatchMedia === "undefined") Reflect.deleteProperty(window, "matchMedia");
    else
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
        writable: true,
      });

    if (typeof originalElectronBridge === "undefined") {
      Reflect.deleteProperty(window, "electronBridge");
      return;
    }

    Object.defineProperty(window, "electronBridge", {
      configurable: true,
      value: originalElectronBridge,
      writable: true,
    });
  });

  test("carries only a reader at the bottom along with content growth below", async () => {
    const notifyResize = installContentResizeObserver();

    const fixture = await renderNativeFindController();
    const growContent = (scrollHeight: number) =>
      act(async () => {
        fixture.setScrollHeight(scrollHeight);
        notifyResize(fixture.viewport);
        await Promise.resolve();
      });
    try {
      await act(async () => {
        fixture.controller.jumpToBottom();
        fixture.viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      expect(fixture.viewport.scrollTop).toBe(1_500);

      // Deliver the initial size observation after the fixture installs native geometry.
      await growContent(2_000);
      await growContent(2_300);
      expect(fixture.viewport.scrollTop).toBe(1_800);
      expect(fixture.controller.getScrollDistanceFromBottomPx()).toBe(0);

      await act(async () => {
        fixture.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));
        fixture.viewport.scrollTop = 1_760;
        fixture.viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      expect(fixture.controller.getScrollMode()).toBe("user");
      const writesWhileReading = fixture.scrollWrites.length;

      await growContent(2_600);
      expect(fixture.viewport.scrollTop).toBe(1_760);
      expect(fixture.scrollWrites).toHaveLength(writesWhileReading);
    } finally {
      await fixture.dispose();
    }
  });

  test("expires upward intent without native movement and resumes content following", async () => {
    const notifyResize = installContentResizeObserver();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const fixture = await renderNativeFindController();
    try {
      await act(async () => {
        fixture.controller.jumpToBottom();
        fixture.viewport.dispatchEvent(new Event("scroll"));
        notifyResize(fixture.viewport);
        fixture.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
        await Promise.resolve();
      });
      expect(fixture.controller.getScrollMode()).toBe("stickToBottom");
      now.mockReturnValue(1_001);
      await act(async () => {
        fixture.setScrollHeight(2_300);
        notifyResize(fixture.viewport);
        await Promise.resolve();
      });
      expect(fixture.viewport.scrollTop).toBe(1_800);
      expect(fixture.controller.getScrollMode()).toBe("stickToBottom");
      await act(async () => {
        fixture.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
        fixture.viewport.scrollTop -= 8;
        fixture.controller.reconcilePendingUserScroll();
        await Promise.resolve();
      });
      expect(fixture.controller.getScrollMode()).toBe("user");
      now.mockReturnValue(2_002);
      await act(async () => {
        fixture.setScrollHeight(2_600);
        notifyResize(fixture.viewport);
        await Promise.resolve();
      });
      expect(fixture.viewport.scrollTop).toBe(1_792);
      expect(fixture.controller.getScrollMode()).toBe("user");
    } finally {
      now.mockRestore();
      await fixture.dispose();
    }
  });

  test("keeps a small upward scroll across footer rerenders with fractional zoom geometry", async () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
    class TestResizeObserver {
      private readonly record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set() };
        observers.push(this.record);
      }
      observe = (element: Element) => this.record.targets.add(element);
      unobserve = (element: Element) => this.record.targets.delete(element);
      disconnect = () => this.record.targets.clear();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });
    let controller: LocalConversationThreadScrollControllerValue | undefined;
    const capture = (next: LocalConversationThreadScrollControllerValue) => {
      controller = next;
    };
    function Fixture({ label }: { label: string }) {
      return (
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout footer={<div>{label}</div>}>
            <ControllerProbe onController={capture} />
            <div>Thread content</div>
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>
      );
    }
    const view = render(<Fixture label="Composer" />);
    await settleAsyncRender();
    const viewport = view.container.querySelector<HTMLDivElement>(
      "[data-local-conversation-thread-body]",
    )!;
    const footer = view.container.querySelector<HTMLDivElement>("[data-thread-scroll-footer]")!;
    const writes: ScrollToOptions[] = [];
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: {
        configurable: true,
        value: (options: ScrollToOptions) => {
          writes.push(options);
          viewport.scrollTop = options.top ?? 0;
        },
      },
    });
    // Zoomed bounds and ResizeObserver can differ while the footer itself remains unchanged.
    footer.style.setProperty("--codex-window-zoom", "0.9");
    footer.getBoundingClientRect = () =>
      createDomRect({ x: 0, y: 0, width: 300, height: 95.98958333333333 * 0.9 });
    const observer = observers.find((candidate) => candidate.targets.has(footer))!;
    try {
      await act(async () => {
        controller?.jumpToBottom();
        observer.callback(
          [
            {
              target: footer,
              borderBoxSize: [{ blockSize: 95.984375, inlineSize: 300 }],
            } as unknown as ResizeObserverEntry,
          ],
          observer as unknown as ResizeObserver,
        );
        viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
        viewport.scrollTop = 1_492;
        viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      const beforeRerender = writes.length;
      expect(controller?.getScrollMode()).toBe("user");
      await act(async () => {
        view.rerender(<Fixture label="Updated composer" />);
        await Promise.resolve();
      });
      expect(controller?.getScrollDistanceFromBottomPx()).toBe(8);
      expect(writes).toHaveLength(beforeRerender);
      expect(viewport.style.getPropertyValue("--thread-scroll-padding-bottom")).toBe(
        "111.984375px",
      );
    } finally {
      await act(async () => view.unmount());
    }
  });

  test("records pending latest-turn placement against response spacer height", async () => {
    let controller: LocalConversationThreadScrollControllerValue | null = null;
    const view = render(
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout>
          <ControllerProbe
            onController={(nextController) => {
              controller = nextController;
            }}
          />
          <div style={{ height: "1000px" }}>Thread content</div>
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const scrollContainer = view.container.querySelector(
      "[data-local-conversation-thread-body='true']",
    ) as HTMLDivElement | null;
    const activeController = controller as LocalConversationThreadScrollControllerValue | null;
    expect(scrollContainer !== null).toBe(true);
    if (!scrollContainer || activeController === null) return;

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    let scrollTopValue = 220;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await act(async () => {
      activeController.registerResponseSpacerState({
        getHeightPx: () => 100,
        scrollToBottom: () => {},
      });
      await Promise.resolve();
    });

    expect(activeController.hasPendingLatestTurnSubmitPlacement()).toBe(false);
    const placement = activeController.prepareLatestTurnSubmitPlacement();
    expect(activeController.hasPendingLatestTurnSubmitPlacement()).toBe(true);
    expect(placement?.distanceFromBottomPx ?? 0).toBe(280);
    expect(placement?.scrollHeightPx ?? 0).toBe(1000);
    expect(placement?.shouldPlaceLatestTurn ?? false).toBe(true);
    expect(
      activeController.consumePendingLatestTurnSubmitPlacement()?.distanceFromBottomPx ?? 0,
    ).toBe(280);
    expect(activeController.hasPendingLatestTurnSubmitPlacement()).toBe(false);
    expect(activeController.consumePendingLatestTurnSubmitPlacement() === null).toBe(true);
  });

  test.each([
    { distance: 0, movement: -8, mode: "user", action: "hold" },
    { distance: 28, movement: 8, mode: "stickToBottom", action: "resume" },
  ] as const)(
    "reconciles $action intent without publishing geometry before compensation",
    async ({ distance, movement, mode, action }) => {
      const fixture = await renderNativeFindController();
      const positions = vi.fn();
      const gestures = vi.fn();
      const holdViewport = vi.fn();
      const resumeFollowing = vi.fn();
      let removePositionListener = () => {};
      let removeGestureListener = () => {};
      try {
        await act(async () => {
          fixture.controller.scrollToDistanceFromBottomPx(distance, "instant", "user");
          fixture.controller.registerResponseSpacerState({
            getHeightPx: () => 0,
            scrollToBottom: () => {},
            holdViewport,
            resumeFollowing,
          });
          await Promise.resolve();
        });
        removePositionListener = fixture.controller.addScrollListener(positions);
        removeGestureListener = fixture.controller.addUserScrollListener(gestures);
        positions.mockClear();
        await act(async () => {
          fixture.viewport.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: movement }),
          );
          fixture.viewport.scrollTop += movement;
          fixture.setScrollHeight(2_300);
          fixture.controller.reconcilePendingUserScroll();
          await Promise.resolve();
        });
        expect(fixture.controller.getScrollMode()).toBe(mode);
        expect(fixture.controller.getLastScrollDistanceFromBottomPx()).toBe(distance);
        expect(fixture.controller.getRetainedScrollDistanceFromBottomPx()).toBe(
          distance - movement,
        );
        expect(positions).not.toHaveBeenCalled();
        expect(gestures).not.toHaveBeenCalled();
        expect(action === "hold" ? holdViewport : resumeFollowing).toHaveBeenCalledTimes(1);
        await act(async () => {
          fixture.controller.compensateScrollToDistanceFromBottomPx(distance - movement + 300);
          fixture.controller.reconcilePendingUserScroll();
          await Promise.resolve();
        });
        expect(fixture.controller.getScrollMode()).toBe(mode);
        expect(positions).toHaveBeenCalledExactlyOnceWith(distance - movement + 300, movement);
        expect(gestures).not.toHaveBeenCalled();
        expect(action === "hold" ? holdViewport : resumeFollowing).toHaveBeenCalledTimes(1);
      } finally {
        removePositionListener();
        removeGestureListener();
        await fixture.dispose();
      }
    },
  );
  test("a zero-displacement scroll event preserves the pending upward gesture at the bottom", async () => {
    const fixture = await renderNativeFindController();
    const displacements: Array<[number, number | undefined]> = [];
    const unsubscribe = fixture.controller.addUserScrollListener((distance, previous) =>
      displacements.push([distance, previous]),
    );
    try {
      await act(async () => {
        fixture.controller.jumpToBottom();
        fixture.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
        fixture.viewport.dispatchEvent(new Event("scroll"));
        fixture.viewport.scrollTop = 1_492;
        fixture.viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      expect(displacements).toEqual([[8, 0]]);
      expect(fixture.controller.getScrollMode()).toBe("user");
    } finally {
      unsubscribe();
      await fixture.dispose();
    }
  });

  test("a replacement viewport does not inherit the previous viewport's rounded scroll request", async () => {
    const controllers: LocalConversationThreadScrollControllerValue[] = [];
    const replacementDistances: number[] = [];
    function NativeViewport({ replacement }: { readonly replacement: boolean }) {
      const {
        registerScrollElement,
        getScrollDistanceFromBottomPx,
        getUnroundedScrollDistanceFromBottomPx,
      } = useLocalConversationThreadScrollController();
      const registerViewport = useCallback(
        (viewport: HTMLDivElement | null) => {
          if (viewport) {
            Object.defineProperties(viewport, {
              scrollHeight: { configurable: true, value: 2_000 },
              clientHeight: { configurable: true, value: 500 },
              scrollTo: {
                configurable: true,
                value: ({ top = 0 }: ScrollToOptions) => {
                  viewport.scrollTop = Math.round(top);
                },
              },
            });
            viewport.scrollTop = 1_400;
          }
          registerScrollElement(viewport);
          if (viewport && replacement)
            replacementDistances.push(
              getUnroundedScrollDistanceFromBottomPx(getScrollDistanceFromBottomPx()),
            );
        },
        [
          registerScrollElement,
          getScrollDistanceFromBottomPx,
          getUnroundedScrollDistanceFromBottomPx,
          replacement,
        ],
      );
      return <div ref={registerViewport} />;
    }
    const renderViewport = (key: string) => (
      <EnsureLocalConversationThreadScrollController>
        <ControllerProbe onController={(controller) => controllers.push(controller)} />
        <NativeViewport key={key} replacement={key === "replacement"} />
      </EnsureLocalConversationThreadScrollController>
    );
    const view = render(renderViewport("initial"));
    try {
      await settleAsyncRender();
      const controller = controllers.at(-1);
      if (!controller) throw new Error("Expected a mounted conversation controller.");
      const previousViewport = controller.getScrollElement();
      await act(async () => {
        controller.compensateScrollToDistanceFromBottomPx(100.5);
        await Promise.resolve();
      });
      expect(controller.getScrollDistanceFromBottomPx()).toBe(100);
      expect(controller.getUnroundedScrollDistanceFromBottomPx(100)).toBe(100.5);

      await act(async () => {
        view.rerender(renderViewport("replacement"));
        await Promise.resolve();
      });
      expect(controller.getScrollElement()).not.toBe(previousViewport);
      expect(replacementDistances).toEqual([100]);
    } finally {
      await act(async () => {
        view.unmount();
        await Promise.resolve();
      });
    }
  });

  test("keeps native Find active through the old settle window and resumes after layout writes", async () => {
    const fixture = await renderNativeFindController();
    try {
      await fixture.beginFind();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect(fixture.controller.getScrollMode()).toBe("programmaticFind");
      expect(fixture.controller.nativeFindTurnKey).toBe("find-turn");
      expect(fixture.controller.shouldFollowContentGrowth()).toBe(false);

      await act(async () => {
        fixture.controller.compensateScrollToDistanceFromBottomPx(240);
        await settleAsyncRender();
      });
      expect(fixture.scrollWrites.at(-1)).toEqual({ behavior: "instant", top: 1_260 });
      expect(fixture.findScrolls).toHaveLength(2);
      expect(fixture.findScrolls[1]).toEqual({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });

      // Composer clearance changes below a reader who is away from the bottom need no write.
      const writesBeforeFooterResize = fixture.scrollWrites.length;
      await act(async () => {
        fixture.controller.setFooterHeightPx(40);
        fixture.controller.setFooterHeightPx(80);
        await settleAsyncRender();
      });
      expect(fixture.scrollWrites).toHaveLength(writesBeforeFooterResize);
      expect(fixture.findScrolls).toHaveLength(2);
      expect(fixture.controller.getScrollMode()).toBe("programmaticFind");
      expect(fixture.controller.nativeFindTurnKey).toBe("find-turn");

      await act(async () => {
        fixture.setTargetTop(240);
        fixture.viewport.dispatchEvent(new Event("scrollend"));
        await Promise.resolve();
      });
      expect(fixture.controller.getScrollMode()).toBe("user");
      expect(fixture.controller.nativeFindTurnKey).toBeNull();
      await fixture.compensateAndSettle();
      expect(fixture.findScrolls).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  });

  test.each([
    "wheel",
    "scroll key",
    "scrollbar",
    "vertical touch",
    "submit",
    "another element navigation",
    "another distance navigation",
    "jump to bottom",
    "viewport hold",
  ] as const)("cancels native Find on %s before subsequent compensation", async (intent) => {
    const fixture = await renderNativeFindController();
    try {
      await fixture.beginFind();
      await act(async () => {
        switch (intent) {
          case "wheel":
            fixture.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
            break;
          case "scroll key":
            fixture.viewport.dispatchEvent(
              new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }),
            );
            break;
          case "scrollbar": {
            const event = new PointerEvent("pointerdown");
            Object.defineProperty(event, "pointerType", { value: "mouse" });
            fixture.viewport.dispatchEvent(event);
            fixture.viewport.dispatchEvent(new PointerEvent("pointerup"));
            break;
          }
          case "vertical touch":
            dispatchTestTouch(fixture.viewport, "touchstart", 0, 0);
            dispatchTestTouch(fixture.viewport, "touchmove", 0, 16);
            dispatchTestTouch(fixture.viewport, "touchend");
            break;
          case "submit":
            fixture.controller.prepareLatestTurnSubmitPlacement();
            break;
          case "another element navigation":
            fixture.controller.scrollElementIntoView(fixture.otherTarget, "smooth", "start");
            break;
          case "another distance navigation":
            fixture.controller.scrollToDistanceFromBottomPx(300, "instant");
            break;
          case "jump to bottom":
            fixture.controller.jumpToBottom();
            break;
          case "viewport hold":
            fixture.controller.holdViewport();
            break;
        }
        await Promise.resolve();
      });
      expect(fixture.controller.getScrollMode()).not.toBe("programmaticFind");
      expect(fixture.controller.nativeFindTurnKey).toBeNull();
      await fixture.compensateAndSettle();
      expect(fixture.findScrolls).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  test("retains only the current Find turn and releases it on abort without accepting an old finish", async () => {
    const fixture = await renderNativeFindController();
    try {
      await fixture.beginFind();
      const next = new AbortController();
      await act(async () => {
        fixture.controller.scrollElementIntoView(fixture.otherTarget, "smooth", "center", {
          turnKey: "replacement-turn",
          readTarget: () => fixture.otherTarget,
          signal: next.signal,
        });
        // Canceling the first operation queues its completion after the second is installed.
        await Promise.resolve();
      });
      expect(fixture.controller.nativeFindTurnKey).toBe("replacement-turn");
      expect(fixture.controller.getScrollMode()).toBe("programmaticFind");
      await act(async () => {
        next.abort();
        await Promise.resolve();
      });
      expect(fixture.controller.nativeFindTurnKey).toBeNull();
      expect(fixture.controller.getScrollMode()).toBe("user");
      await fixture.compensateAndSettle();
      expect(fixture.findScrolls).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  test("unmount cancels queued native recentering and fences retained controller callbacks", async () => {
    const fixture = await renderNativeFindController();
    await fixture.beginFind();
    await act(async () => {
      fixture.controller.compensateScrollToDistanceFromBottomPx(240);
      fixture.view.unmount();
      await settleAsyncRender();
    });
    await fixture.compensateAndSettle();
    expect(fixture.findScrolls).toHaveLength(1);
    expect(fixture.controller.getScrollElement()).toBeNull();
  });
});

/** The native scrolling boundary is recorded; the provider, intent listeners, and Find lease are real. */
async function renderNativeFindController(children?: ReactNode) {
  const controllers: LocalConversationThreadScrollControllerValue[] = [];
  const view = render(
    <EnsureLocalConversationThreadScrollController>
      <LocalConversationThreadScrollLayout>
        <ControllerProbe onController={(controller) => controllers.push(controller)} />
        <div data-turn-key="find-turn">
          <mark data-testid="find-target">Current Find result</mark>
        </div>
        <button data-testid="other-target">Another destination</button>
        <input aria-label="Draft" />
        {children}
      </LocalConversationThreadScrollLayout>
    </EnsureLocalConversationThreadScrollController>,
  );
  await settleAsyncRender();
  const controller = controllers.at(-1);
  const viewport = view.container.querySelector<HTMLDivElement>(
    "[data-local-conversation-thread-body='true']",
  );
  const target = view.getByTestId("find-target");
  const otherTarget = view.getByTestId("other-target");
  const input = view.getByRole("textbox");
  if (!controller || !viewport) throw new Error("Expected a mounted conversation controller.");
  let scrollHeight = 2_000;
  let targetTop = 800;
  const findScrolls: ScrollIntoViewOptions[] = [];
  const scrollWrites: ScrollToOptions[] = [];
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, value: 500 },
    offsetHeight: { configurable: true, value: 500 },
    getBoundingClientRect: {
      configurable: true,
      value: () => createDomRect({ x: 0, y: 0, width: 500, height: 500 }),
    },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        scrollWrites.push(options);
        viewport.scrollTop = options.top ?? 0;
      },
    },
  });
  Object.defineProperties(target, {
    getBoundingClientRect: {
      configurable: true,
      value: () => createDomRect({ x: 0, y: targetTop, width: 100, height: 20 }),
    },
    scrollIntoView: {
      configurable: true,
      value: (options: ScrollIntoViewOptions) => findScrolls.push(options),
    },
  });
  viewport.scrollTop = 1_400;
  return {
    get controller() {
      return controllers.at(-1) ?? controller;
    },
    viewport,
    target,
    otherTarget,
    input,
    view,
    findScrolls,
    scrollWrites,
    setScrollHeight: (height: number) => {
      scrollHeight = height;
    },
    setTargetTop: (top: number) => {
      targetTop = top;
    },
    beginFind: () =>
      act(async () => {
        controller.holdViewport();
        controller.setScrollMode("programmaticFind");
        controller.scrollElementIntoView(target, "smooth", "center", {
          readTarget: () => target,
        });
        await Promise.resolve();
        expect(findScrolls).toHaveLength(1);
      }),
    compensateAndSettle: () =>
      act(async () => {
        controller.compensateScrollToDistanceFromBottomPx(320);
        await settleAsyncRender();
      }),
    dispose: () =>
      act(async () => {
        view.unmount();
        await Promise.resolve();
      }),
  };
}

function dispatchTestTouch(element: HTMLElement, type: string, x?: number, y?: number) {
  const event = new Event(type);
  Object.defineProperty(event, "touches", {
    value: x === undefined || y === undefined ? [] : [{ identifier: 1, clientX: x, clientY: y }],
  });
  element.dispatchEvent(event);
}

function createDomRect({
  height,
  width,
  x,
  y,
}: {
  height: number;
  width: number;
  x: number;
  y: number;
}): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    top: y,
    width,
    x,
    y,
    toJSON: () => ({}),
  } as DOMRect;
}
