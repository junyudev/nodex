import { afterAll, afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { useMemo, useState } from "react";
import {
  installAsyncRequestAnimationFrame,
  installMeasuredResizeObserver,
} from "../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NfmHeadingNavigationRail } from "./nfm-heading-navigation-rail";
import type { NfmHeadingNavigationBlockLike } from "./nfm-heading-navigation-rail-model";

const originalMatchMedia = window.matchMedia;
const originalRequestIdleCallback = window.requestIdleCallback;
const originalCancelIdleCallback = window.cancelIdleCallback;
const originalOffsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalElementFromPoint = document.elementFromPoint;

function makeRect(input: Partial<DOMRectReadOnly>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function installHeadingRailGeometry(rightGapPx = 64) {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches("[data-heading-rail-scroll='true']")) return 1000;
      return originalOffsetWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.matches("[data-heading-rail-scroll='true']")) {
        return makeRect({ left: 0, width: 1000, height: 700 });
      }
      if (this.matches("[data-page-stage-body='true']")) {
        return makeRect({ left: 1000 - 720 - rightGapPx, width: 720, height: 1600 });
      }
      return originalGetBoundingClientRect.call(this);
    },
  });
}

function restoreHeadingRailGeometry() {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: originalGetBoundingClientRect,
  });
  if (originalOffsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidthDescriptor);
  } else {
    Reflect.deleteProperty(
      HTMLElement.prototype as HTMLElement & { offsetWidth?: number },
      "offsetWidth",
    );
  }
}

function buildHeadingBlocks(count: number): NfmHeadingNavigationBlockLike[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `heading-${index + 1}`,
    type: "heading",
    props: { level: (index % 4) + 1 },
    content: [{ text: `Heading ${index + 1}` }],
  }));
}

function HeadingRailHarness({
  headingCount,
  active = true,
}: {
  headingCount: number;
  active?: boolean;
}) {
  const document = useMemo(() => buildHeadingBlocks(headingCount), [headingCount]);
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [editorElement, setEditorElement] = useState<HTMLDivElement | null>(null);
  const editor = useMemo(
    () => ({
      document,
      domElement: editorElement,
      onChange: () => () => undefined,
    }),
    [document, editorElement],
  );

  return (
    <NodexTooltipProvider>
      <div ref={setPortalElement} data-page-stage-heading-navigation-portal-target="true">
        <div ref={setScrollElement} data-heading-rail-scroll="true">
          <div data-page-stage-body="true">
            <div ref={setEditorElement}>
              {document.map((block) => (
                <div key={block.id} className="bn-block" data-id={block.id}>
                  {`Heading ${block.id}`}
                </div>
              ))}
            </div>
          </div>
        </div>
        <NfmHeadingNavigationRail
          editor={editor}
          scrollContainerRef={{ current: scrollElement }}
          portalElement={portalElement}
          isActivePanelTab={active}
        />
      </div>
    </NodexTooltipProvider>
  );
}

async function settleHeadingRail() {
  await settleAsyncRender();
  await settleAsyncRender();
}

describe("NfmHeadingNavigationRail", () => {
  beforeEach(() => {
    installAsyncRequestAnimationFrame();
    installMeasuredResizeObserver({ blockSize: 700, inlineSize: 1000 });
    installHeadingRailGeometry();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 50,
            }),
          0,
        )) as typeof window.requestIdleCallback,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: ((handle: number) => {
        window.clearTimeout(handle);
      }) as typeof window.cancelIdleCallback,
    });
  });

  afterEach(() => {
    restoreHeadingRailGeometry();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: originalElementFromPoint,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: originalRequestIdleCallback,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: originalCancelIdleCallback,
    });
  });

  test("renders the automatic heading rail once four headings are available", async () => {
    const { container } = render(<HeadingRailHarness headingCount={4} />);
    await settleHeadingRail();

    const nav = container.querySelector('nav[aria-label="Headings"]');
    const rows = container.querySelectorAll("[data-marker-navigation-item-id]");

    expect(Boolean(nav)).toBe(true);
    expect(nav?.getAttribute("data-marker-navigation-rail-side")).toBe("right");
    expect(nav?.classList.contains("right-3")).toBe(true);
    expect(nav?.classList.contains("left-3")).toBe(false);
    expect(rows.length).toBe(4);
    expect(rows[0]?.getAttribute("aria-label")).toBe("Jump to heading 1: Heading 1");
  });

  test("stays hidden below the four-heading threshold", async () => {
    const { container } = render(<HeadingRailHarness headingCount={3} />);
    await settleHeadingRail();

    expect(Boolean(container.querySelector('nav[aria-label="Headings"]'))).toBe(false);
  });

  test("stays hidden when the right gutter cannot fit the rail", async () => {
    installHeadingRailGeometry(47);
    const { container } = render(<HeadingRailHarness headingCount={4} />);
    await settleHeadingRail();

    expect(Boolean(container.querySelector('nav[aria-label="Headings"]'))).toBe(false);
  });

  test("click navigation reveals the matching heading smoothly", async () => {
    const scrollIntoViewCalls: ScrollIntoViewOptions[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewMock(
      options?: boolean | ScrollIntoViewOptions,
    ) {
      if (typeof options === "object") scrollIntoViewCalls.push(options);
    };

    const { getByRole } = render(<HeadingRailHarness headingCount={4} />);
    await settleHeadingRail();

    fireEvent.click(getByRole("button", { name: "Jump to heading 2: Heading 2" }));
    await settleHeadingRail();

    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.behavior).toBe("smooth");
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.block).toBe("start");
  });

  test("pointer drag scrubs to the row under the rail instantly", async () => {
    const scrollIntoViewCalls: ScrollIntoViewOptions[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewMock(
      options?: boolean | ScrollIntoViewOptions,
    ) {
      if (typeof options === "object") scrollIntoViewCalls.push(options);
    };
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      writable: true,
      value() {},
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      writable: true,
      value() {},
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      writable: true,
      value() {
        return true;
      },
    });

    const { container, getByRole } = render(<HeadingRailHarness headingCount={4} />);
    await settleHeadingRail();

    const list = container.querySelector<HTMLElement>("[data-marker-navigation-rail-list='true']");
    const secondRow = getByRole("button", { name: "Jump to heading 2: Heading 2" });
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect({ top: 0, left: 0, width: 36, height: 100 }),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => secondRow,
    });

    const firstRow = getByRole("button", { name: "Jump to heading 1: Heading 1" });
    await act(async () => {
      fireEvent.pointerDown(firstRow, {
        pointerId: 1,
        button: 0,
        isPrimary: true,
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerMove(firstRow, {
        pointerId: 1,
        isPrimary: true,
        clientX: 0,
        clientY: 40,
      });
      await Promise.resolve();
    });

    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.behavior).toBe("auto");
    expect(secondRow.getAttribute("data-scrub-target")).toBe("true");
  });
});
