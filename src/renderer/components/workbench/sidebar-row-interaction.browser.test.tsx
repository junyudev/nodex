import { type CSSProperties, useState } from "react";
import { act } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { Project, CodexSidebarThreadItem } from "@/lib/types";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { CodexProjectRow, CodexSidebarThreadRow } from "./codex-sidebar";
import "../../globals.css";
import { emptySessionLinkedPageStore } from "../../test/session-linked-page";
import { CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS } from "@/lib/codex-sidebar-pagination";
import { SidebarPaginatedItems, SidebarPaginatedRows } from "./sidebar-paginated-items";

describe("codex project row", () => {
  const PROJECT: Project = {
    id: "project-alpha",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Alpha",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-08-01T00:00:00.000Z"),
    updated: new Date("2026-08-01T00:00:00.000Z"),
  };

  describe("CodexProjectRow interaction chrome in Chromium", () => {
    test("keeps the marker at rest and layers row and disclosure hover states", async () => {
      const view = render(
        <TestQueryProvider>
          <NodexHoverCardProvider delay={0} timeoutMs={0}>
            <NodexTooltipProvider>
              <div
                className="w-72"
                style={
                  {
                    "--color-token-list-hover-background": "rgba(13, 13, 13, 0.08)",
                  } as CSSProperties
                }
              >
                <CodexProjectRow
                  project={PROJECT}
                  active
                  expanded
                  onActivate={() => undefined}
                  onSelectProject={() => undefined}
                  onUpdateProject={async () => null}
                  onArchiveProject={async () => ({ kind: "not-found" })}
                />
              </div>
            </NodexTooltipProvider>
          </NodexHoverCardProvider>
        </TestQueryProvider>,
      );
      const row = view.container.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-row]",
      );
      const marker = view.container.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-marker]",
      );
      const disclosure = view.getByRole("button", { name: "Collapse project" });
      const projectNavigation = view.getByRole("button", { name: "Open Alpha" });
      if (!row || !marker) throw new Error("Expected Project row chrome");

      expect(getComputedStyle(marker).visibility).toBe("visible");
      expect(getComputedStyle(disclosure).opacity).toBe("0");

      await act(async () => {
        await userEvent.click(projectNavigation);
        await userEvent.unhover(row);
      });
      expect(document.activeElement).toBe(projectNavigation);
      expect(getComputedStyle(marker).visibility).toBe("visible");
      expect(getComputedStyle(disclosure).opacity).toBe("0");

      await act(async () => {
        await userEvent.hover(row);
      });
      expect(getComputedStyle(marker).visibility).toBe("hidden");
      expect(getComputedStyle(disclosure).opacity).toBe("1");
      expect(getComputedStyle(disclosure).backgroundColor).toBe("rgba(0, 0, 0, 0)");

      await act(async () => {
        await userEvent.hover(disclosure);
      });
      expect(getComputedStyle(disclosure).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

      await act(async () => {
        await userEvent.unhover(row);
        await userEvent.tab({ shift: true });
      });
      expect(document.activeElement).toBe(disclosure);
      expect(getComputedStyle(marker).visibility).toBe("hidden");
      expect(getComputedStyle(disclosure).opacity).toBe("1");
    });

    test("summarizes a collapsed Project's unread chats at its trailing edge until hover", async () => {
      const renderRow = (expanded: boolean) => (
        <TestQueryProvider>
          <NodexHoverCardProvider>
            <NodexTooltipProvider>
              <div className="w-72">
                <CodexProjectRow
                  project={PROJECT}
                  activity={{
                    projectId: PROJECT.id,
                    taskCount: 3,
                    waitingCount: 0,
                    unreadCount: 1,
                    activeCount: 1,
                  }}
                  active={false}
                  expanded={expanded}
                  hoverCardOpen={false}
                  onActivate={() => undefined}
                  onSelectProject={() => undefined}
                  onStartNewChat={() => undefined}
                  onUpdateProject={async () => null}
                  onArchiveProject={async () => ({ kind: "not-found" })}
                />
              </div>
            </NodexTooltipProvider>
          </NodexHoverCardProvider>
        </TestQueryProvider>
      );
      const view = render(renderRow(false));
      const row = view.container.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-row]",
      );
      if (!row) throw new Error("Expected Project row");
      const dot = view.getByRole("img", { name: "Unread chats" });
      const painted = (element: Element) =>
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      await act(async () => {
        await userEvent.unhover(row);
      });
      expect(painted(dot)).toBe(true);
      expect(view.queryByRole("status")).toBeNull();
      expect(
        row.getBoundingClientRect().right - dot.getBoundingClientRect().right,
      ).toBeLessThanOrEqual(8);

      await act(async () => {
        await userEvent.hover(row);
      });
      expect(painted(dot)).toBe(false);
      expect(painted(view.getByRole("button", { name: "Start new chat in Alpha" }))).toBe(true);

      view.rerender(renderRow(true));
      expect(view.queryByRole("img", { name: "Unread chats" })).toBeNull();
    });

    test("shares the trailing space between the Inbox count and pointer or keyboard actions", async () => {
      const onStartNewChat = vi.fn();
      const view = render(
        <TestQueryProvider>
          <NodexHoverCardProvider>
            <NodexTooltipProvider>
              <div className="w-72">
                <CodexProjectRow
                  project={PROJECT}
                  active={false}
                  expanded
                  inboxCount={12}
                  hoverCardOpen={false}
                  onActivate={() => undefined}
                  onSelectProject={() => undefined}
                  onStartNewChat={onStartNewChat}
                  onUpdateProject={async () => null}
                  onArchiveProject={async () => ({ kind: "not-found" })}
                />
              </div>
            </NodexTooltipProvider>
          </NodexHoverCardProvider>
        </TestQueryProvider>,
      );
      const row = view.container.querySelector<HTMLElement>(
        "[data-app-action-sidebar-project-row]",
      );
      if (!row) throw new Error("Expected Project row");
      const count = view.getByLabelText("12 in Alpha's Inbox");
      const projectNavigation = view.getByRole("button", { name: "Open Alpha" });
      const menu = view.getByRole("button", { name: "Project actions for Alpha" });
      const newChat = view.getByRole("button", { name: "Start new chat in Alpha" });
      const painted = (element: Element) =>
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      await act(async () => {
        await userEvent.unhover(row);
      });
      expect(painted(count)).toBe(true);
      expect(painted(menu)).toBe(false);
      expect(painted(newChat)).toBe(false);
      const text = document.createRange();
      text.selectNodeContents(count);
      const countRight = text.getBoundingClientRect().right;
      expect(row.getBoundingClientRect().right - countRight).toBeLessThanOrEqual(8);
      expect(countRight).toBeGreaterThan(newChat.getBoundingClientRect().left);
      expect(countRight).toBeLessThanOrEqual(newChat.getBoundingClientRect().right);

      await act(async () => {
        await userEvent.hover(row);
      });
      expect(painted(count)).toBe(false);
      expect(painted(menu)).toBe(true);
      expect(painted(newChat)).toBe(true);
      await act(async () => {
        await userEvent.click(menu);
        await userEvent.unhover(row);
      });
      expect(menu.getAttribute("aria-expanded")).toBe("true");
      expect(painted(count)).toBe(false);
      await act(async () => {
        await userEvent.keyboard("{Escape}");
        projectNavigation.focus();
        await userEvent.tab();
      });
      expect(document.activeElement).toBe(menu);
      expect(painted(count)).toBe(false);
      expect(painted(menu)).toBe(true);
      await act(async () => {
        await userEvent.tab();
      });
      expect(document.activeElement).toBe(newChat);
      expect(painted(newChat)).toBe(true);
      await act(async () => {
        await userEvent.keyboard("{Enter}");
      });
      expect(onStartNewChat).toHaveBeenCalledOnce();
    });
  });
});

describe("codex sidebar actions", () => {
  const THREAD: CodexSidebarThreadItem = {
    key: "local:thread-alpha",
    kind: "local",
    backendBinding: { driver: "codex", instanceId: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId: "thread-alpha",
    parentThreadId: null,
    sessionId: "session-alpha",
    projectId: "project-alpha",
    title: "Drag an open rich tooltip",
    preview: "",
    cwd: null,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    pinned: true,
    pinnedOrder: null,
    unread: false,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    archived: false,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: false,
    disabled: false,
  };

  test.each(["hover", "keyboard", "menu"] as const)(
    "keeps pinned chat actions independently clickable with %s chrome",
    async (mode) => {
      const onSelect = vi.fn();
      const onTogglePinned = vi.fn();
      const onArchive = vi.fn();
      const view = render(
        <TestQueryProvider>
          <NodexHoverCardProvider>
            <NodexTooltipProvider>
              <div className="w-60">
                <CodexSidebarThreadRow
                  item={THREAD}
                  linkedPageStore={emptySessionLinkedPageStore}
                  active={false}
                  grouped
                  contextMenuOpen={mode === "menu"}
                  hoverCardOpen={false}
                  onSelect={onSelect}
                  onTogglePinned={onTogglePinned}
                  onArchive={onArchive}
                />
              </div>
            </NodexTooltipProvider>
          </NodexHoverCardProvider>
        </TestQueryProvider>,
      );
      const row = view.container.querySelector<HTMLElement>("[data-app-action-sidebar-thread-row]");
      if (!row) throw new Error("Expected chat row");
      const pin = view.getByRole("button", { name: "Unpin chat" });
      const archive = view.getByRole("button", { name: "Archive chat" });
      await act(async () => {
        if (mode === "hover") await userEvent.hover(row);
        if (mode === "keyboard") await userEvent.tab();
      });
      const pinRect = pin.getBoundingClientRect();
      const archiveRect = archive.getBoundingClientRect();
      expect(pinRect.right).toBeLessThanOrEqual(archiveRect.left);
      expect(
        pin.contains(
          document.elementFromPoint(pinRect.x + pinRect.width / 2, pinRect.y + pinRect.height / 2),
        ),
      ).toBe(true);
      await act(async () => {
        await userEvent.click(pin);
      });
      expect(onTogglePinned).toHaveBeenCalledExactlyOnceWith(THREAD);
      expect(onArchive).not.toHaveBeenCalled();
      await act(async () => {
        await userEvent.click(archive);
      });
      expect(onArchive).toHaveBeenCalledExactlyOnceWith(THREAD);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  test.each([240, 320])("aligns project pagination text with Session titles at %ipx", (width) => {
    const view = render(
      <TestQueryProvider>
        <NodexHoverCardProvider>
          <NodexTooltipProvider>
            <div style={{ width }}>
              <SidebarPaginatedItems
                items={[THREAD, { ...THREAD, key: "second" }, { ...THREAD, key: "third" }]}
                getKey={(item) => item.key}
                maxItems={1}
                extraPages={0}
                onExtraPagesChange={() => undefined}
                pagerClassName={CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS}
              >
                {({ visibleItems }, pager) => (
                  <>
                    {visibleItems.map((item) => (
                      <CodexSidebarThreadRow
                        key={item.key}
                        item={item}
                        linkedPageStore={emptySessionLinkedPageStore}
                        active={false}
                        grouped
                        onSelect={() => undefined}
                      />
                    ))}
                    {pager}
                  </>
                )}
              </SidebarPaginatedItems>
            </div>
          </NodexTooltipProvider>
        </NodexHoverCardProvider>
      </TestQueryProvider>,
    );
    const title = view.container.querySelector("[data-thread-title]");
    if (!title) throw new Error("Expected Session title");
    const range = document.createRange();
    range.selectNodeContents(view.getByRole("button", { name: "Show more" }));
    expect(
      Math.abs(range.getBoundingClientRect().left - title.getBoundingClientRect().left),
    ).toBeLessThan(0.5);
  });
});

describe("sidebar paginated items", () => {
  const ROW_HEIGHT = 30;

  function PagedRows({
    total,
    initialExtraPages = 0,
  }: {
    readonly total: number;
    readonly initialExtraPages?: number;
  }) {
    const [extraPages, setExtraPages] = useState(initialExtraPages);
    const rows = Array.from({ length: total }, (_, index) => `Row ${index + 1}`);
    return (
      <SidebarPaginatedItems
        items={rows}
        getKey={(row) => row}
        maxItems={5}
        extraPages={extraPages}
        onExtraPagesChange={setExtraPages}
      >
        {(pagination, pager) => (
          <div role="list" aria-label="Rows">
            <SidebarPaginatedRows>
              {pagination.visibleItems.map((row) => (
                <div key={row} role="listitem" style={{ height: ROW_HEIGHT }}>
                  {row}
                </div>
              ))}
            </SidebarPaginatedRows>
            {pager}
          </div>
        )}
      </SidebarPaginatedItems>
    );
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  interface Sample {
    readonly height: number;
    readonly rows: number;
    /** Distance from the rows' clipped edge to the top of the pager. */
    readonly pagerGap: number;
    readonly pagerTop: number;
  }

  /** Presses a pager button, then samples each frame until the rows let go of their height. */
  async function press(name: "Show more" | "Show less", view: ReturnType<typeof render>) {
    const clip = view.container.querySelector<HTMLElement>("[data-sidebar-paginated-rows]");
    if (!clip) throw new Error("Expected paginated rows");
    const button = view.getByRole("button", { name });
    const pager = button.parentElement;
    if (!pager) throw new Error("Expected a pager row");
    const pressedAt = pager.getBoundingClientRect().top;
    await act(async () => {
      await userEvent.click(button);
    });
    const samples: Sample[] = [];
    for (let frame = 0; frame < 120 && clip.style.height !== ""; frame += 1) {
      const edge = clip.getBoundingClientRect();
      samples.push({
        height: edge.height,
        rows: view.queryAllByText(/^Row /u).length,
        pagerGap: pager.getBoundingClientRect().top - edge.bottom,
        pagerTop: pager.getBoundingClientRect().top,
      });
      await act(async () => {
        await nextFrame();
      });
    }
    return {
      clip,
      samples,
      pressedAt,
      pagerTop: () => pager.getBoundingClientRect().top,
      height: () => clip.getBoundingClientRect().height,
    };
  }

  const moves = (samples: readonly Sample[], direction: 1 | -1) =>
    samples.every(
      (sample, index) =>
        index === 0 || (sample.height - samples[index - 1]!.height) * direction >= -0.5,
    );

  test("pager presses ease the rows' edge and the pager rides it", async () => {
    const view = render(<PagedRows total={16} />);
    const rowsBox = view.container.querySelector<HTMLElement>("[data-sidebar-paginated-rows]")!;
    const firstPage = rowsBox.getBoundingClientRect().height;

    const more = await press("Show more", view);
    const revealed = more.height();
    expect(revealed - firstPage).toBeCloseTo(5 * ROW_HEIGHT, 0);
    // Every revealed row is mounted from the first frame; the edge unfolds over them.
    expect(more.samples.every((sample) => sample.rows === 10)).toBe(true);
    expect(more.samples.some((s) => s.height > firstPage + 1 && s.height < revealed - 1)).toBe(
      true,
    );
    expect(moves(more.samples, 1)).toBe(true);
    // The pager never leaves the edge, so it stays on screen throughout.
    expect(more.samples.every((sample) => Math.abs(sample.pagerGap) < 0.5)).toBe(true);
    expect(more.clip.style.overflow).toBe("");

    const allRows = (await press("Show more", view)).height();
    const less = await press("Show less", view);
    // One press folds every revealed row back to the first page. The hidden rows stay while
    // the edge folds up past them, then leave.
    const folding = less.samples.filter((s) => s.height > firstPage + 1 && s.height < allRows - 1);
    expect(folding.length).toBeGreaterThan(0);
    expect(folding.every((sample) => sample.rows === 16)).toBe(true);
    expect(moves(less.samples, -1)).toBe(true);
    expect(less.samples.every((sample) => Math.abs(sample.pagerGap) < 0.5)).toBe(true);
    expect(view.getAllByText(/^Row /u)).toHaveLength(5);
    expect(less.height()).toBeCloseTo(firstPage, 0);
    expect(less.clip.style.overflow).toBe("");
  });

  test("Show less keeps the pager where it was pressed when the rows' top has scrolled away", async () => {
    const view = render(
      <div data-testid="sidebar" style={{ height: 300, overflowY: "auto" }}>
        <div style={{ height: 200 }} />
        <PagedRows total={30} initialExtraPages={4} />
        <div style={{ height: 1000 }} />
      </div>,
    );
    const sidebar = view.getByTestId("sidebar");
    const pager = view.getByRole("button", { name: "Show less" }).parentElement!;
    // Scroll the first 25 rows' top out of view, leaving the pager 200px down the sidebar.
    sidebar.scrollTop =
      pager.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - 200;
    const scrolledTo = sidebar.scrollTop;
    await act(async () => {
      await nextFrame();
    });

    const less = await press("Show less", view);
    // The sidebar scrolls back with the fold, so the pager never leaves the pressed spot.
    expect(less.samples.some((sample) => sample.rows === 25)).toBe(true);
    expect(less.samples.every((sample) => Math.abs(sample.pagerTop - less.pressedAt) < 1)).toBe(
      true,
    );
    expect(view.getAllByText(/^Row /u)).toHaveLength(5);
    expect(less.pagerTop()).toBeCloseTo(less.pressedAt, 0);
    expect(scrolledTo - sidebar.scrollTop).toBeCloseTo(20 * ROW_HEIGHT, 0);
  });
});
