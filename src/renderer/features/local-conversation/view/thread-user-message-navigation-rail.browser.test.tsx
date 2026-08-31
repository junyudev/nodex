import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import {
  installAsyncRequestAnimationFrame,
  installElementScrollHeight,
} from "../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../test/dom";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";
import {
  collectThreadUserMessageNavigationObservationTargets,
  ensureThreadUserMessageNavigationRowVisible,
  hasEnoughThreadUserMessageNavigationLeftSpace,
  resolveThreadUserMessageNavigationCurrentRangeIds,
  ThreadUserMessageNavigationRail,
  threadUserMessageNavigationMutationsIncludeTurnContainer,
} from "./thread-user-message-navigation-rail";

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalOffsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const intersectionObserverInstances: TestIntersectionObserver[] = [];

class TestIntersectionObserver {
  readonly callback: IntersectionObserverCallback;
  readonly options?: IntersectionObserverInit;
  readonly observedElements: Element[] = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    intersectionObserverInstances.push(this);
  }

  observe(element: Element) {
    if (!this.observedElements.includes(element)) {
      this.observedElements.push(element);
    }
  }

  unobserve(element: Element) {
    const index = this.observedElements.indexOf(element);
    if (index >= 0) {
      this.observedElements.splice(index, 1);
    }
  }

  disconnect() {
    this.observedElements.splice(0);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(
      entries.map(
        (entry) =>
          ({
            boundingClientRect: entry.target.getBoundingClientRect(),
            intersectionRatio: entry.isIntersecting ? 1 : 0,
            intersectionRect: entry.target.getBoundingClientRect(),
            isIntersecting: entry.isIntersecting,
            rootBounds: null,
            target: entry.target,
            time: 0,
          }) as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

function installTestIntersectionObserver() {
  intersectionObserverInstances.splice(0);
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: TestIntersectionObserver,
  });
}

function restoreIntersectionObserver() {
  intersectionObserverInstances.splice(0);
  if (typeof originalIntersectionObserver === "undefined") {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { IntersectionObserver?: typeof IntersectionObserver },
      "IntersectionObserver",
    );
    return;
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: originalIntersectionObserver,
  });
}

function makeRect(input: Partial<DOMRectReadOnly>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  const rect = {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
  return rect as DOMRect;
}

function installRailLayoutGeometry(leftGapPx = 80) {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches("[data-local-conversation-thread-body='true']")) return 1000;
      return originalOffsetWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.matches("[data-local-conversation-thread-body='true']")) {
        return makeRect({ left: 0, width: 1000, height: 700 });
      }
      if (this.matches("[data-mcp-app-portal-target='true']")) {
        return makeRect({ left: leftGapPx, width: 768, height: 2000 });
      }
      return originalGetBoundingClientRect.call(this);
    },
  });
}

function restoreRailLayoutGeometry() {
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

function buildItem(
  index: number,
  overrides?: Partial<ThreadUserMessageNavigationItem>,
): ThreadUserMessageNavigationItem {
  return {
    id: `turn_${index}:user:0`,
    turnId: `turn_${index}`,
    turnKey: `turn_${index}`,
    ordinal: index,
    label: `Message ${index}`,
    responsePreview: `Answer ${index}`,
    outputs: [],
    isHeartbeat: false,
    ...overrides,
  };
}

function RailHarness({
  items,
  onRevealItem,
  onPreviewItem,
  missingTargetId,
}: {
  items: ThreadUserMessageNavigationItem[];
  missingTargetId?: string;
  onRevealItem?: Parameters<typeof ThreadUserMessageNavigationRail>[0]["onRevealItem"];
  onPreviewItem?: Parameters<typeof ThreadUserMessageNavigationRail>[0]["onPreviewItem"];
}) {
  return (
    <TooltipProvider>
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout>
          <div data-thread-find-target="conversation">
            {items.map((item) =>
              item.id === missingTargetId ? null : (
                <div
                  key={item.id}
                  data-turn-key={item.turnKey}
                  data-content-search-turn-key={item.turnKey}
                >
                  <div data-content-search-unit-key={item.id}>
                    <div data-user-message-bubble="true">{item.label}</div>
                  </div>
                </div>
              ),
            )}
          </div>
          <ThreadUserMessageNavigationRail
            items={items}
            onRevealItem={onRevealItem}
            onPreviewItem={onPreviewItem}
          />
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>
    </TooltipProvider>
  );
}

describe("ThreadUserMessageNavigationRail", () => {
  beforeEach(() => {
    installTestIntersectionObserver();
    installRailLayoutGeometry();
    installAsyncRequestAnimationFrame();
    installElementScrollHeight(5000);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value() {},
    });
  });

  afterEach(() => {
    restoreIntersectionObserver();
    restoreRailLayoutGeometry();
  });

  test("collects Codex-compatible observer targets from turn containers", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <section data-turn-key="turn_same">
        <div data-content-search-unit-key="turn_same:user:0"></div>
        <div data-content-search-unit-key="turn_same:user:1"></div>
      </section>
      <section data-content-search-turn-key="turn_next">
        <div data-content-search-unit-key="turn_next:user:0"></div>
      </section>
      <div data-content-search-unit-key="turn_skip:user:0"></div>
    `;

    const targets = collectThreadUserMessageNavigationObservationTargets(
      root,
      new Set(["turn_same:user:0", "turn_same:user:1", "turn_next:user:0"]),
    );

    expect(targets.length).toBe(3);
    expect(targets[0]?.element.getAttribute("data-turn-key")).toBe("turn_same");
    expect(targets[0]?.itemId).toBe("turn_same:user:0");
    expect(targets[1]?.element.getAttribute("data-content-search-unit-key")).toBe(
      "turn_same:user:1",
    );
    expect(targets[1]?.itemId).toBe("turn_same:user:1");
    expect(targets[2]?.element.getAttribute("data-content-search-turn-key")).toBe("turn_next");
    expect(targets[2]?.itemId).toBe("turn_next:user:0");
  });

  test("windows a 1,000-marker rail and preserves positional keyboard semantics", async () => {
    const onPreviewItem = vi.fn();
    const items = Array.from({ length: 1_000 }, (_, index) => buildItem(index + 1));
    const { getAllByRole, getByRole } = render(
      <RailHarness items={items} onPreviewItem={onPreviewItem} />,
    );
    await settleAsyncRender();

    const mountedMarkers = getAllByRole("button", { name: /Jump to user message/u });
    expect(mountedMarkers.length).toBeLessThan(100);
    const last = getByRole("button", { name: "Jump to user message 1000" });
    expect(last.getAttribute("aria-setsize")).toBe("1000");
    expect(last.getAttribute("aria-posinset")).toBe("1000");

    await act(async () => {
      fireEvent.focus(last);
      fireEvent.keyDown(last, { key: "ArrowUp" });
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(document.activeElement).toBe(getByRole("button", { name: "Jump to user message 999" }));
    expect(onPreviewItem).toHaveBeenCalledWith(items[999]);
    expect(onPreviewItem).toHaveBeenCalledWith(items[998]);
  });

  test("resolves current range from first visible rail item through last visible rail item", () => {
    const items = [1, 2, 3, 4].map((index) => buildItem(index));

    const range = resolveThreadUserMessageNavigationCurrentRangeIds(
      items,
      new Set(["turn_2:user:0", "turn_4:user:0"]),
    );

    expect([...(range ?? [])].join(",")).toBe("turn_2:user:0,turn_3:user:0,turn_4:user:0");
  });

  test("rescans only when mutations add or remove turn containers", () => {
    const turn = document.createElement("div");
    turn.setAttribute("data-turn-key", "turn_1");
    const nested = document.createElement("div");
    nested.innerHTML = `<section data-content-search-turn-key="turn_2"></section>`;
    const plain = document.createElement("span");

    expect(
      threadUserMessageNavigationMutationsIncludeTurnContainer([
        {
          addedNodes: [turn] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as MutationRecord,
      ]),
    ).toBe(true);
    expect(
      threadUserMessageNavigationMutationsIncludeTurnContainer([
        {
          addedNodes: [nested] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as MutationRecord,
      ]),
    ).toBe(true);
    expect(
      threadUserMessageNavigationMutationsIncludeTurnContainer([
        {
          addedNodes: [plain] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as MutationRecord,
      ]),
    ).toBe(false);
  });

  test("keeps the active rail row visible within the rail list", () => {
    const list = document.createElement("div");
    list.style.cssText = "height: 20px; overflow: auto; position: relative";
    const spacer = document.createElement("div");
    spacer.style.height = "90px";
    const row = document.createElement("button");
    row.style.cssText = "display: block; height: 10px";
    row.setAttribute("data-thread-user-message-navigation-item-id", "turn_9:user:0");
    list.append(spacer, row);
    document.body.append(list);

    ensureThreadUserMessageNavigationRowVisible(list, "turn_9:user:0");
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(row.offsetTop + row.offsetHeight).toBeLessThanOrEqual(
      list.scrollTop + list.clientHeight,
    );

    spacer.remove();
    list.scrollTop = 10;
    ensureThreadUserMessageNavigationRowVisible(list, "turn_9:user:0");
    expect(list.scrollTop).toBe(0);

    list.scrollTop = 0;
    ensureThreadUserMessageNavigationRowVisible(list, "turn_9:user:0");
    expect(list.scrollTop).toBe(0);
  });

  test("matches Codex's 48px left-space threshold", () => {
    const scrollElement = document.createElement("div");
    const contentElement = document.createElement("div");
    Object.defineProperty(scrollElement, "offsetWidth", { configurable: true, value: 1000 });
    Object.defineProperty(scrollElement, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect({ left: 0, width: 1000 }),
    });
    Object.defineProperty(contentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect({ left: 47, width: 700 }),
    });

    expect(hasEnoughThreadUserMessageNavigationLeftSpace({ scrollElement, contentElement })).toBe(
      false,
    );

    Object.defineProperty(contentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect({ left: 48, width: 700 }),
    });
    expect(hasEnoughThreadUserMessageNavigationLeftSpace({ scrollElement, contentElement })).toBe(
      true,
    );
  });

  test("renders the Codex-compatible rail DOM contract", async () => {
    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { container } = render(<RailHarness items={items} />);
    await settleAsyncRender();

    const nav = container.querySelector('nav[aria-label="User messages"]');
    const list = container.querySelector("[data-thread-user-message-navigation-rail-list='true']");
    const rows = container.querySelectorAll("[data-thread-user-message-navigation-item-id]");

    expect(Boolean(nav)).toBe(true);
    expect(
      nav?.parentElement?.getAttribute("data-thread-user-message-navigation-portal-target"),
    ).toBe("true");
    expect(Boolean(list)).toBe(true);
    expect(rows.length).toBe(4);
    expect(rows[0]?.getAttribute("aria-label")).toBe("Jump to user message 1");
    expect(rows[3]?.getAttribute("aria-current")).toBe("true");
  });

  test("does not render when the content column leaves less than Codex's rail gutter", async () => {
    installRailLayoutGeometry(47);
    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { container } = render(<RailHarness items={items} />);
    await settleAsyncRender();

    expect(Boolean(container.querySelector('nav[aria-label="User messages"]'))).toBe(false);
  });

  test("observes turn containers instead of user search-unit leaves", async () => {
    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { container } = render(<RailHarness items={items} />);
    await settleAsyncRender();

    const observer = intersectionObserverInstances[0];
    const scrollElement = container.querySelector("[data-local-conversation-thread-body='true']");
    const firstTurn = container.querySelector("[data-turn-key='turn_1']");
    const firstUnit = container.querySelector("[data-content-search-unit-key='turn_1:user:0']");

    expect(observer?.options?.root).toBe(scrollElement);
    expect(observer?.options?.rootMargin).toBe("-16px 0px 0px 0px");
    expect("threshold" in (observer?.options ?? {})).toBe(false);
    expect(observer?.observedElements.includes(firstTurn as Element)).toBe(true);
    expect(observer?.observedElements.includes(firstUnit as Element)).toBe(false);
  });

  test("marks the visible first-to-last user message range as current", async () => {
    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { container } = render(<RailHarness items={items} />);
    await settleAsyncRender();

    const observer = intersectionObserverInstances[0];
    const turn2 = container.querySelector("[data-turn-key='turn_2']") as Element;
    const turn4 = container.querySelector("[data-turn-key='turn_4']") as Element;
    await act(async () => {
      observer?.trigger([
        { target: turn2, isIntersecting: true },
        { target: turn4, isIntersecting: true },
      ]);
    });
    await settleAsyncRender();

    const currentRows = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-thread-user-message-navigation-item-id][aria-current='true']",
      ),
    ).map((row) => row.dataset.threadUserMessageNavigationItemId);
    expect(currentRows.join(",")).toBe("turn_2:user:0,turn_3:user:0,turn_4:user:0");

    const secondMarker = container.querySelector<HTMLElement>(
      "[data-thread-user-message-navigation-item-id='turn_2:user:0'] .thread-user-message-navigation-marker",
    );
    expect(secondMarker?.className.includes("bg-token-foreground")).toBe(true);
    expect(secondMarker?.className.includes("opacity-60")).toBe(true);
  });

  test("auto-scrolls the rail list to the primary current row", async () => {
    const items = Array.from({ length: 10 }, (_, index) => buildItem(index + 1));
    const { container } = render(<RailHarness items={items} />);
    await settleAsyncRender();

    const list = container.querySelector<HTMLElement>(
      "[data-thread-user-message-navigation-rail-list='true']",
    ) as HTMLElement;
    const eighthRow = container.querySelector<HTMLElement>(
      "[data-thread-user-message-navigation-item-id='turn_8:user:0']",
    ) as HTMLElement;
    list.style.cssText = "height: 20px; overflow: auto; position: relative";
    for (const row of list.querySelectorAll<HTMLElement>(
      "[data-thread-user-message-navigation-item-id]",
    )) {
      row.style.cssText = "display: block; height: 10px";
    }

    const observer = intersectionObserverInstances[0];
    const turn8 = container.querySelector("[data-turn-key='turn_8']") as Element;
    await act(async () => {
      observer?.trigger([{ target: turn8, isIntersecting: true }]);
    });
    await settleAsyncRender();

    expect(list.scrollTop).toBeGreaterThan(0);
    expect(eighthRow.offsetTop + eighthRow.offsetHeight).toBeLessThanOrEqual(
      list.scrollTop + list.clientHeight,
    );
  });

  test("click navigation uses smooth scrolling", async () => {
    const scrollCalls: ScrollToOptions[] = [];
    const scrollIntoViewCalls: ScrollIntoViewOptions[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(options: ScrollToOptions) {
        scrollCalls.push(options);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(options: ScrollIntoViewOptions) {
        scrollIntoViewCalls.push(options);
      },
    });

    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { getByRole } = render(<RailHarness items={items} />);
    await settleAsyncRender();
    const scrollCallCountBeforeClick = scrollCalls.length;

    fireEvent.click(getByRole("button", { name: "Jump to user message 1" }));
    await settleAsyncRender();

    expect(scrollCalls.length).toBe(scrollCallCountBeforeClick);
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.behavior).toBe("smooth");
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.block).toBe("start");
  });

  test("scrolls and highlights the real marker returned for a virtualized shell", async () => {
    const revealed: string[] = [];
    const scrollIntoViewCalls: Array<{
      element: HTMLElement;
      options: ScrollIntoViewOptions;
    }> = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options: ScrollIntoViewOptions) {
        scrollIntoViewCalls.push({ element: this, options });
      },
    });

    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const animate = vi.fn();
    const installedTargets: HTMLElement[] = [];
    const { container, getByRole } = render(
      <RailHarness
        items={items}
        missingTargetId="turn_2:user:0"
        onRevealItem={(item, mode) => {
          revealed.push(`${item.id}:${mode}`);
          const root = container.querySelector("[data-thread-find-target='conversation']");
          const turn = document.createElement("div");
          turn.setAttribute("data-turn-key", item.turnKey);
          const target = document.createElement("div");
          target.setAttribute("data-content-search-unit-key", "turn_2:item_real_user_message");
          const bubble = document.createElement("div");
          bubble.setAttribute("data-user-message-bubble", "true");
          bubble.animate = animate;
          target.append(bubble);
          turn.append(target);
          root?.append(turn);
          installedTargets.push(target);
          return target;
        }}
      />,
    );
    await settleAsyncRender();

    fireEvent.click(getByRole("button", { name: "Jump to user message 2" }));
    await settleAsyncRender();

    expect(revealed.join(",")).toBe("turn_2:user:0:smooth");
    const realTarget = installedTargets[0];
    expect(realTarget?.getAttribute("data-content-search-unit-key")).toBe(
      "turn_2:item_real_user_message",
    );
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.element).toBe(realTarget);
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.options.behavior).toBe("smooth");
    expect(scrollIntoViewCalls[scrollIntoViewCalls.length - 1]?.options.block).toBe("start");
    expect(animate).toHaveBeenCalledOnce();
  });

  test("pointer drag scrubs to the row under the rail midpoint instantly", async () => {
    const revealed: string[] = [];
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

    const items = [1, 2, 3, 4].map((index) => buildItem(index));
    const { container, getByRole } = render(
      <RailHarness
        items={items}
        missingTargetId="turn_2:user:0"
        onRevealItem={(item, mode) => {
          revealed.push(`${item.id}:${mode}`);
          const root = container.querySelector("[data-thread-find-target='conversation']");
          const turn = document.createElement("div");
          turn.setAttribute("data-turn-key", item.turnKey);
          const target = document.createElement("div");
          target.setAttribute("data-content-search-unit-key", item.id);
          turn.append(target);
          root?.append(turn);
          return target;
        }}
      />,
    );
    await settleAsyncRender();

    const list = container.querySelector<HTMLElement>(
      "[data-thread-user-message-navigation-rail-list='true']",
    );
    const secondRow = getByRole("button", { name: "Jump to user message 2" });
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        right: 36,
        bottom: 100,
        left: 0,
        width: 36,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => secondRow,
    });

    const firstRow = getByRole("button", { name: "Jump to user message 1" });
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

    expect(revealed.join(",")).toBe("turn_2:user:0:instant");
    expect(secondRow.getAttribute("data-scrub-target")).toBe("true");
    expect(
      secondRow
        .querySelector<HTMLElement>(".thread-user-message-navigation-marker")
        ?.className.includes("opacity-100"),
    ).toBe(true);
  });
});
