import { describe, expect, test } from "vite-plus/test";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { NodexHoverCardProvider } from "@/components/ui/hover-card";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, textContent } from "@/test/dom";
import type { CodexSidebarThreadItem } from "@/lib/types";
import { CodexSidebarThreadRow } from "./codex-sidebar";

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
    expect(row?.querySelector("[data-app-action-sidebar-thread-running-indicator]")).not.toBeNull();
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
