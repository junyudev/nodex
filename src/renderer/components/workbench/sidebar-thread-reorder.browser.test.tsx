import { act, fireEvent, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexSidebarThreadItem, Project } from "@/lib/types";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { TestQueryProvider } from "../../test/query";
import { CodexProjectRow, CodexSidebarThreadRow } from "./codex-sidebar";
import {
  SidebarThreadReorderRows,
  SidebarThreadSortableRows,
  SidebarThreadSortableContext,
  SidebarThreadSortableItem,
  resolveSidebarThreadKeysWithPendingDrops,
  usePendingSidebarThreadDrops,
  useReportSidebarThreadCanonicalLanes,
  useSidebarThreadReorderController,
  type SidebarThreadDropRequest,
  type SidebarThreadReorderController,
} from "./sidebar-thread-reorder";
import { SidebarReorderDndProvider } from "./sidebar-reorder-dnd";

const PROJECT: Project = {
  id: "project-beta",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Project beta",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-07-15T00:00:00.000Z"),
  updated: new Date("2026-07-15T00:00:00.000Z"),
};

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
  pinned: false,
  pinnedOrder: null,
  unread: false,
  archived: false,
  statusType: "notLoaded",
  statusActiveFlags: [],
  projectless: false,
  disabled: false,
};

function ThreadReorderHarness({ onCommit }: { onCommit: (nextThreadKeys: string[]) => void }) {
  const [threadKeys, setThreadKeys] = useState(["alpha", "beta"]);
  return (
    <SidebarReorderDndProvider>
      <div
        aria-label="Project chats"
        role="list"
        style={{ display: "flex", flexDirection: "column", width: 240 }}
      >
        <SidebarThreadReorderRows
          containerId="project-pinned:alpha"
          visibleThreadKeys={threadKeys}
          sortableThreadKeys={threadKeys}
          onVisibleThreadOrderChange={async ({ nextVisibleThreadKeys }) => {
            onCommit(nextVisibleThreadKeys);
            setThreadKeys(nextVisibleThreadKeys);
          }}
          renderThread={(threadKey) => (
            <div
              data-thread-key={threadKey}
              data-testid={`thread-${threadKey}`}
              style={{ alignItems: "center", display: "flex", height: 40 }}
            >
              {threadKey}
            </div>
          )}
        />
      </div>
    </SidebarReorderDndProvider>
  );
}

function SessionReorderHarness({ onCommit }: { onCommit: (orderedSessionIds: string[]) => void }) {
  const [threadKeys, setThreadKeys] = useState(["chat", "draft"]);
  const sessionIdByThreadKey = new Map([
    ["chat", "session-chat"],
    ["draft", "session-draft"],
  ]);
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: threadKeys,
    onVisibleThreadOrderChange: async ({ nextVisibleThreadKeys }) => {
      onCommit(
        nextVisibleThreadKeys.flatMap((threadKey) => {
          const sessionId = sessionIdByThreadKey.get(threadKey);
          return sessionId ? [sessionId] : [];
        }),
      );
      setThreadKeys(nextVisibleThreadKeys);
    },
  });
  return (
    <SidebarReorderDndProvider getThreadIdByThreadKey={() => null}>
      <div
        aria-label="Session-first Project chats"
        role="list"
        style={{ display: "flex", flexDirection: "column", width: 240 }}
      >
        <SidebarThreadSortableRows
          containerId="project:alpha"
          getItemId={(threadKey) => sessionIdByThreadKey.get(threadKey)}
          getThreadId={() => null}
          itemIds={threadKeys.flatMap((threadKey) => {
            const sessionId = sessionIdByThreadKey.get(threadKey);
            return sessionId ? [sessionId] : [];
          })}
          visibleThreadKeys={threadKeys}
          sortableThreadKeysInDisplayOrder={reorder.displayedVisibleThreadKeys}
          controller={reorder.controller}
          dropIndicatorTarget={reorder.dropIndicatorTarget}
          renderThread={(threadKey) => (
            <div
              data-thread-key={threadKey}
              data-testid={`session-${threadKey}`}
              style={{ alignItems: "center", display: "flex", height: 40 }}
            >
              {threadKey}
            </div>
          )}
        />
      </div>
    </SidebarReorderDndProvider>
  );
}

function SemanticThreadRows({ threadKeys }: { threadKeys: string[] }) {
  const pendingDrops = usePendingSidebarThreadDrops();
  const canonicalLanes = useMemo(
    () =>
      new Map([
        [
          "project:alpha",
          {
            projectionRevision: 2,
            threadIds: threadKeys.map((threadKey) => `thread-${threadKey}`),
          },
        ],
      ]),
    [threadKeys],
  );
  useReportSidebarThreadCanonicalLanes(canonicalLanes);
  const optimisticThreadKeys = resolveSidebarThreadKeysWithPendingDrops({
    containerId: "project:alpha",
    pendingThreadDrops: pendingDrops,
    threadKeys,
    getThreadId: (threadKey) => `thread-${threadKey}`,
  });
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: threadKeys,
  });
  return (
    <SidebarThreadSortableRows
      containerId="project:alpha"
      getThreadId={(threadKey) => `thread-${threadKey}`}
      visibleThreadKeys={optimisticThreadKeys}
      sortableThreadKeysInDisplayOrder={threadKeys}
      controller={reorder.controller}
      dropIndicatorTarget={reorder.dropIndicatorTarget}
      renderThread={(threadKey) => (
        <div
          data-thread-key={threadKey}
          data-testid={`canonical-thread-${threadKey}`}
          style={{ alignItems: "center", display: "flex", height: 40 }}
        >
          {threadKey}
        </div>
      )}
    />
  );
}

function SemanticThreadReorderHarness({
  beforeCanonicalCommit,
  onDrop,
}: {
  beforeCanonicalCommit?: Promise<void>;
  onDrop: (drop: SidebarThreadDropRequest) => Promise<void>;
}) {
  const [threadKeys, setThreadKeys] = useState(["alpha", "beta"]);
  return (
    <SidebarReorderDndProvider
      getThreadIdByThreadKey={(threadKey) => `thread-${threadKey}`}
      onThreadDrop={async (drop) => {
        await onDrop(drop);
        if (beforeCanonicalCommit) {
          void beforeCanonicalCommit.then(() => setThreadKeys(["beta", "alpha"]));
          return { operationId: "move:alpha", projectionRevision: 2 };
        }
        setThreadKeys(["beta", "alpha"]);
        return { operationId: "move:alpha", projectionRevision: 2 };
      }}
    >
      <div
        aria-label="Canonical Project chats"
        role="list"
        style={{ display: "flex", flexDirection: "column", width: 240 }}
      >
        <SemanticThreadRows threadKeys={threadKeys} />
      </div>
    </SidebarReorderDndProvider>
  );
}

function readRenderedThreadKeys(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll<HTMLElement>("[data-thread-key]"))
    .filter((row) => row.closest("[role='list']") === list)
    .map((row) => row.dataset.threadKey ?? "");
}

describe("sidebar thread reorder in Chromium", () => {
  test("reorders a persisted pre-thread New Chat by Session identity", async () => {
    const committedSessionOrders: string[][] = [];
    const view = render(
      <SessionReorderHarness
        onCommit={(orderedSessionIds) => committedSessionOrders.push(orderedSessionIds)}
      />,
    );
    const list = view.getByRole("list", { name: "Session-first Project chats" });
    const draft = view.getByTestId("session-draft");
    const chat = view.getByTestId("session-chat");
    const draftRect = draft.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const pointerId = 6;
    const pointerX = chatRect.left + chatRect.width / 2;

    try {
      await act(async () => {
        fireEvent.pointerDown(draft, {
          button: 0,
          clientX: draftRect.left + draftRect.width / 2,
          clientY: draftRect.top + draftRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: draftRect.top - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: chatRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: chatRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(committedSessionOrders).toEqual([["session-draft", "session-chat"]]);
        expect(readRenderedThreadKeys(list)).toEqual(["draft", "chat"]);
      });
    } finally {
      view.unmount();
    }
  });

  test("keeps the visible insertion intent current while moving across one row midpoint", async () => {
    const committedOrders: string[][] = [];
    const view = render(
      <ThreadReorderHarness onCommit={(nextThreadKeys) => committedOrders.push(nextThreadKeys)} />,
    );
    const list = view.getByRole("list", { name: "Project chats" });
    const beta = view.getByTestId("thread-beta");
    const alpha = view.getByTestId("thread-alpha");
    const betaRect = beta.getBoundingClientRect();
    const alphaRect = alpha.getBoundingClientRect();
    const pointerId = 7;
    const pointerX = alphaRect.left + alphaRect.width / 2;

    try {
      await act(async () => {
        fireEvent.pointerDown(beta, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: alphaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.children).toHaveLength(3);
      });

      await act(async () => {
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: alphaRect.bottom - 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.children).toHaveLength(2);
      });
      expect(committedOrders).toHaveLength(0);
    } finally {
      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: alphaRect.bottom - 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      view.unmount();
    }
  });

  test("commits the changed order without replaying a source-to-target transition", async () => {
    const committedOrders: string[][] = [];
    const errors: ErrorEvent[] = [];
    const consoleErrors: unknown[][] = [];
    const handleError = (event: ErrorEvent) => errors.push(event);
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args);
    });
    window.addEventListener("error", handleError);

    const view = render(
      <ThreadReorderHarness onCommit={(nextThreadKeys) => committedOrders.push(nextThreadKeys)} />,
    );
    const list = view.getByRole("list", { name: "Project chats" });
    const beta = view.getByTestId("thread-beta");
    const alpha = view.getByTestId("thread-alpha");
    const betaRect = beta.getBoundingClientRect();
    const alphaRect = alpha.getBoundingClientRect();
    const pointerId = 8;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    const dropY = alphaRect.top + 4;
    const sourceSortableRow = beta.closest<HTMLElement>("[role='listitem']");
    const postDropStyleMutations: string[] = [];
    const styleObserver = new MutationObserver((records) => {
      for (const record of records) {
        postDropStyleMutations.push(record.oldValue ?? "");
        postDropStyleMutations.push((record.target as HTMLElement).getAttribute("style") ?? "");
      }
    });

    try {
      await act(async () => {
        fireEvent.pointerDown(beta, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.children).toHaveLength(3);
      });
      expect(sourceSortableRow).not.toBeNull();
      styleObserver.observe(sourceSortableRow!, {
        attributeFilter: ["style"],
        attributeOldValue: true,
        attributes: true,
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(committedOrders).toEqual([["beta", "alpha"]]);
        expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
      });
      const movedRow = view.getByTestId("thread-beta").closest<HTMLElement>("[role='listitem']");
      expect(movedRow).not.toBeNull();
      expect(movedRow).toBe(sourceSortableRow);
      expect(postDropStyleMutations).toEqual([]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(movedRow?.getAnimations()).toHaveLength(0);
      expect(getComputedStyle(movedRow!).transform).toBe("none");
      expect(errors).toHaveLength(0);
      expect(consoleErrors).toHaveLength(0);
    } finally {
      styleObserver.disconnect();
      window.removeEventListener("error", handleError);
      consoleError.mockRestore();
      view.unmount();
    }
  });

  test("keeps a regular same-lane drop optimistic until canonical settlement without shifting geometry", async () => {
    let resolveCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    let resolveCanonicalCommit!: () => void;
    const canonicalCommit = new Promise<void>((resolve) => {
      resolveCanonicalCommit = resolve;
    });
    const drops: SidebarThreadDropRequest[] = [];
    const view = render(
      <SemanticThreadReorderHarness
        beforeCanonicalCommit={canonicalCommit}
        onDrop={async (drop) => {
          drops.push(drop);
          await commit;
        }}
      />,
    );
    const list = view.getByRole("list", { name: "Canonical Project chats" });
    const beta = view.getByTestId("canonical-thread-beta");
    const alpha = view.getByTestId("canonical-thread-alpha");
    const betaRect = beta.getBoundingClientRect();
    const alphaRect = alpha.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const pointerId = 9;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    const dropY = alphaRect.top + 4;
    let pointerReleased = false;

    try {
      await act(async () => {
        fireEvent.pointerDown(beta, {
          button: 0,
          clientX: betaRect.left + betaRect.width / 2,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(list.querySelector("[role='presentation']")).not.toBeNull();
      });
      expect(list.getBoundingClientRect().height).toBe(listRect.height);
      expect(alpha.getBoundingClientRect().top).toBe(alphaRect.top);

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        pointerReleased = true;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(drops).toEqual([
          {
            beforeThreadId: "thread-alpha",
            sourceContainerId: "project:alpha",
            targetContainerId: "project:alpha",
            threadId: "thread-beta",
          },
        ]);
        expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);

      await act(async () => {
        resolveCommit();
        await commit;
        await Promise.resolve();
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);

      await act(async () => {
        resolveCanonicalCommit();
        await canonicalCommit;
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(readRenderedThreadKeys(list)).toEqual(["beta", "alpha"]);
      });
    } finally {
      if (!pointerReleased) {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: dropY,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
      }
      resolveCommit();
      resolveCanonicalCommit();
      view.unmount();
    }
  });

  test("returns a regular chat to its original slot without submitting a move", async () => {
    const drops: SidebarThreadDropRequest[] = [];
    const consoleErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args);
    });
    const view = render(
      <SemanticThreadReorderHarness
        onDrop={async (drop) => {
          drops.push(drop);
        }}
      />,
    );
    const list = view.getByRole("list", { name: "Canonical Project chats" });
    const beta = view.getByTestId("canonical-thread-beta");
    const alpha = view.getByTestId("canonical-thread-alpha");
    const betaRect = beta.getBoundingClientRect();
    const alphaRect = alpha.getBoundingClientRect();
    const pointerId = 10;
    const pointerX = alphaRect.left + alphaRect.width / 2;
    let pointerReleased = false;

    try {
      await act(async () => {
        fireEvent.pointerDown(beta, {
          button: 0,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + betaRect.height / 2 - 8,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: alphaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(list.querySelector("[role='presentation']")).not.toBeNull();
      });

      await act(async () => {
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: pointerX,
          clientY: betaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(list.querySelector("[role='presentation']")).toBeNull();
      });

      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: betaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
        pointerReleased = true;
        await Promise.resolve();
      });

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(drops).toEqual([]);
      expect(readRenderedThreadKeys(list)).toEqual(["alpha", "beta"]);
      expect(consoleErrors).toEqual([]);
    } finally {
      if (!pointerReleased) {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: pointerX,
          clientY: betaRect.top + 4,
          isPrimary: true,
          pointerId,
          pointerType: "mouse",
        });
      }
      consoleError.mockRestore();
      view.unmount();
    }
  });

  test("starts a drag from an open rich tooltip without replacing the sortable host", async () => {
    const errors: ErrorEvent[] = [];
    const controller: SidebarThreadReorderController = {
      handleDragEnd() {},
    };
    const handleError = (event: ErrorEvent) => {
      errors.push(event);
    };
    window.addEventListener("error", handleError);

    const view = render(
      <TestQueryProvider>
        <NodexHoverCardProvider>
          <NodexTooltipProvider>
            <SidebarReorderDndProvider>
              <SidebarThreadSortableContext threadKeys={[THREAD.key]}>
                <div role="list" aria-label="Source project chats">
                  <SidebarThreadSortableItem
                    containerId="project:project-alpha"
                    controller={controller}
                    threadId={THREAD.threadId}
                    threadKey={THREAD.key}
                  >
                    <CodexSidebarThreadRow
                      item={THREAD}
                      active={false}
                      hoverCardBranchName="codex/stable-ref"
                      hoverCardProjectLabel="Project alpha"
                      onSelect={() => {}}
                    />
                  </SidebarThreadSortableItem>
                </div>
              </SidebarThreadSortableContext>
              <div role="list" aria-label="Destination projects">
                <CodexProjectRow
                  project={PROJECT}
                  active={false}
                  expanded={false}
                  onActivate={() => {}}
                  onUpdateProject={async () => PROJECT}
                  onArchiveProject={async () => ({ kind: "not-found" })}
                />
              </div>
            </SidebarReorderDndProvider>
          </NodexTooltipProvider>
        </NodexHoverCardProvider>
      </TestQueryProvider>,
    );

    try {
      const row = view.container.querySelector<HTMLElement>("[data-app-action-sidebar-thread-row]");
      const sortableHost = row?.closest<HTMLElement>(
        "[aria-roledescription='sortable']",
      )?.parentElement;
      if (!row || !sortableHost) {
        throw new TypeError("Expected a mounted sortable thread row");
      }

      await act(async () => {
        fireEvent.mouseEnter(row, {
          clientX: 20,
          clientY: 20,
        });
      });
      await waitFor(() => {
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.pointerDown(row, {
          button: 0,
          clientX: 20,
          clientY: 20,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(document, {
          buttons: 1,
          clientX: 20,
          clientY: 40,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(sortableHost.hasAttribute("inert")).toBe(true);
      });
      expect(sortableHost.isConnected).toBe(true);
      expect(errors).toHaveLength(0);
    } finally {
      await act(async () => {
        fireEvent.pointerUp(document, {
          button: 0,
          clientX: 20,
          clientY: 40,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        });
        await Promise.resolve();
      });
      window.removeEventListener("error", handleError);
      view.unmount();
    }
  });
});
