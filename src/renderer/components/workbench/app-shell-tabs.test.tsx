import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, within } from "@testing-library/react";
import { act } from "react";
import { useEffect, type ComponentProps, type ReactNode } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  AppShellTabs,
  shouldShowAppShellTabSeparator,
  type AppShellTabItem,
} from "./app-shell-tabs";
import { render, settleAsyncRender, textContent } from "@/test/dom";

const motionPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/lib/use-reduced-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-reduced-motion")>();
  return {
    ...actual,
    useResolvedReducedMotion: () => motionPreference.reduced,
  };
});

function makeTabs(): AppShellTabItem[] {
  return [
    {
      id: "one",
      title: "One",
      closable: true,
      reorderable: true,
      renderPanel: () => <div>Panel one</div>,
    },
    {
      id: "two",
      title: "Two",
      closable: true,
      reorderable: true,
      tooltip: (
        <div>
          <span>Project Alpha</span>
          <span>card-two</span>
        </div>
      ),
      renderPanel: () => <div>Panel two</div>,
    },
    {
      id: "history",
      title: "History",
      closable: false,
      reorderable: false,
      isLabel: true,
      renderPanel: () => <div>History panel</div>,
    },
  ];
}

function renderAppShellTabs(props: {
  tabs?: AppShellTabItem[];
  activeTabId?: string;
  onSelect?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onDirectCloseTab?: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
  onMoveTab?: ComponentProps<typeof AppShellTabs>["onMoveTab"];
  onSplitTab?: ComponentProps<typeof AppShellTabs>["onSplitTab"];
  panelTabDnd?: ComponentProps<typeof AppShellTabs>["panelTabDnd"];
  beforeList?: ReactNode;
  afterTabsInline?: ReactNode;
  afterListSticky?: ReactNode;
  afterList?: ReactNode;
  bodyOverlay?: ReactNode;
  tabScrollEndPaddingPx?: number;
  headerEndInsetPx?: number;
}) {
  return render(
    <NodexTooltipProvider>
      <AppShellTabs
        tabs={props.tabs ?? makeTabs()}
        activeTabId={props.activeTabId ?? "one"}
        onSelect={props.onSelect ?? (() => undefined)}
        onCloseTab={props.onCloseTab}
        onDirectCloseTab={props.onDirectCloseTab}
        onPinTab={props.onPinTab}
        onMoveTab={props.onMoveTab}
        onSplitTab={props.onSplitTab}
        panelTabDnd={props.panelTabDnd}
        beforeList={props.beforeList}
        afterTabsInline={props.afterTabsInline}
        afterListSticky={props.afterListSticky}
        afterList={props.afterList}
        bodyOverlay={props.bodyOverlay}
        tabScrollEndPaddingPx={props.tabScrollEndPaddingPx}
        headerEndInsetPx={props.headerEndInsetPx}
      />
    </NodexTooltipProvider>,
  );
}

async function hoverTabThroughTooltipDelay(element: HTMLElement): Promise<void> {
  const tooltipTrigger = element.parentElement;
  if (!tooltipTrigger) throw new Error("Expected tab title tooltip trigger");
  vi.useFakeTimers();
  try {
    await act(async () => {
      fireEvent.pointerMove(tooltipTrigger, { pointerType: "mouse" });
      fireEvent.mouseEnter(tooltipTrigger);
      await vi.advanceTimersByTimeAsync(300);
    });
  } finally {
    vi.useRealTimers();
  }
}

describe("AppShellTabs", () => {
  test("reveals default title tooltips on hover", async () => {
    const view = renderAppShellTabs({});

    expect(view.container.ownerDocument.body.querySelector('[role="tooltip"]') === null).toBe(true);

    await hoverTabThroughTooltipDelay(view.getByText("One"));

    const tooltip = view.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe("One");
  });

  test("reveals tab title tooltips on hover", async () => {
    const view = renderAppShellTabs({});

    expect(view.container.ownerDocument.body.querySelector('[role="tooltip"]') === null).toBe(true);

    await hoverTabThroughTooltipDelay(view.getByText("Two"));

    const tooltip = view.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent?.includes("Project Alpha")).toBe(true);
    expect(tooltip?.textContent?.includes("card-two")).toBe(true);
  });

  test("renders context labels in tab chrome, accessible names, and default tooltip", async () => {
    const tabs = makeTabs();
    tabs[1] = {
      ...tabs[1],
      contextLabel: "Beta",
      titleLabel: "Beta project, Two",
      tooltip: undefined,
    };
    const view = renderAppShellTabs({
      tabs,
      activeTabId: "two",
      onCloseTab: () => undefined,
    });

    expect(view.getByRole("tab", { name: "Beta project, Two" }) !== null).toBe(true);
    expect(
      view.container.querySelector('[data-app-shell-tab-context-label="two"]')?.textContent,
    ).toBe("Beta");
    expect(view.getByRole("tabpanel").getAttribute("aria-label")).toBe("Beta project, Two");
    expect(view.getByLabelText("Close Beta project, Two tab") !== null).toBe(true);

    await hoverTabThroughTooltipDelay(view.getByText("Two"));

    const tooltip = view.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe("Beta · Two");
  });

  test("subscribes tab chrome without re-rendering panel content", async () => {
    let title = "Persisted title";
    const listeners = new Set<() => void>();
    let panelRenderCount = 0;
    const view = renderAppShellTabs({
      tabs: [
        {
          id: "live-title",
          title: "Fallback title",
          titleSource: {
            getSnapshot: () => title,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
          contextLabel: "Beta",
          titleLabel: (resolvedTitle) => `Beta project, ${resolvedTitle}`,
          closable: true,
          renderPanel: () => {
            panelRenderCount += 1;
            return <div>Stable panel</div>;
          },
        },
      ],
      activeTabId: "live-title",
      onCloseTab: () => undefined,
    });

    await act(async () => {
      title = "Live title";
      listeners.forEach((listener) => listener());
      await Promise.resolve();
    });

    expect(
      view.container.querySelector('[data-app-shell-tab-title="live-title"]')?.textContent,
    ).toBe("Live title");
    expect(view.getByRole("tab", { name: "Beta project, Live title" }) !== null).toBe(true);
    expect(view.getByRole("tabpanel").getAttribute("aria-label")).toBe("Beta project, Live title");
    expect(view.getByLabelText("Close Beta project, Live title tab") !== null).toBe(true);
    expect(panelRenderCount).toBe(1);
  });

  test("suppresses tab tooltips while dragging", async () => {
    const view = renderAppShellTabs({
      panelTabDnd: {
        sessionId: "session-1",
        panelId: "right",
        leafId: "leaf-a",
        activeDragId: "one",
        previewIntent: null,
      },
    });

    await hoverTabThroughTooltipDelay(view.getByText("One"));

    expect(view.container.ownerDocument.body.querySelector('[role="tooltip"]') === null).toBe(true);
  });

  test("renders one tablist, one selected tab, and one tabpanel", () => {
    const view = renderAppShellTabs({ activeTabId: "two" });

    expect(view.container.querySelectorAll('[role="tablist"]').length).toBe(1);
    expect(view.container.querySelectorAll('[role="tab"][aria-selected="true"]').length).toBe(1);
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Two",
    );
    expect(textContent(view.getByRole("tabpanel"))).toBe("Panel two");
  });

  test("maps durable tab ids to Codex DOM tab ids on tab chrome and active panel", () => {
    const view = renderAppShellTabs({
      activeTabId: "review-durable-id",
      panelTabDnd: {
        sessionId: "session-1",
        panelId: "right",
        leafId: "leaf-a",
        activeDragId: null,
        previewIntent: null,
      },
      tabs: [
        {
          id: "review-durable-id",
          domTabId: "diff",
          title: "Review",
          renderPanel: () => <div>Review panel</div>,
        },
      ],
    });

    expect(
      view.container.querySelector(
        '[data-panel-tab-id="review-durable-id"][data-tab-id="diff"]',
      ) !== null,
    ).toBe(true);
    const panel = view.getByRole("tabpanel");
    expect(panel.getAttribute("data-app-shell-tab-panel-controller")).toBe("right");
    expect(panel.getAttribute("data-tab-id")).toBe("diff");
    expect(panel.getAttribute("aria-label")).toBe("Review");
  });

  test("mounts only the active tab panel", () => {
    const mounts: string[] = [];
    const unmounts: string[] = [];
    function Panel({ id }: { id: string }) {
      useEffect(() => {
        mounts.push(id);
        return () => {
          unmounts.push(id);
        };
      }, [id]);
      return <div data-testid={`panel-${id}`}>Panel {id}</div>;
    }
    const tabs: AppShellTabItem[] = [
      {
        id: "one",
        title: "One",
        renderPanel: () => <Panel id="one" />,
      },
      {
        id: "two",
        title: "Two",
        renderPanel: () => <Panel id="two" />,
      },
    ];
    const renderTabs = (activeTabId: string) => (
      <NodexTooltipProvider>
        <AppShellTabs tabs={tabs} activeTabId={activeTabId} onSelect={() => undefined} />
      </NodexTooltipProvider>
    );
    const view = render(renderTabs("one"));

    expect(mounts.join(",")).toBe("one");
    expect(unmounts.length).toBe(0);
    expect(view.container.querySelectorAll('[role="tabpanel"]').length).toBe(1);
    expect(textContent(view.getByRole("tabpanel"))).toBe("Panel one");
    expect(view.queryByTestId("panel-two")).toBe(null);

    view.rerender(renderTabs("two"));

    expect(mounts.join(",")).toBe("one,two");
    expect(unmounts.join(",")).toBe("one");
    expect(view.container.querySelectorAll('[role="tabpanel"]').length).toBe(1);
    expect(textContent(view.getByRole("tabpanel"))).toBe("Panel two");
    expect(view.queryByTestId("panel-one")).toBe(null);
  });

  test("keeps an active preview mounted when promoted with the same id", () => {
    const mounts: string[] = [];
    const unmounts: string[] = [];
    function FocusablePanel({ id }: { id: string }) {
      useEffect(() => {
        mounts.push(id);
        return () => {
          unmounts.push(id);
        };
      }, [id]);
      return <input aria-label={`Editor ${id}`} />;
    }
    const makePromotionTabs = (preview: boolean): AppShellTabItem[] => [
      {
        id: "preview-card",
        title: "Card",
        preview,
        renderPanel: () => <FocusablePanel id="preview-card" />,
      },
    ];
    const renderTabs = (tabs: AppShellTabItem[]) => (
      <NodexTooltipProvider>
        <AppShellTabs tabs={tabs} activeTabId="preview-card" onSelect={() => undefined} />
      </NodexTooltipProvider>
    );
    const view = render(renderTabs(makePromotionTabs(true)));
    const editor = view.getByLabelText("Editor preview-card") as HTMLInputElement;

    editor.focus();
    expect(document.activeElement).toBe(editor);
    expect(mounts.join(",")).toBe("preview-card");
    expect(unmounts.length).toBe(0);

    view.rerender(renderTabs(makePromotionTabs(false)));

    expect(document.activeElement).toBe(editor);
    expect(mounts.join(",")).toBe("preview-card");
    expect(unmounts.length).toBe(0);
    expect(view.container.querySelectorAll('[role="tabpanel"]').length).toBe(1);
  });

  test("preserves tab chrome when semantic preview identity changes", () => {
    const makePreviewTabs = (id: string, title: string): AppShellTabItem[] => [
      {
        id,
        presentationId: "preview-presentation",
        title,
        preview: true,
        closable: true,
        renderPanel: () => <div>{title} panel</div>,
      },
    ];
    const renderTabs = (tabs: AppShellTabItem[]) => (
      <NodexTooltipProvider>
        <AppShellTabs
          tabs={tabs}
          activeTabId={tabs[0]?.id ?? ""}
          onSelect={() => undefined}
          onCloseTab={() => undefined}
        />
      </NodexTooltipProvider>
    );
    const view = render(renderTabs(makePreviewTabs("preview-a", "A.ts")));
    const initialChrome = getTabController(view, "preview-a");

    view.rerender(renderTabs(makePreviewTabs("preview-b", "B.ts")));

    const replacementChrome = getTabController(view, "preview-b");
    expect(replacementChrome).toBe(initialChrome);
    expect(view.queryByText("A.ts")).toBe(null);
    expect(view.getByText("B.ts") !== null).toBe(true);
  });

  test("does not pin a preview from an exempt panel interaction", async () => {
    const pinned: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "preview-file",
      onPinTab: (tabId) => pinned.push(tabId),
      tabs: [
        {
          id: "preview-file",
          title: "one.ts",
          preview: true,
          renderPanel: () => (
            <div data-tab-preview-pin-exempt="true">
              <button type="button">Open two.ts</button>
            </div>
          ),
        },
      ],
    });

    await act(async () => {
      fireEvent.pointerDown(view.getByRole("button", { name: "Open two.ts" }));
      fireEvent.keyDown(view.getByRole("button", { name: "Open two.ts" }), {
        key: "Enter",
      });
      await Promise.resolve();
    });

    expect(pinned).toEqual([]);

    await act(async () => {
      fireEvent.pointerDown(view.getByRole("tabpanel"));
      await Promise.resolve();
    });

    expect(pinned).toEqual(["preview-file"]);
  });

  test("keeps a pin-disabled preview ephemeral across panel and label interactions", async () => {
    const pinned: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "image-preview",
      onPinTab: (tabId) => pinned.push(tabId),
      tabs: [
        {
          id: "image-preview",
          title: "User attachment",
          preview: true,
          pinBehavior: "disabled",
          renderPanel: () => <button type="button">Comment</button>,
        },
      ],
    });

    await act(async () => {
      fireEvent.pointerDown(view.getByRole("button", { name: "Comment" }));
      fireEvent.keyDown(view.getByRole("button", { name: "Comment" }), {
        key: "Enter",
      });
      fireEvent.doubleClick(
        view.getByRole("tab", {
          name: "User attachment",
        }),
      );
      await Promise.resolve();
    });

    expect(pinned).toEqual([]);
    expect(view.getByRole("tabpanel").getAttribute("data-app-shell-tabpanel-preview")).toBe("true");
  });

  test("pins an automatic image preview when its tab label is double-clicked", async () => {
    const pinned: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "image-preview",
      onPinTab: (tabId) => pinned.push(tabId),
      tabs: [
        {
          id: "image-preview",
          title: "User attachment",
          preview: true,
          pinBehavior: "automatic",
          renderPanel: () => <div>Image editor</div>,
        },
      ],
    });

    await act(async () => {
      fireEvent.doubleClick(
        view.getByRole("tab", {
          name: "User attachment",
        }),
      );
      await Promise.resolve();
    });

    expect(pinned).toEqual(["image-preview"]);
  });

  test("removes a focused inactive panel after active tab changes", () => {
    const tabs: AppShellTabItem[] = [
      {
        id: "one",
        title: "One",
        renderPanel: () => <input aria-label="Editor one" />,
      },
      {
        id: "two",
        title: "Two",
        renderPanel: () => <input aria-label="Editor two" />,
      },
    ];
    const renderTabs = (activeTabId: string) => (
      <NodexTooltipProvider>
        <AppShellTabs tabs={tabs} activeTabId={activeTabId} onSelect={() => undefined} />
      </NodexTooltipProvider>
    );
    const view = render(renderTabs("one"));
    const firstEditor = view.getByLabelText("Editor one") as HTMLInputElement;

    firstEditor.focus();
    expect(document.activeElement).toBe(firstEditor);

    view.rerender(renderTabs("two"));

    expect(document.activeElement === firstEditor).toBe(false);
    expect(view.queryByLabelText("Editor one")).toBe(null);
    expect(view.getByLabelText("Editor two")).toBeTruthy();
  });

  test("renders body overlays inside the tabpanel instead of the tab header", () => {
    const view = renderAppShellTabs({
      bodyOverlay: <div data-testid="body-overlay">Drop zones</div>,
      headerEndInsetPx: 48,
    });

    const header = view.getByRole("tablist").parentElement?.parentElement;
    const tabpanel = view.getByRole("tabpanel");
    const headerInsetSpacer = header?.lastElementChild;

    expect(tabpanel.contains(view.getByTestId("body-overlay"))).toBe(true);
    expect(header?.contains(view.getByTestId("body-overlay"))).toBe(false);
    expect(header?.className.includes("draggable")).toBe(false);
    expect(headerInsetSpacer?.className.includes("no-drag")).toBe(true);
    expect(headerInsetSpacer?.getAttribute("style")?.includes("width: 48px")).toBe(true);
  });

  test("renders tab header slots in before, sticky, after order", () => {
    const view = renderAppShellTabs({
      beforeList: <span data-testid="before-list">Before</span>,
      afterTabsInline: <span data-testid="after-tabs-inline">Inline</span>,
      afterListSticky: <span data-testid="after-list-sticky">Sticky</span>,
      afterList: <span data-testid="after-list">After</span>,
      tabScrollEndPaddingPx: 28,
    });
    const header = view.getByRole("tablist").parentElement?.parentElement;
    if (!header) throw new Error("Expected tab header");
    const tabRow = view.getByRole("tablist").parentElement;
    if (!(tabRow instanceof HTMLElement)) throw new Error("Expected tab row");

    const text = textContent(header);
    expect(header.className.includes("draggable")).toBe(false);
    expect(text.indexOf("Before") < text.indexOf("One")).toBe(true);
    expect(text.indexOf("Inline") > text.indexOf("History")).toBe(true);
    expect(text.indexOf("Inline") < text.indexOf("Sticky")).toBe(true);
    expect(text.indexOf("Sticky") > text.indexOf("History")).toBe(true);
    expect(text.indexOf("Sticky") < text.indexOf("After")).toBe(true);
    expect(tabRow.style.scrollPaddingInlineEnd).toBe("28px");
    expect(view.getByTestId("before-list").parentElement?.getAttribute("role")).toBe(
      "presentation",
    );
    expect(view.getByTestId("before-list").parentElement?.className.includes("no-drag")).toBe(true);
    expect(view.getByTestId("after-tabs-inline").parentElement?.className.includes("sticky")).toBe(
      true,
    );
    expect(view.getByTestId("after-tabs-inline").parentElement?.className.includes("no-drag")).toBe(
      true,
    );
    expect(view.getByTestId("after-tabs-inline").parentElement?.className.includes("right-0")).toBe(
      true,
    );
    expect(view.getByTestId("after-list-sticky").parentElement?.getAttribute("role")).toBe(
      "presentation",
    );
    expect(view.getByTestId("after-list-sticky").parentElement?.className.includes("no-drag")).toBe(
      true,
    );
    expect(view.getByTestId("after-list").parentElement?.getAttribute("role")).toBe("presentation");
    expect(view.getByTestId("after-list").parentElement?.className.includes("no-drag")).toBe(true);
  });

  test("does not render the title fade when the tab title fits", () => {
    const view = renderAppShellTabs({ activeTabId: "two" });

    expect(view.container.querySelector('[data-app-shell-tab-title-fade="two"]') === null).toBe(
      true,
    );
  });

  test("renders the title fade only when the tab title overflows", async () => {
    const view = renderAppShellTabs({ activeTabId: "two" });
    const title = view.container.querySelector('[data-app-shell-tab-title="two"]');
    if (!(title instanceof HTMLElement)) throw new Error("Expected title element");

    Object.defineProperty(title, "clientWidth", {
      configurable: true,
      value: 80,
    });
    Object.defineProperty(title, "scrollWidth", {
      configurable: true,
      value: 180,
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(view.container.querySelector('[data-app-shell-tab-title-fade="two"]') === null).toBe(
      false,
    );
  });

  test("close button suppresses selection on mouse down", () => {
    const selected: string[] = [];
    const closed: string[] = [];
    const directClosed: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "one",
      onSelect: (tabId) => selected.push(tabId),
      onCloseTab: (tabId) => closed.push(tabId),
      onDirectCloseTab: (tabId) => directClosed.push(tabId),
    });

    const closeButton = view.getByLabelText("Close Two tab");
    const closeIcon = closeButton.querySelector("svg");
    expect(closeButton.tagName).toBe("BUTTON");
    expect(closeIcon?.getAttribute("viewBox")).toBe("0 0 21 21");
    expect(
      closeIcon?.querySelector("path")?.getAttribute("d")?.startsWith("M14.6549 5.57307"),
    ).toBe(true);

    fireEvent.mouseDown(closeButton, { button: 0 });
    fireEvent.click(closeButton);

    expect(closed.length).toBe(0);
    expect(directClosed.join(",")).toBe("two");
    expect(selected.length).toBe(0);
  });

  test("middle-click closes a closable tab", () => {
    const closed: string[] = [];
    const directClosed: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "one",
      onCloseTab: (tabId) => closed.push(tabId),
      onDirectCloseTab: (tabId) => directClosed.push(tabId),
    });

    const tabChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="two"] [data-tab-id="two"]',
    );
    if (!tabChrome) throw new Error("Expected tab chrome");
    fireEvent.mouseDown(tabChrome, { button: 1 });

    expect(closed.length).toBe(0);
    expect(directClosed.join(",")).toBe("two");
  });

  test("direct close locks the whole row to the clicked tab width", async () => {
    const closed: string[] = [];
    const tabs: AppShellTabItem[] = [
      {
        id: "one",
        title: "Long active tab title",
        closable: true,
        renderPanel: () => <div>Panel one</div>,
      },
      { id: "two", title: "Two", closable: true, renderPanel: () => <div>Panel two</div> },
      { id: "three", title: "Three", closable: true, renderPanel: () => <div>Panel three</div> },
    ];
    const view = renderAppShellTabs({
      tabs,
      activeTabId: "one",
      onCloseTab: (tabId) => closed.push(tabId),
    });
    prepareTabWidths(view, [
      ["one", 148],
      ["two", 72],
      ["three", 84],
    ]);

    const closeButton = view.getByLabelText("Close Long active tab title tab");
    await act(async () => {
      fireEvent.mouseDown(closeButton, { button: 0 });
      fireEvent.click(closeButton);
      await Promise.resolve();
    });

    const tabRow = getTabRowElement(view.getByRole("tablist"));
    const tabList = view.getByRole("tablist");
    expect(closed.join(",")).toBe("one");
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe("true");
    expect(tabList.style.width).toBe("450px");
    expect(getTabController(view, "one").style.flexBasis).toBe("148px");
    expect(getTabController(view, "two").style.flexBasis).toBe("148px");
    expect(getTabController(view, "three").style.flexBasis).toBe("148px");
    expect(getTabController(view, "two").style.flexGrow).toBe("0");
  });

  test("middle-click also enters rapid close mode", async () => {
    const closed: string[] = [];
    const tabs: AppShellTabItem[] = [
      { id: "one", title: "One", closable: true, renderPanel: () => <div>Panel one</div> },
      {
        id: "two",
        title: "Two with a long title",
        closable: true,
        renderPanel: () => <div>Panel two</div>,
      },
    ];
    const view = renderAppShellTabs({
      tabs,
      activeTabId: "one",
      onCloseTab: (tabId) => closed.push(tabId),
    });
    prepareTabWidths(view, [
      ["one", 96],
      ["two", 156],
    ]);

    const tabChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-panel-tab-id="one"] [data-tab-id="one"]',
    );
    if (!tabChrome) throw new Error("Expected tab chrome");
    await act(async () => {
      fireEvent.mouseDown(tabChrome, { button: 1 });
      await Promise.resolve();
    });

    expect(closed.join(",")).toBe("one");
    expect(view.getByRole("tablist").style.width).toBe("195px");
    expect(getTabController(view, "two").style.flexBasis).toBe("96px");
    expect(getTabController(view, "two").style.flexGrow).toBe("0");
  });

  test("wheel and pointer leave exit rapid close mode", async () => {
    const view = renderAppShellTabs({
      tabs: [
        { id: "one", title: "One", closable: true, renderPanel: () => <div>Panel one</div> },
        { id: "two", title: "Two", closable: true, renderPanel: () => <div>Panel two</div> },
      ],
      activeTabId: "one",
      onCloseTab: () => undefined,
    });
    prepareTabWidths(view, [
      ["one", 96],
      ["two", 72],
    ]);

    await clickCloseButton(view, "Close One tab");
    const tabRow = getTabRowElement(view.getByRole("tablist"));
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe("true");

    makeScrollable(tabRow, { clientWidth: 100, scrollWidth: 300 });
    await act(async () => {
      dispatchWheel(tabRow, { deltaY: 40 });
      await Promise.resolve();
    });
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe(null);

    await clickCloseButton(view, "Close One tab");
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe("true");
    await act(async () => {
      fireEvent.pointerLeave(tabRow);
      await Promise.resolve();
    });
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe(null);
  });

  test("opening a context menu exits rapid close mode", async () => {
    const view = renderAppShellTabs({
      tabs: [
        { id: "one", title: "One", closable: true, renderPanel: () => <div>Panel one</div> },
        { id: "two", title: "Two", closable: true, renderPanel: () => <div>Panel two</div> },
      ],
      activeTabId: "one",
      onCloseTab: () => undefined,
    });
    prepareTabWidths(view, [
      ["one", 96],
      ["two", 72],
    ]);

    await clickCloseButton(view, "Close One tab");
    const tabRow = getTabRowElement(view.getByRole("tablist"));
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe("true");

    fireEvent.contextMenu(getTabController(view, "one"));
    await settleAsyncRender();
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe(null);
  });

  test("active panel tab drag exits rapid close mode", async () => {
    const tabs: AppShellTabItem[] = [
      {
        id: "one",
        title: "One",
        closable: true,
        reorderable: true,
        renderPanel: () => <div>Panel one</div>,
      },
      {
        id: "two",
        title: "Two",
        closable: true,
        reorderable: true,
        renderPanel: () => <div>Panel two</div>,
      },
    ];
    const renderWithActiveDragId = (activeDragId: string | null) => (
      <NodexTooltipProvider>
        <AppShellTabs
          tabs={tabs}
          activeTabId="one"
          onSelect={() => undefined}
          onCloseTab={() => undefined}
          panelTabDnd={{
            sessionId: "session-1",
            panelId: "right",
            leafId: "leaf-a",
            activeDragId,
            previewIntent: null,
          }}
        />
      </NodexTooltipProvider>
    );
    const view = render(renderWithActiveDragId(null));
    prepareTabWidths(view, [
      ["one", 96],
      ["two", 72],
    ]);

    await clickCloseButton(view, "Close One tab");
    const tabRow = getTabRowElement(view.getByRole("tablist"));
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe("true");

    await act(async () => {
      view.rerender(renderWithActiveDragId("one"));
      await Promise.resolve();
    });
    expect(tabRow.getAttribute("data-app-shell-tab-close-mode")).toBe(null);
  });

  test("selects tabs on primary mouse down", () => {
    const selected: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "one",
      onSelect: (tabId) => selected.push(tabId),
    });

    fireEvent.mouseDown(view.getByRole("tab", { name: "Two" }), { button: 0 });

    expect(selected.join(",")).toBe("two");
  });

  test("scrolls the tab row horizontally from wheel input", async () => {
    const view = renderAppShellTabs({});
    await settleAsyncRender();
    const tabRow = getTabRowElement(view.getByRole("tablist"));
    makeScrollable(tabRow, { clientWidth: 200, scrollWidth: 600 });

    const verticalWheel = dispatchWheel(tabRow, { deltaY: 120 });
    expect(tabRow.scrollLeft).toBe(120);
    expect(verticalWheel.defaultPrevented).toBe(true);

    const horizontalWheel = dispatchWheel(tabRow, { deltaX: -40 });
    expect(tabRow.scrollLeft).toBe(120);
    expect(horizontalWheel.defaultPrevented).toBe(false);

    const equalAxisWheel = dispatchWheel(tabRow, { deltaX: 40, deltaY: 40 });
    expect(tabRow.scrollLeft).toBe(120);
    expect(equalAxisWheel.defaultPrevented).toBe(false);

    const lineWheel = dispatchWheel(tabRow, { deltaY: 2, deltaMode: 1 });
    expect(tabRow.scrollLeft).toBe(152);
    expect(lineWheel.defaultPrevented).toBe(true);

    tabRow.scrollLeft = 0;
    const edgeWheel = dispatchWheel(tabRow, { deltaY: -20 });
    expect(tabRow.scrollLeft).toBe(0);
    expect(edgeWheel.defaultPrevented).toBe(false);
  });

  test("reveals the newly active tab inside the horizontal strip", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const tabs = makeTabs();
    const renderTabs = (activeTabId: string) => (
      <NodexTooltipProvider>
        <AppShellTabs tabs={tabs} activeTabId={activeTabId} onSelect={() => undefined} />
      </NodexTooltipProvider>
    );

    try {
      const view = render(renderTabs("one"));
      scrollIntoView.mockClear();

      await act(async () => {
        view.rerender(renderTabs("two"));
        await Promise.resolve();
      });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });

      motionPreference.reduced = true;
      scrollIntoView.mockClear();
      await act(async () => {
        view.rerender(renderTabs("history"));
        await Promise.resolve();
      });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      motionPreference.reduced = false;
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("removes exiting tab chrome immediately when reduced motion is requested", async () => {
    motionPreference.reduced = true;
    const tabs = makeTabs();
    const renderTabs = (visibleTabs: AppShellTabItem[]) => (
      <NodexTooltipProvider>
        <AppShellTabs tabs={visibleTabs} activeTabId="one" onSelect={() => undefined} />
      </NodexTooltipProvider>
    );

    try {
      const view = render(renderTabs(tabs));

      await act(async () => {
        view.rerender(renderTabs(tabs.filter((tab) => tab.id !== "two")));
        await Promise.resolve();
      });

      expect(
        view.container.querySelector('[data-app-shell-tab-controller][data-panel-tab-id="two"]'),
      ).toBe(null);
    } finally {
      motionPreference.reduced = false;
    }
  });

  test("tracks clipped tab-strip edges from intersection sentinels", async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
    }> = [];
    const OriginalIntersectionObserver = globalThis.IntersectionObserver;
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0.99];
      readonly scrollMargin = "0px";
      private readonly record: {
        callback: IntersectionObserverCallback;
        targets: Element[];
      };

      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }

      disconnect() {}
      observe(target: Element) {
        this.record.targets.push(target);
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve() {}
    }
    globalThis.IntersectionObserver = TestIntersectionObserver;

    try {
      const view = renderAppShellTabs({});
      const observer = observers[0];
      if (!observer) throw new Error("Expected edge observer");
      const [startSentinel, endSentinel] = observer.targets;
      if (!startSentinel || !endSentinel) throw new Error("Expected two edge sentinels");

      await act(async () => {
        observer.callback(
          [
            { target: startSentinel, isIntersecting: false } as IntersectionObserverEntry,
            { target: endSentinel, isIntersecting: true } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
        await Promise.resolve();
      });

      expect(
        view.container
          .querySelector('[data-app-shell-tab-edge-fade="start"]')
          ?.getAttribute("data-clipped"),
      ).toBe("true");
      expect(
        view.container
          .querySelector('[data-app-shell-tab-edge-fade="end"]')
          ?.getAttribute("data-clipped"),
      ).toBe("false");
    } finally {
      globalThis.IntersectionObserver = OriginalIntersectionObserver;
    }
  });

  test("context menu close is available only for closable tabs", async () => {
    const closed: string[] = [];
    const view = renderAppShellTabs({
      activeTabId: "one",
      onCloseTab: (tabId) => closed.push(tabId),
    });

    const closableChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="two"]',
    );
    if (!closableChrome) throw new Error("Expected closable tab chrome");
    fireEvent.contextMenu(closableChrome);
    await settleAsyncRender();
    fireEvent.click(view.getByText("Close"));

    expect(closed.join(",")).toBe("two");
    expect(view.queryByLabelText("Close History tab")).toBe(null);
  });

  test("context menu appends Codex close actions after feature actions", async () => {
    const tabs = makeTabs();
    tabs[1] = {
      ...tabs[1],
      splittable: true,
      contextMenuItems: [
        {
          id: "browser-new-tab-right",
          label: "New tab to the right",
          onSelect: () => undefined,
        },
        {
          id: "browser-reload",
          label: "Reload",
          onSelect: () => undefined,
        },
        {
          id: "browser-duplicate",
          label: "Duplicate",
          onSelect: () => undefined,
        },
      ],
    };
    const closed: string[] = [];
    const view = renderAppShellTabs({
      tabs,
      activeTabId: "two",
      onCloseTab: (tabId) => closed.push(tabId),
      onMoveTab: () => undefined,
      onSplitTab: () => undefined,
    });

    const tabChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="two"]',
    );
    if (!tabChrome) throw new Error("Expected tab chrome");
    fireEvent.contextMenu(tabChrome);
    await settleAsyncRender();

    const menu = view.getByRole("menu");
    const menuText = textContent(menu);
    expect(menuText.indexOf("New tab to the right") < menuText.indexOf("Close")).toBe(true);
    expect(menuText.indexOf("Reload") < menuText.indexOf("Close")).toBe(true);
    expect(menuText.indexOf("Duplicate") < menuText.indexOf("Close")).toBe(true);
    expect(within(menu).getByText("Close other tabs") !== null).toBe(true);
    expect(within(menu).getByText("Close tabs to the right") !== null).toBe(true);
    expect(within(menu).getByText("Move to bottom panel") !== null).toBe(true);
    expect(within(menu).getByText("Split tab right") !== null).toBe(true);

    const closeTabsToRightItem = within(menu)
      .getByText("Close tabs to the right")
      .closest('[role="menuitem"]');
    expect(closeTabsToRightItem?.getAttribute("data-disabled")).toBe("");

    fireEvent.click(within(menu).getByText("Close other tabs"));
    expect(closed.join(",")).toBe("one");
  });

  test("context menu disables close-tabs-to-right when only non-closable tabs follow", async () => {
    const view = renderAppShellTabs({
      activeTabId: "two",
      onCloseTab: () => undefined,
    });

    const tabChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="two"]',
    );
    if (!tabChrome) throw new Error("Expected tab chrome");
    fireEvent.contextMenu(tabChrome);
    await settleAsyncRender();

    const closeTabsToRightItem = view
      .getByText("Close tabs to the right")
      .closest('[role="menuitem"]');
    expect(closeTabsToRightItem?.getAttribute("data-disabled")).toBe("");
  });

  test("context menu closes closable tabs to the right only", async () => {
    const closed: string[] = [];
    const tabs: AppShellTabItem[] = [
      ...makeTabs(),
      {
        id: "three",
        title: "Three",
        closable: true,
        renderPanel: () => <div>Panel three</div>,
      },
    ];
    const view = renderAppShellTabs({
      tabs,
      activeTabId: "one",
      onCloseTab: (tabId) => closed.push(tabId),
    });

    const tabChrome = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="one"]',
    );
    if (!tabChrome) throw new Error("Expected tab chrome");
    fireEvent.contextMenu(tabChrome);
    await settleAsyncRender();
    fireEvent.click(view.getByText("Close tabs to the right"));

    expect(closed.join(",")).toBe("three,two");
  });

  test("places tab ids on the wrapper and leaves native DnD opt-in", () => {
    const view = renderAppShellTabs({ activeTabId: "one" });

    const wrapper = view.container.querySelector(
      '[data-app-shell-tab-controller][data-tab-id="two"]',
    );
    expect(wrapper?.className.includes("no-drag")).toBe(true);
    expect(wrapper?.getAttribute("data-panel-tab-id")).toBe("two");
    expect(wrapper?.getAttribute("aria-roledescription")).toBe(null);
  });

  test("renders a panel tab insertion marker from the preview intent", () => {
    const view = renderAppShellTabs({
      panelTabDnd: {
        sessionId: "session-1",
        panelId: "right",
        leafId: "leaf-a",
        activeDragId: "one",
        previewIntent: {
          kind: "tab-row",
          panelId: "right",
          leafId: "leaf-a",
          targetIndex: 2,
          markerLeft: 48,
        },
      },
    });

    const marker = view.container.querySelector(
      '[data-panel-tab-insertion-marker="right:leaf-a:2"]',
    );
    expect(marker instanceof HTMLElement).toBe(true);
    expect((marker as HTMLElement).style.left).toBe("48px");
  });

  test("keeps the panel tab insertion marker while rapid close mode is active", async () => {
    const view = renderAppShellTabs({
      tabs: [
        { id: "one", title: "One", closable: true, renderPanel: () => <div>Panel one</div> },
        { id: "two", title: "Two", closable: true, renderPanel: () => <div>Panel two</div> },
      ],
      activeTabId: "one",
      onCloseTab: () => undefined,
      panelTabDnd: {
        sessionId: "session-1",
        panelId: "right",
        leafId: "leaf-a",
        activeDragId: null,
        previewIntent: {
          kind: "tab-row",
          panelId: "right",
          leafId: "leaf-a",
          targetIndex: 1,
          markerLeft: 48,
        },
      },
    });
    prepareTabWidths(view, [
      ["one", 96],
      ["two", 72],
    ]);

    await clickCloseButton(view, "Close One tab");

    const marker = view.container.querySelector(
      '[data-panel-tab-insertion-marker="right:leaf-a:1"]',
    );
    expect(marker instanceof HTMLElement).toBe(true);
    expect((marker as HTMLElement).style.left).toBe("48px");
    expect(getTabController(view, "two").style.flexBasis).toBe("96px");
  });

  test("does not render a panel tab insertion marker for another leaf", () => {
    const view = renderAppShellTabs({
      panelTabDnd: {
        sessionId: "session-1",
        panelId: "right",
        leafId: "leaf-a",
        activeDragId: "one",
        previewIntent: {
          kind: "tab-row",
          panelId: "right",
          leafId: "leaf-b",
          targetIndex: 0,
          markerLeft: 4,
        },
      },
    });

    expect(view.container.querySelector("[data-panel-tab-insertion-marker]") === null).toBe(true);
  });

  test("shows separators for projected drag positions", () => {
    expect(
      shouldShowAppShellTabSeparator({
        index: 0,
        tabCount: 3,
        activeIndex: 2,
        draggingIndex: 2,
        isActive: false,
        isDragging: false,
      }),
    ).toBe(true);
    expect(
      shouldShowAppShellTabSeparator({
        index: 1,
        tabCount: 3,
        activeIndex: 2,
        draggingIndex: 2,
        isActive: false,
        isDragging: false,
      }),
    ).toBe(false);
  });
});

function getTabRowElement(tablist: HTMLElement): HTMLElement {
  const tabRow = tablist.parentElement;
  if (!(tabRow instanceof HTMLElement)) throw new Error("Expected tab row element");
  return tabRow;
}

function makeScrollable(
  element: HTMLElement,
  {
    clientWidth,
    scrollWidth,
  }: {
    clientWidth: number;
    scrollWidth: number;
  },
) {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  element.scrollLeft = 0;
}

function dispatchWheel(
  target: HTMLElement,
  {
    deltaX = 0,
    deltaY = 0,
    deltaMode = 0,
    ctrlKey = false,
    metaKey = false,
  }: {
    deltaX?: number;
    deltaY?: number;
    deltaMode?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
  },
): Event {
  const event = new Event("wheel", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey },
    deltaMode: { value: deltaMode },
    deltaX: { value: deltaX },
    deltaY: { value: deltaY },
    metaKey: { value: metaKey },
  });
  target.dispatchEvent(event);
  return event;
}

async function clickCloseButton(view: ReturnType<typeof render>, label: string) {
  const closeButton = view.getByLabelText(label);
  await act(async () => {
    fireEvent.mouseDown(closeButton, { button: 0 });
    fireEvent.click(closeButton);
    await Promise.resolve();
  });
}

function prepareTabWidths(view: ReturnType<typeof render>, tabWidths: [string, number][]) {
  for (const [tabId, width] of tabWidths) {
    Object.defineProperty(getTabController(view, tabId), "offsetWidth", {
      configurable: true,
      value: width,
    });
  }
}

function getTabController(view: ReturnType<typeof render>, tabId: string): HTMLElement {
  const element = view.container.querySelector(
    `[data-app-shell-tab-controller][data-panel-tab-id="${tabId}"]`,
  );
  if (!(element instanceof HTMLElement)) throw new Error(`Expected tab controller for ${tabId}`);
  return element;
}
