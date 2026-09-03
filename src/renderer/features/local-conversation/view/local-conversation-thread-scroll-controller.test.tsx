import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { act } from "@testing-library/react";
import { useEffect } from "react";
import { installAsyncRequestAnimationFrame } from "../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../test/dom";
import {
  REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
  REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE,
  REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
  type RemoteHostedPipHostLayout,
} from "../../../../shared/remote-hosted-pip";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { RemoteHostedPipHostLayoutReporter } from "./remote-hosted-pip-host-layout-reporter";

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

  test("does not attach a resize observer for viewport auto-stick", () => {
    let resizeObserverInstances = 0;

    class TestResizeObserver {
      constructor() {
        resizeObserverInstances += 1;
      }

      disconnect() {}

      observe() {}

      unobserve() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });

    render(
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout>
          <div>Thread content</div>
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>,
    );

    expect(resizeObserverInstances).toBe(0);
  });

  test("renders the scroll container and shifts content by the provided offset", () => {
    const view = render(
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout contentX={-158}>
          <div>Thread content</div>
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>,
    );

    const scrollContainer = view.container.querySelector(
      "[data-local-conversation-thread-body='true']",
    );
    const shiftedContent = scrollContainer?.firstElementChild as HTMLElement | null;
    const widthWrapper = shiftedContent?.querySelector(
      "[data-mcp-app-portal-target='true']",
    ) as HTMLElement | null;

    expect(scrollContainer !== null).toBe(true);
    expect(scrollContainer?.getAttribute(REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE)).toBe(
      REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
    );
    expect(widthWrapper !== null).toBe(true);
    expect(shiftedContent?.style.transform.includes("translateX(-158px)")).toBe(true);
  });

  test("restores native bottom distance before paint and normalizes the 24px boundary", async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.localConversationThreadBody === "true" ? 1_000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.localConversationThreadBody === "true" ? 500 : 0;
      },
    });

    try {
      const restored = render(
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout
            initialRestoreSnapshot={{
              distanceFromBottomPx: 120,
              latestTurn: null,
              virtualizedTurnList: null,
            }}
          >
            <div>Restored thread</div>
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>,
      );
      const restoredViewport = restored.container.querySelector(
        "[data-local-conversation-thread-body='true']",
      ) as HTMLDivElement | null;
      await settleAsyncRender();
      expect(restoredViewport?.scrollTop ?? 0).toBe(-120);
      restored.unmount();

      const nearBottom = render(
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout
            initialRestoreSnapshot={{
              distanceFromBottomPx: 24,
              latestTurn: null,
              virtualizedTurnList: null,
            }}
          >
            <div>Near-bottom thread</div>
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>,
      );
      const nearBottomViewport = nearBottom.container.querySelector(
        "[data-local-conversation-thread-body='true']",
      ) as HTMLDivElement | null;
      await settleAsyncRender();
      expect(nearBottomViewport?.scrollTop ?? -1).toBe(0);
      nearBottom.unmount();
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
    }
  });

  test("measures sticky footer height into Codex scroll padding", () => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.getAttribute("data-thread-scroll-footer") === "true") {
          return {
            bottom: 48,
            height: 48,
            left: 0,
            right: 300,
            top: 0,
            width: 300,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      },
    });

    class TestResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      disconnect() {}

      observe(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }

      unobserve() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });

    const view = render(
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout footer={<div>Composer</div>}>
          <div>Thread content</div>
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>,
    );

    const scrollContainer = view.container.querySelector(
      "[data-local-conversation-thread-body='true']",
    ) as HTMLElement | null;
    const footer = view.container.querySelector("[data-thread-scroll-footer='true']");
    const footerObstacle = view.container.querySelector(
      `[${REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE}='thread-footer']`,
    );

    expect(Boolean(footer)).toBe(true);
    expect(Boolean(footerObstacle)).toBe(true);
    expect(scrollContainer?.style.getPropertyValue("--thread-scroll-padding-bottom")).toBe("64px");
  });

  test("publishes remote-hosted PiP host layout and clears it on unmount", async () => {
    const layouts: Array<RemoteHostedPipHostLayout | null> = [];

    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string, layout: RemoteHostedPipHostLayout | null) => {
          if (channel === "remote-hosted-pip:host-layout:report") layouts.push(layout);
          return true;
        },
        on: () => () => undefined,
      },
      writable: true,
    });

    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.getAttribute("data-local-conversation-thread-body") === "true") {
          return createDomRect({
            height: 800,
            width: 1_000,
            x: 100,
            y: 50,
          });
        }
        if (this.getAttribute(REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE) === "thread-footer") {
          return createDomRect({
            height: 120,
            width: 1_000,
            x: 100,
            y: 730,
          });
        }
        return originalGetBoundingClientRect.call(this);
      },
      writable: true,
    });

    const view = render(
      <>
        <RemoteHostedPipHostLayoutReporter isCodexHomeAvailable={false} />
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout footer={<div>Composer</div>}>
            <div>Thread content</div>
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>
      </>,
    );

    await settleAsyncRender();

    const layout = layouts.find((candidate) => candidate?.anchorRect !== null);
    expect(layout !== undefined).toBe(true);
    if (!layout) return;

    const bottomRight = layout.anchors?.find((anchor) => anchor.alignment === "bottom-right");
    expect(layout.hostId).toBe(REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID);
    expect(bottomRight?.point.y ?? 0).toBe(718);

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    const lastLayout = layouts[layouts.length - 1];
    expect(lastLayout?.anchorRect === null).toBe(true);
    expect(lastLayout?.anchors === null).toBe(true);
  });

  test("reports Home geometry and animates only a subsequent visible layout", async () => {
    const layouts: RemoteHostedPipHostLayout[] = [];
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string, layout: RemoteHostedPipHostLayout) => {
          if (channel === "remote-hosted-pip:host-layout:report") layouts.push(layout);
          return true;
        },
        on: () => () => undefined,
      },
      writable: true,
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.getAttribute(REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE)) {
          return createDomRect({
            height: 800,
            width: 1_000,
            x: Number.parseInt(this.style.left || "100", 10),
            y: 50,
          });
        }
        if (this.getAttribute(REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE)) {
          return createDomRect({ height: 300, width: 320, x: 740, y: 80 });
        }
        return originalGetBoundingClientRect.call(this);
      },
      writable: true,
    });

    const renderGeometry = (left: number) => (
      <>
        <RemoteHostedPipHostLayoutReporter isCodexHomeAvailable />
        <div
          {...{
            [REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE]: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
          }}
          style={{ left }}
        />
        <div {...{ [REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE]: "thread-summary-panel" }} />
      </>
    );
    const view = render(renderGeometry(100));
    await settleAsyncRender();

    const initialLayout = layouts.find((layout) => layout.anchorRect !== null);
    expect(initialLayout?.animated).toBe(false);
    expect(initialLayout?.isCodexHomeAvailable).toBe(true);
    expect(
      initialLayout?.anchors?.find((anchor) => anchor.alignment === "top-right")?.point,
    ).toEqual({ x: 1_060, y: 392 });

    await act(async () => {
      view.rerender(renderGeometry(120));
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await settleAsyncRender();
    });
    const latestVisibleLayout = layouts.findLast((layout) => layout.anchorRect !== null);
    expect(latestVisibleLayout?.anchorRect?.x).toBe(120);
    expect(latestVisibleLayout?.animated).toBe(true);
  });

  test("keeps native placement and preference transitions unanimated under reduced motion", async () => {
    const layouts: RemoteHostedPipHostLayout[] = [];
    let reducedMotionChangeListener: (() => void) | null = null;
    const reducedMotion = {
      matches: true,
    };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        addEventListener: (_type: string, listener: () => void) => {
          reducedMotionChangeListener = listener;
        },
        get matches() {
          return reducedMotion.matches;
        },
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        removeEventListener: () => undefined,
      }),
      writable: true,
    });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string, layout: RemoteHostedPipHostLayout) => {
          if (channel === "remote-hosted-pip:host-layout:report") layouts.push(layout);
          return true;
        },
        on: () => () => undefined,
      },
      writable: true,
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.getAttribute(REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE)) {
          return createDomRect({
            height: 800,
            width: 1_000,
            x: Number.parseInt(this.style.left || "100", 10),
            y: 50,
          });
        }
        return originalGetBoundingClientRect.call(this);
      },
      writable: true,
    });

    const renderGeometry = (left: number) => (
      <>
        <RemoteHostedPipHostLayoutReporter isCodexHomeAvailable={false} />
        <div
          {...{
            [REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE]: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
          }}
          style={{ left }}
        />
      </>
    );
    const view = render(renderGeometry(100));
    await settleAsyncRender();
    await act(async () => {
      view.rerender(renderGeometry(120));
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await settleAsyncRender();
    });

    const visibleLayouts = layouts.filter((layout) => layout.anchorRect !== null);
    expect(visibleLayouts.length).toBeGreaterThanOrEqual(2);
    expect(visibleLayouts.at(-1)?.anchorRect?.x).toBe(120);
    expect(visibleLayouts.at(-1)?.animated).toBe(false);

    reducedMotion.matches = false;
    await act(async () => {
      reducedMotionChangeListener?.();
      await settleAsyncRender();
    });
    expect(layouts.filter((layout) => layout.anchorRect !== null).at(-1)?.animated).toBe(false);
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
    let scrollTopValue = -280;
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

    const placement = activeController.prepareLatestTurnSubmitPlacement();
    expect(placement?.distanceFromBottomPx ?? 0).toBe(280);
    expect(placement?.scrollHeightPx ?? 0).toBe(1000);
    expect(placement?.shouldPlaceLatestTurn ?? false).toBe(true);
    expect(
      activeController.consumePendingLatestTurnSubmitPlacement()?.distanceFromBottomPx ?? 0,
    ).toBe(280);
    expect(activeController.consumePendingLatestTurnSubmitPlacement() === null).toBe(true);
  });
});

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
