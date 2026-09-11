import { act } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { CodexSidebarThreadItem } from "@/lib/types";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { CodexSidebarThreadRow } from "./codex-sidebar";
import { CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS } from "@/lib/codex-sidebar-pagination";
import { SidebarPaginatedItems } from "./sidebar-paginated-items";
import "../../globals.css";

const THREAD: CodexSidebarThreadItem = {
  key: "local:thread-alpha",
  kind: "local",
  backendBinding: { kind: "codex" },
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
              items={[THREAD, { ...THREAD, key: "second" }]}
              getKey={(item) => item.key}
              maxItems={1}
              expanded={false}
              onExpandedChange={() => undefined}
              pagerClassName={CODEX_SIDEBAR_PROJECT_THREAD_PAGER_ROW_CLASS}
            >
              {({ visibleItems }, pager) => (
                <>
                  {visibleItems.map((item) => (
                    <CodexSidebarThreadRow
                      key={item.key}
                      item={item}
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
