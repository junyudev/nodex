import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import {
  __resetNodexToastStoreForTests,
  NodexToastProvider,
} from "../../../../components/ui/toast";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import {
  installAsyncRequestAnimationFrame,
  installWindowApi,
} from "../../../../test/browser-globals";
import { renderWithMaitai as render } from "../../../../test/thread-maitai";
import { settleAsyncRender } from "../../../../test/dom";
import type { CodexTranscriptEntry } from "../../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type { GitWorkerQueryClient } from "@/features/review/data/git-query";
import {
  TurnDiffInProgressInlineSummary,
  TurnDiffSurface,
  turnDiffSurfaceTestHelpers,
} from "./turn-diff-surface";

function diffForPath(path: string, oldText = "old", newText = "new"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${oldText}`,
    `+${newText}`,
  ].join("\n");
}

function multiFileDiff(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return diffForPath(`src/file-${number}.ts`, `old-${number}`, `new-${number}`);
  }).join("\n");
}

function buildTurnDiffEntry(input?: {
  unifiedDiff?: string;
  rawItem?: Record<string, unknown>;
  entry?: Partial<CodexTranscriptEntry>;
}): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "turn-diff-1",
    entryId: "turn-diff-1",
    type: "turn_diff",
    kind: "systemEvent",
    semanticKind: "diff",
    status: "completed",
    rawItem: {
      type: "turn-diff",
      cwd: "/tmp/project",
      unifiedDiff: input?.unifiedDiff ?? multiFileDiff(2),
      ...input?.rawItem,
    },
    createdAt: 1,
    updatedAt: 1,
    ...input?.entry,
  };
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function createApplyPatchTestClient(
  apply: (params: unknown) => Promise<unknown> | unknown,
): Pick<GitWorkerQueryClient, "request"> {
  return {
    request: async (input) => {
      if (input.method !== "apply-patch") {
        throw new Error(`Unexpected Git worker method: ${input.method}`);
      }
      return (await apply(input.params)) as never;
    },
  };
}

describe("TurnDiffSurface", () => {
  beforeEach(() => {
    installAsyncRequestAnimationFrame();
    __resetNodexToastStoreForTests();
    installWindowApi({
      invoke: async () => true,
      on: () => () => {},
    });
  });

  test("renders the completed edited-files card collapsed to three rows", () => {
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(12) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.textContent?.includes("Edited 12 files"))).toBe(true);
    expect(Boolean(container.textContent?.includes("+12"))).toBe(true);
    expect(Boolean(container.textContent?.includes("-12"))).toBe(true);
    expect(Boolean(container.textContent?.includes("src/file-1.ts"))).toBe(true);
    expect(Boolean(container.textContent?.includes("src/file-3.ts"))).toBe(true);
    expect(Boolean(container.textContent?.includes("src/file-4.ts"))).toBe(false);
    expect(Boolean(container.textContent?.includes("Show 9 more files"))).toBe(true);
    expect(Boolean(container.querySelector('button[aria-label="Review changed files"]'))).toBe(
      true,
    );
  });

  test("does not render a dead Review CTA when no opener route is available", () => {
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(1) })}
          isInProgress={false}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    expect(container.querySelector('button[aria-label="Review changed files"]')).toBe(null);
    expect(container.textContent?.includes("Review changes")).toBe(false);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("defers only fixed-height completed file rows when offscreen rendering is enabled", () => {
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(4) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          deferOffscreenRendering
        />
      </TooltipProvider>,
    );

    const deferredRows = container.querySelectorAll(".thread-diff-virtualized");
    expect(deferredRows.length).toBe(3);
    expect(
      Array.from(deferredRows).every(
        (row) => row.querySelector<HTMLElement>(".h-9")?.classList.contains("h-9") === true,
      ),
    ).toBe(true);
    expect(container.firstElementChild?.classList.contains("thread-diff-virtualized")).toBe(false);
  });

  test("expands and collapses the file list disclosure without per-file accordions", async () => {
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(5) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
        />
      </TooltipProvider>,
    );

    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(Boolean(disclosure)).toBe(true);
    fireEvent.click(disclosure as HTMLButtonElement);
    await settleAsyncRender();

    expect(Boolean(container.textContent?.includes("src/file-5.ts"))).toBe(true);
    expect(Boolean(container.textContent?.includes("Collapse files"))).toBe(true);
    expect(container.querySelectorAll('button[aria-expanded="true"]').length).toBe(1);

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-expanded="true"]',
      ) as HTMLButtonElement,
    );
    await settleAsyncRender();
    expect(Boolean(container.textContent?.includes("src/file-5.ts"))).toBe(false);
  });

  test("opens Review from header and focuses a file from row click", () => {
    const openedTargets: ReviewOpenIntent[] = [];
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(3) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          reviewSource="selected-turn"
          onOpenReview={(target) => {
            openedTargets.push(target);
          }}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Review changed files"]',
      ) as HTMLButtonElement,
    );
    expect(openedTargets[0]?.source.kind).toBe("selected-turn");
    expect(openedTargets[0]?.targetPath ?? null).toBe(null);

    fireEvent.click(findButtonByText(container, "src/file-2.ts") as HTMLButtonElement);
    expect(openedTargets[1]?.targetPath ?? null).toBe("src/file-2.ts");
  });

  test("cmd-click file rows opens the side panel instead of Review", () => {
    let reviewOpenCount = 0;
    let sidePanelTarget: { path: string; workspaceRoot?: string | null } | null = null;
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(3) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => {
            reviewOpenCount += 1;
          }}
          onOpenFileInSidePanel={(target) => {
            sidePanelTarget = target;
          }}
        />
      </TooltipProvider>,
    );

    fireEvent.click(findButtonByText(container, "src/file-1.ts") as HTMLButtonElement, {
      metaKey: true,
    });
    expect(reviewOpenCount).toBe(0);
    expect(sidePanelTarget).toMatchObject({
      path: "/tmp/project/src/file-1.ts",
      workspaceRoot: "/tmp/project",
    });
  });

  test("renders cwd-relative file rows for absolute diff paths while keeping side-panel targets absolute", () => {
    let sidePanelPath = "";
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({
            unifiedDiff: [
              diffForPath("/tmp/project/src/absolute-1.ts"),
              diffForPath("/tmp/project/src/absolute-2.ts"),
            ].join("\n"),
          })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
          onOpenFileInSidePanel={(target) => {
            sidePanelPath = target.path;
          }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.textContent?.includes("src/absolute-1.ts"))).toBe(true);
    expect(Boolean(container.textContent?.includes("/tmp/project/src/absolute-1.ts"))).toBe(false);

    fireEvent.click(findButtonByText(container, "src/absolute-1.ts") as HTMLButtonElement, {
      metaKey: true,
    });
    expect(sidePanelPath).toBe("/tmp/project/src/absolute-1.ts");
  });

  test("suppresses hover preview wiring while preserving row Review clicks", () => {
    const enabledView = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(3) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
        />
      </TooltipProvider>,
    );
    const enabledRow = findButtonByText(
      enabledView.container,
      "src/file-1.ts",
    ) as HTMLButtonElement;
    expect(enabledRow.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
    enabledView.unmount();

    let focusedPath: string | null = null;
    const disabledView = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: multiFileDiff(3) })}
          isInProgress={false}
          threadCwd="/tmp/project"
          disableHoverPreview
          onOpenReview={(target) => {
            focusedPath = target.targetPath ?? null;
          }}
        />
      </TooltipProvider>,
    );
    const disabledRow = findButtonByText(
      disabledView.container,
      "src/file-1.ts",
    ) as HTMLButtonElement;
    expect(disabledRow.hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);

    fireEvent.click(disabledRow);
    expect(focusedPath).toBe("src/file-1.ts");
  });

  test("renders a single-file card without a multi-file list", () => {
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: diffForPath("src/one.ts") })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.textContent?.includes("Edited one.ts"))).toBe(true);
    expect(container.querySelectorAll("button[aria-expanded]").length).toBe(0);
    expect(Boolean(container.textContent?.includes("src/one.ts"))).toBe(false);
  });

  test("summarizes an oversized multi-file diff before inline parsing", () => {
    const largeDiff = [
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      "@@ -1,5001 +1,5001 @@",
      ...Array.from({ length: 5001 }, (_, index) => `-${index}`),
      ...Array.from({ length: 5001 }, (_, index) => `+${index}`),
      diffForPath("src/small.ts"),
    ].join("\n");

    const { getByText } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({ unifiedDiff: largeDiff })}
          isInProgress={false}
          threadCwd="/tmp/project"
          onOpenReview={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(getByText("Too large for inline preview")).toBeDefined();
  });

  test("shows the streaming summary with the in-progress state attribute", () => {
    let openedSourceKind = "";
    const { container } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry()}
          isInProgress={true}
          threadCwd="/tmp/project"
          onOpenReview={(target) => {
            openedSourceKind = target.source.kind;
          }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.textContent?.includes("2 files changed"))).toBe(true);
    expect(Boolean(container.querySelector('[codex\\.turn_diff\\.state="in_progress"]'))).toBe(
      true,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(openedSourceKind).toBe("last-turn");
  });

  test("renders the compact in-progress summary with optional leading separator", () => {
    let openedPath: string | null = "unset";
    const { container } = render(
      <TooltipProvider>
        <TurnDiffInProgressInlineSummary
          item={buildTurnDiffEntry({ unifiedDiff: diffForPath("src/one.ts") })}
          threadCwd="/tmp/project"
          showLeadingSeparator
          onOpenReview={(target) => {
            openedPath = target.targetPath ?? null;
          }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.textContent?.includes("·"))).toBe(true);
    expect(Boolean(container.textContent?.includes("1 file changed"))).toBe(true);
    expect(Boolean(container.querySelector('[codex\\.turn_diff\\.state="in_progress"]'))).toBe(
      true,
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Review changed files"]',
      ) as HTMLButtonElement,
    );
    expect(openedPath).toBe(null);
  });

  test("parses Codex-style file stats including quoted paths and duplicate file headers", () => {
    const stats = turnDiffSurfaceTestHelpers.parseUnifiedDiffFileStats(
      [
        'diff --git "a/src/weird file.ts" "b/src/weird file.ts"',
        "--- a/src/weird file.ts",
        "+++ b/src/weird file.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/weird file.ts b/src/weird file.ts",
        "--- a/src/weird file.ts",
        "+++ b/src/weird file.ts",
        "@@ -2 +2 @@",
        "-old2",
        "+new2",
      ].join("\n"),
    );

    expect(stats.length).toBe(1);
    expect(stats[0]?.path ?? null).toBe("src/weird file.ts");
    expect(stats[0]?.additions ?? null).toBe(2);
    expect(stats[0]?.deletions ?? null).toBe(2);
  });

  test("builds cwd-relative display paths without changing relative diff paths", () => {
    expect(
      turnDiffSurfaceTestHelpers.buildTurnDiffDisplayPath(
        "/tmp/project/src/absolute.ts",
        "/tmp/project",
      ),
    ).toBe("src/absolute.ts");
    expect(
      turnDiffSurfaceTestHelpers.buildTurnDiffDisplayPath(
        "/tmp/other/src/outside.ts",
        "/tmp/project",
      ),
    ).toBe("../other/src/outside.ts");
    expect(
      turnDiffSurfaceTestHelpers.buildTurnDiffDisplayPath("src/relative.ts", "/tmp/project"),
    ).toBe("src/relative.ts");
    expect(
      turnDiffSurfaceTestHelpers.buildTurnDiffDisplayPath("/tmp/project", "/tmp/project"),
    ).toBe("project");
  });

  test("builds patch batches from patchBatches and falls back only when they are absent", () => {
    const payload = {
      unifiedDiff: diffForPath("src/fallback.ts"),
      patchBatches: [
        {
          cwd: "/tmp/one",
          changes: [
            {
              path: "src/one.ts",
              type: "update",
              unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
              movePath: null,
            },
          ],
        },
      ],
    };

    const batches = turnDiffSurfaceTestHelpers.buildTurnDiffApplyBatches(payload, "/tmp/project");
    expect(batches.length).toBe(1);
    expect(batches[0]?.cwd ?? null).toBe("/tmp/one");
    expect(Boolean(batches[0]?.diff.includes("src/one.ts"))).toBe(true);

    const fallbackBatches = turnDiffSurfaceTestHelpers.buildTurnDiffApplyBatches(
      {
        unifiedDiff: diffForPath("src/fallback.ts"),
      },
      "/tmp/project",
    );
    expect(fallbackBatches.length).toBe(1);
    expect(fallbackBatches[0]?.cwd ?? null).toBe("/tmp/project");

    const emptyPatchBatches = turnDiffSurfaceTestHelpers.buildTurnDiffApplyBatches(
      {
        unifiedDiff: diffForPath("src/fallback.ts"),
        patchBatches: [],
      },
      "/tmp/project",
    );
    expect(emptyPatchBatches.length).toBe(0);
  });

  test("uses undo reverse order, reapply forward order, and thread_diff operation source", async () => {
    const invokePayloads: unknown[] = [];
    const gitWorkerClient = createApplyPatchTestClient((payload) => {
      invokePayloads.push(payload);
      return {
        status: "success",
        appliedPaths: ["src/one.ts"],
        skippedPaths: [],
        conflictedPaths: [],
        errorCode: null,
        errorMessage: null,
      };
    });

    const { container, baseElement } = render(
      <NodexToastProvider>
        <TooltipProvider>
          <TurnDiffSurface
            item={buildTurnDiffEntry({
              rawItem: {
                showRevertButton: true,
                patchBatches: [
                  {
                    cwd: "/tmp/one",
                    changes: [
                      {
                        path: "src/one.ts",
                        type: "update",
                        unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
                        movePath: null,
                      },
                    ],
                  },
                  {
                    cwd: "/tmp/two",
                    changes: [
                      {
                        path: "src/two.ts",
                        type: "update",
                        unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
                        movePath: null,
                      },
                    ],
                  },
                ],
              },
            })}
            isInProgress={false}
            threadCwd="/tmp/project"
            gitWorkerClient={gitWorkerClient}
          />
        </TooltipProvider>
      </NodexToastProvider>,
    );

    fireEvent.click(findButtonByText(container, "Undo") as HTMLButtonElement);
    await waitFor(() => {
      expect(Boolean(baseElement.textContent?.includes("Changes reverted"))).toBe(true);
    });
    expect(JSON.stringify(invokePayloads[0] ?? {}).includes('"cwd":"/tmp/two"')).toBe(true);
    expect(JSON.stringify(invokePayloads[0] ?? {}).includes('"revert":true')).toBe(true);
    expect(
      JSON.stringify(invokePayloads[0] ?? {}).includes('"operationSource":"thread_diff"'),
    ).toBe(true);

    fireEvent.click(findButtonByText(container, "Reapply") as HTMLButtonElement);
    await waitFor(() => {
      expect(Boolean(baseElement.textContent?.includes("Changes reapplied"))).toBe(true);
    });
    expect(JSON.stringify(invokePayloads[2] ?? {}).includes('"cwd":"/tmp/one"')).toBe(true);
    expect(JSON.stringify(invokePayloads[2] ?? {}).includes('"revert":false')).toBe(true);
  });

  test("opens a patch failure dialog with applied skipped and conflicted paths", async () => {
    const gitWorkerClient = createApplyPatchTestClient(() => ({
      status: "error",
      appliedPaths: ["src/applied.ts"],
      skippedPaths: ["src/skipped.ts"],
      conflictedPaths: ["src/conflict.ts"],
      errorCode: "applyFailed",
      errorMessage: "patch failed",
    }));

    const { container, baseElement } = render(
      <TooltipProvider>
        <TurnDiffSurface
          item={buildTurnDiffEntry({
            rawItem: {
              showRevertButton: true,
            },
          })}
          isInProgress={false}
          threadCwd="/tmp/project"
          gitWorkerClient={gitWorkerClient}
        />
      </TooltipProvider>,
    );

    fireEvent.click(findButtonByText(container, "Undo") as HTMLButtonElement);
    await waitFor(() => {
      expect(Boolean(baseElement.textContent?.includes("Failed to revert changes"))).toBe(true);
    });
    expect(Boolean(baseElement.textContent?.includes("Applied cleanly (1)"))).toBe(true);
    expect(Boolean(baseElement.textContent?.includes("Skipped (1)"))).toBe(true);
    expect(Boolean(baseElement.textContent?.includes("Conflicts (1)"))).toBe(true);
  });
});
