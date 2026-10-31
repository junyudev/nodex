import { describe, expect, test } from "vite-plus/test";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, textContent } from "@/test/dom";
import type { CodexSidebarThreadItem } from "@/lib/types";
import { CodexSidebarSection, CodexSidebarThreadRow } from "./codex-sidebar";
import { createAgentRuntimeActivityStore } from "@/lib/agent-runtime-session-activity";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type { SessionLinkedPage, SessionLinkedPageStore } from "@/lib/session-linked-page";
import type {
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
} from "../../../shared/agent-runtime-api";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;

function makeThreadItem(overrides: Partial<CodexSidebarThreadItem> = {}): CodexSidebarThreadItem {
  return {
    key: "local:test-thread",
    kind: "local",
    backendBinding: { kind: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId: "thread-test",
    parentThreadId: null,
    sessionId: "session-test",
    projectId: "nodex",
    title: "X Plan Codex terminal reverse engineer",
    preview: "",
    cwd: "/Users/asc/repo/nodex",
    updatedAt: Date.now() - TWO_DAYS_MS,
    recencyAt: Date.now() - TWO_DAYS_MS,
    createdAt: Date.now() - TWO_DAYS_MS,
    pinned: false,
    pinnedOrder: null,
    unread: false,
    archived: false,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: false,
    disabled: false,
    ...overrides,
  };
}

function OpenThreadHoverCard({
  item,
  projectLabel,
  branchName,
}: {
  item: CodexSidebarThreadItem;
  projectLabel?: string | null;
  branchName?: string | null;
}) {
  return (
    <NodexHoverCardProvider>
      <NodexTooltipProvider>
        <CodexSidebarThreadRow
          item={item}
          active={false}
          hoverCardOpen
          hoverCardProjectLabel={projectLabel}
          hoverCardBranchName={branchName}
          onSelect={() => {}}
        />
      </NodexTooltipProvider>
    </NodexHoverCardProvider>
  );
}

function renderOpenThreadHoverCard(
  item: CodexSidebarThreadItem,
  props: {
    projectLabel?: string | null;
    branchName?: string | null;
  } = {},
) {
  return render(
    <OpenThreadHoverCard
      item={item}
      projectLabel={props.projectLabel}
      branchName={props.branchName}
    />,
  );
}

describe("codex sidebar thread hover card", () => {
  test("renders title, relative age, project label, and branch metadata", async () => {
    await act(async () => {
      renderOpenThreadHoverCard(makeThreadItem(), {
        projectLabel: "nodex",
        branchName: "feat/thread-tools",
      });
    });

    const hoverCard = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(hoverCard).not.toBeNull();

    const hoverCardText = textContent(hoverCard as HTMLElement);
    expect(hoverCardText.includes("X Plan Codex terminal reverse engineer")).toBe(true);
    expect(hoverCardText.includes("2d")).toBe(true);
    expect(hoverCardText.includes("nodex")).toBe(true);
    expect(hoverCardText.includes("feat/thread-tools")).toBe(true);
  });

  test("marks an unread chat beside its age", async () => {
    await act(async () => {
      renderOpenThreadHoverCard(makeThreadItem({ unread: true }));
    });

    const hoverCard = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const age = hoverCard.querySelector("time")!;
    const dot = hoverCard.querySelector("[data-app-action-sidebar-thread-hover-card-unread]");
    expect(dot).not.toBeNull();
    expect(dot?.parentElement).toBe(age.parentElement);
  });

  test("uses Chat as the projectless fallback label", async () => {
    await act(async () => {
      renderOpenThreadHoverCard(
        makeThreadItem({
          key: "local:projectless",
          threadId: "thread-projectless",
          sessionId: "session-projectless",
          projectId: null,
          cwd: null,
          projectless: true,
          title: "Projectless chat",
        }),
      );
    });

    const hoverCard = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(hoverCard).not.toBeNull();

    const hoverCardText = textContent(hoverCard as HTMLElement);
    expect(hoverCardText.includes("Projectless chat")).toBe(true);
    expect(hoverCardText.includes("Chat")).toBe(true);
  });

  test("does not present Session metadata time as draft conversation age", async () => {
    await act(async () => {
      renderOpenThreadHoverCard(
        makeThreadItem({
          threadId: "session-draft",
          updatedAt: Date.now(),
          recencyAt: null,
          title: "New thread",
        }),
      );
    });

    const hoverCard = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(hoverCard).not.toBeNull();
    expect(hoverCard?.querySelector("time")).toBeNull();
  });

  test("updates an open hover card when a fresh recency snapshot arrives", async () => {
    const staleItem = makeThreadItem({
      recencyAt: Date.now() - 7 * 60 * 60 * 1_000,
    });
    let view!: ReturnType<typeof renderOpenThreadHoverCard>;
    await act(async () => {
      view = renderOpenThreadHoverCard(staleItem);
    });
    expect(textContent(document.body.querySelector('[role="dialog"]') as HTMLElement)).toContain(
      "7h",
    );

    await act(async () => {
      view.rerender(<OpenThreadHoverCard item={{ ...staleItem, recencyAt: Date.now() }} />);
      await Promise.resolve();
    });

    expect(textContent(document.body.querySelector('[role="dialog"]') as HTMLElement)).toContain(
      "now",
    );
  });

  test("renders remote host, branch, and managed worktree as separate metadata", async () => {
    await act(async () => {
      renderOpenThreadHoverCard(
        makeThreadItem({
          kind: "remote",
          hostId: "build-host",
          runLocation: {
            kind: "remote-worktree",
            hostId: "build-host",
            hostDisplayName: "Build workstation",
            path: "/srv/.codex/worktrees/91a6/nodex",
            phase: "ready",
          },
        }),
        {
          projectLabel: "Nodex",
          branchName: "feat/worktree-sidebar",
        },
      );
    });

    const hoverCard = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(hoverCard).not.toBeNull();
    const metadataRows = [
      ...(hoverCard as HTMLElement).querySelectorAll(
        "[data-app-action-sidebar-thread-hover-card-metadata]",
      ),
    ]
      .map((row) => textContent(row).trim())
      .filter(Boolean);
    expect(metadataRows).toEqual(
      expect.arrayContaining(["Nodex", "Build workstation", "feat/worktree-sidebar", "nodex"]),
    );
  });
});

describe("codex sidebar thread row", () => {
  test("shows a Runtime chat's live status and location from its execution owner", async () => {
    const listeners = new Set<(change: AgentRuntimeSessionActivityChange) => void>();
    const store = createAgentRuntimeActivityStore({
      read: async () => ({ sequence: 0, items: [], complete: true }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      // An idle Runtime is never started by a passive row read.
      readConnection: async () => ({ status: "idle" }),
      subscribeConnection: () => () => {},
    });
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.threadExecution.location("root-1"), {
      hostId: "local",
      cwd: "/managed/feature/app",
      managedWorktreePath: "/managed/feature",
    });
    const activity = (
      status: AgentRuntimeSessionActivity["status"],
    ): AgentRuntimeSessionActivity => ({
      sessionId: "session-test",
      threadId: "root-1",
      status,
      activeRunId: status === "running" ? "run-1" : null,
      pendingRequestCount: status === "waiting" ? 1 : 0,
      backgroundTasks: [],
      providerInstanceId: "claude",
      model: "claude-sonnet",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <TestQueryProvider client={client}>
          <NodexTooltipProvider>
            <CodexSidebarThreadRow
              item={makeThreadItem({ statusType: "notLoaded", cwd: null })}
              runtime={{ sessionId: "session-test", rootThreadId: "root-1" }}
              activityStore={store}
              active={false}
              onSelect={() => {}}
            />
          </NodexTooltipProvider>
        </TestQueryProvider>,
      );
    });
    const row = () =>
      view.container.querySelector<HTMLElement>("[data-app-action-sidebar-thread-row]")!;
    expect(
      view.container.querySelector("[data-app-action-sidebar-thread-worktree-icon]"),
    ).not.toBeNull();
    expect(row().dataset.appActionSidebarThreadRunning).toBe("false");

    const push = async (change: AgentRuntimeSessionActivityChange) => {
      await act(async () => {
        for (const listener of listeners) listener(change);
        await Promise.resolve();
      });
    };
    await push({ type: "upsert", sequence: 1, activity: activity("running") });
    await waitFor(() => expect(row().dataset.appActionSidebarThreadRunning).toBe("true"));
    await push({ type: "upsert", sequence: 2, activity: activity("background") });
    await waitFor(() =>
      expect(view.getByRole("img", { name: "Working in background" })).not.toBeNull(),
    );
    expect(row().dataset.appActionSidebarThreadRunning).toBe("false");
    await push({ type: "upsert", sequence: 3, activity: activity("waiting") });
    const describedRow = () =>
      view.queryByRole("button", {
        name: "X Plan Codex terminal reverse engineer",
        description: "Needs attention",
      });
    await waitFor(() =>
      expect(
        row().querySelector("[data-app-action-sidebar-thread-status='attention']"),
      ).not.toBeNull(),
    );
    expect(describedRow()).not.toBeNull();
    await push({ type: "remove", sequence: 4, sessionId: "session-test" });
    await waitFor(() =>
      expect(row().querySelector("[data-app-action-sidebar-thread-status]")).toBeNull(),
    );
    expect(describedRow()).toBeNull();
  });

  test("shows the worktree glyph without changing the row accessible name", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({
              updatedAt: Number.NaN,
              runLocation: {
                kind: "local-worktree",
                path: "/Users/asc/.codex/worktrees/91a6/nodex",
                phase: "ready",
              },
            })}
            active={false}
            onSelect={() => {}}
          />
        </NodexTooltipProvider>,
      );
    });

    expect(
      view.getByRole("button", { name: "X Plan Codex terminal reverse engineer" }),
    ).not.toBeNull();
    const icon = view.container.querySelector("[data-app-action-sidebar-thread-worktree-icon]");
    expect(icon).not.toBeNull();
    expect((icon as HTMLElement).dataset.phase).toBe("ready");

    fireEvent.pointerMove(icon as Element, { pointerType: "mouse" });
    fireEvent.mouseEnter(icon as Element);
    await waitFor(() => {
      expect(view.getByRole("tooltip").textContent).toBe(
        "This conversation is running in a local git worktree.",
      );
    });
  });

  test("marks pending and remote worktree identities without adding row text", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({
              kind: "remote",
              hostId: "build-host",
              updatedAt: Number.NaN,
              runLocation: {
                kind: "remote-worktree",
                hostId: "build-host",
                path: null,
                phase: "pending",
              },
            })}
            active={false}
            onSelect={() => {}}
          />
        </NodexTooltipProvider>,
      );
    });

    const location = view.container.querySelector(
      '[data-app-action-sidebar-thread-run-location="remote-worktree"]',
    );
    expect(location).not.toBeNull();
    expect(location?.querySelectorAll("svg")).toHaveLength(2);
    expect((location?.querySelector("[data-phase]") as HTMLElement | null)?.dataset.phase).toBe(
      "pending",
    );
    expect(
      view.getByRole("button", { name: "X Plan Codex terminal reverse engineer" }),
    ).not.toBeNull();
  });

  test("puts a nested row's unread dot after its title and keeps hover pinning", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({ unread: true })}
            grouped
            active={false}
            onSelect={() => {}}
            onArchive={() => {}}
            onTogglePinned={() => {}}
          />
        </NodexTooltipProvider>,
      );
    });

    const row = view.getByRole("button", {
      name: "X Plan Codex terminal reverse engineer",
      description: "Unread",
    });
    const main = row.querySelector("[data-app-action-sidebar-thread-main]")!;
    const title = main.querySelector("[data-thread-title]")!;
    const status = row.querySelector("[data-app-action-sidebar-thread-status='unread']");
    expect(status).not.toBeNull();
    expect(main.contains(status)).toBe(true);
    expect(title.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(
      row.querySelector(
        "[data-app-action-sidebar-thread-action-rail] [data-app-action-sidebar-thread-pin-session]",
      ),
    ).not.toBeNull();
  });

  test("shows only the spinner while an unread chat is still running", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({ unread: true, statusType: "active" })}
            active={false}
            onSelect={() => {}}
          />
        </NodexTooltipProvider>,
      );
    });

    const row = view.getByRole("button", {
      name: "X Plan Codex terminal reverse engineer",
      description: "Unread",
    });
    const statuses = row.querySelectorAll("[data-app-action-sidebar-thread-status]");
    expect(
      Array.from(statuses, (status) =>
        status.getAttribute("data-app-action-sidebar-thread-status"),
      ),
    ).toEqual(["running"]);
  });

  test("renders the running indicator without row time metadata", async () => {
    let container!: HTMLElement;

    await act(async () => {
      ({ container } = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({ statusType: "active" })}
            active={false}
            onSelect={() => {}}
          />
        </NodexTooltipProvider>,
      ));
    });

    const row = container.querySelector(
      "[data-app-action-sidebar-thread-row]",
    ) as HTMLElement | null;
    expect(row?.dataset.appActionSidebarThreadRunning).toBe("true");
    expect(row?.querySelector("[data-app-action-sidebar-thread-status='running']")).not.toBeNull();
    expect(row?.querySelector("[data-app-action-sidebar-thread-elapsed]")).toBeNull();
  });

  test("keeps relative age out of an idle thread row", async () => {
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({ updatedAt: Date.now() - TWO_DAYS_MS - 60_000 })}
            active={false}
            onSelect={() => {}}
          />
        </NodexTooltipProvider>,
      );
    });

    expect(view.queryByText("2d")).toBeNull();
    expect(
      view.getByRole("button", { name: "X Plan Codex terminal reverse engineer" }),
    ).not.toBeNull();
  });

  test("keeps hover actions out of the main title content flow", async () => {
    let container!: HTMLElement;

    await act(async () => {
      ({ container } = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem()}
            active={false}
            onSelect={() => {}}
            onArchive={() => {}}
            onTogglePinned={() => {}}
          />
        </NodexTooltipProvider>,
      ));
    });

    const row = container.querySelector(
      "[data-app-action-sidebar-thread-row]",
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    const main = (row as HTMLElement).querySelector(
      "[data-app-action-sidebar-thread-main]",
    ) as HTMLElement | null;
    const actionRail = (row as HTMLElement).querySelector(
      "[data-app-action-sidebar-thread-action-rail]",
    ) as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(actionRail).not.toBeNull();

    expect(
      (main as HTMLElement).querySelector("[data-app-action-sidebar-thread-pin-session]") === null,
    ).toBe(true);
    expect(
      (main as HTMLElement).querySelector("[data-app-action-sidebar-thread-archive]") === null,
    ).toBe(true);
    expect(
      (actionRail as HTMLElement).querySelector("[data-app-action-sidebar-thread-pin-session]") !==
        null,
    ).toBe(true);
    expect(
      (actionRail as HTMLElement).querySelector("[data-app-action-sidebar-thread-archive]") !==
        null,
    ).toBe(true);
  });

  test("keeps the pinned state visible while archive stays in the action rail", async () => {
    let container!: HTMLElement;

    await act(async () => {
      ({ container } = render(
        <NodexTooltipProvider>
          <CodexSidebarThreadRow
            item={makeThreadItem({ pinned: true })}
            active={false}
            onSelect={() => {}}
            onArchive={() => {}}
            onTogglePinned={() => {}}
          />
        </NodexTooltipProvider>,
      ));
    });

    const row = container.querySelector(
      "[data-app-action-sidebar-thread-row]",
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    const main = (row as HTMLElement).querySelector(
      "[data-app-action-sidebar-thread-main]",
    ) as HTMLElement | null;
    const actionRail = (row as HTMLElement).querySelector(
      "[data-app-action-sidebar-thread-action-rail]",
    ) as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(actionRail).not.toBeNull();

    const restingPin = (main as HTMLElement).querySelector(
      "[data-app-action-sidebar-thread-resting-pin]",
    ) as HTMLButtonElement | null;
    expect(restingPin).not.toBeNull();
    expect(restingPin?.getAttribute("aria-label")).toBe("Unpin chat");
    expect(
      (main as HTMLElement).querySelector("[data-app-action-sidebar-thread-archive]") === null,
    ).toBe(true);
    expect(
      (actionRail as HTMLElement).querySelector("[data-app-action-sidebar-thread-pin-session]") ===
        null,
    ).toBe(true);
    expect(
      (actionRail as HTMLElement).querySelector("[data-app-action-sidebar-thread-archive]") !==
        null,
    ).toBe(true);
  });
});

describe("codex sidebar section", () => {
  test("summarizes chats at the header's end only while collapsed", async () => {
    const section = (collapsed: boolean) => (
      <CodexSidebarSection
        heading="Focus"
        collapsed={collapsed}
        onToggle={() => {}}
        status={<span data-testid="section-status" />}
      >
        <div />
      </CodexSidebarSection>
    );
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(section(false));
    });
    expect(view.queryByTestId("section-status")).toBeNull();

    await act(async () => {
      view.rerender(section(true));
    });
    const toggle = view.getByRole("button", { name: "Focus" });
    const status = view.getByTestId("section-status");
    expect(toggle.contains(status)).toBe(false);
    expect(toggle.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

describe("codex sidebar linked Page status", () => {
  const buildPage: SessionLinkedPage = {
    pageId: "page-build",
    pageKey: "LAB-13",
    title: "Tighten sidebar spacing",
    status: { optionId: "build", label: "Build" },
  };
  const linkedPageStore = (page: SessionLinkedPage | null): SessionLinkedPageStore => ({
    read: (sessionId) => (sessionId === "session-test" ? page : null),
    subscribeSession: () => () => {},
  });

  async function renderLinkedRow(input: {
    item?: Partial<CodexSidebarThreadItem>;
    page?: SessionLinkedPage | null;
    hoverCardOpen?: boolean;
    onSelect?: () => void;
    onOpenLinkedPage?: (page: SessionLinkedPage) => void;
  }) {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <NodexHoverCardProvider>
          <NodexTooltipProvider>
            <CodexSidebarThreadRow
              item={makeThreadItem(input.item)}
              linkedPageStore={linkedPageStore(input.page === undefined ? buildPage : input.page)}
              active={false}
              hoverCardOpen={input.hoverCardOpen}
              onSelect={input.onSelect ?? (() => {})}
              onOpenLinkedPage={input.onOpenLinkedPage}
            />
          </NodexTooltipProvider>
        </NodexHoverCardProvider>,
      );
    });
    return view;
  }

  test("rests a settled chat on its earliest linked Page's Status", async () => {
    const view = await renderLinkedRow({});
    const slot = view.container.querySelector<HTMLElement>(
      "[data-app-action-sidebar-thread-page-status]",
    );
    expect(slot?.dataset.appActionSidebarThreadPageStatus).toBe("build");
    expect(view.getByRole("img", { name: "Page status: Build" })).not.toBeNull();
    expect(
      view.getByRole("button", {
        name: "X Plan Codex terminal reverse engineer",
        description: "Page status: Build",
      }),
    ).not.toBeNull();
  });

  test("gives the slot to unread and live chat states", async () => {
    const unread = await renderLinkedRow({ item: { unread: true } });
    expect(
      unread.container.querySelector("[data-app-action-sidebar-thread-status='unread']"),
    ).not.toBeNull();
    expect(
      unread.container.querySelector("[data-app-action-sidebar-thread-page-status]"),
    ).toBeNull();
    unread.unmount();

    const running = await renderLinkedRow({ item: { statusType: "active" } });
    expect(
      running.container.querySelector("[data-app-action-sidebar-thread-status='running']"),
    ).not.toBeNull();
    expect(
      running.container.querySelector("[data-app-action-sidebar-thread-page-status]"),
    ).toBeNull();
  });

  test("leaves the slot empty without a live linked Page or its Status", async () => {
    const none = await renderLinkedRow({ page: null });
    expect(none.container.querySelector("[data-app-action-sidebar-thread-page-status]")).toBeNull();
    none.unmount();

    const statusless = await renderLinkedRow({ page: { ...buildPage, status: null } });
    expect(
      statusless.container.querySelector("[data-app-action-sidebar-thread-page-status]"),
    ).toBeNull();
  });

  test("opens the linked Page from the hover card without selecting the row", async () => {
    const opened: SessionLinkedPage[] = [];
    let selected = 0;
    await renderLinkedRow({
      hoverCardOpen: true,
      onSelect: () => {
        selected += 1;
      },
      onOpenLinkedPage: (page) => {
        opened.push(page);
      },
    });
    const hoverCard = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const linkedPage = hoverCard.querySelector<HTMLButtonElement>(
      `button[data-app-action-sidebar-thread-hover-card-linked-page="${buildPage.pageId}"]`,
    )!;
    expect(textContent(linkedPage)).toContain("LAB-13");
    expect(textContent(linkedPage)).toContain(buildPage.title);
    await act(async () => {
      fireEvent.click(linkedPage);
      await Promise.resolve();
    });
    expect(opened).toEqual([buildPage]);
    expect(selected).toBe(0);
  });
});
