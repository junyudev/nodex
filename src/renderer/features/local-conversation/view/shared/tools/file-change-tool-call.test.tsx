import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import {
  installAsyncRequestAnimationFrame,
  installElementScrollHeight,
  installMeasuredResizeObserver,
  installWindowApi,
} from "../../../../../test/browser-globals";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import { settleAsyncRender, textContent } from "../../../../../test/dom";
import type {
  CodexFileChange,
  CodexFileChangeView,
  CodexTranscriptEntry,
} from "../../../../../lib/types";
import { projectCodexCanonicalTurnItemViews } from "../../../../../../shared/codex-canonical-item-projector";
import type { CodexCanonicalFileUpdateChange } from "../../../../../../shared/codex-conversation-state/codex-conversation-state";
import {
  buildCodexFileChangeMap,
  resolveCodexPatchSuccess,
} from "../../../../../../shared/codex-file-change";
import { projectCodexItemViewToTranscriptEntry } from "../../../../../../shared/codex-transcript-entry-projection";
import { FileChangeToolCall, fileChangeToolCallTestHelpers } from "./file-change-tool-call";

const parsePatchFilesCall = vi.hoisted(() => vi.fn());

vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs")>();
  return {
    ...actual,
    parsePatchFiles: (...args: Parameters<typeof actual.parsePatchFiles>) => {
      parsePatchFilesCall();
      return actual.parsePatchFiles(...args);
    },
  };
});

function buildFileChangeView(changes: CodexFileChange[]): CodexFileChangeView {
  return {
    label: undefined,
    changes: buildCodexFileChangeMap(changes),
  };
}

function buildFileChangeLabel(change: CodexFileChange | undefined): string | undefined {
  if (!change) return undefined;
  return `${change.type === "add" ? "Created" : change.type === "delete" ? "Deleted" : "Edited"} ${change.path}`;
}

function buildFileChangeEntry(overrides?: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  const defaultChanges: CodexFileChange[] = [
    {
      path: "src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
      type: "update",
      movePath: "src/renderer/features/local-conversation/view/thread-stage-screen.tsx",
      unifiedDiff: [
        "@@ -1,4 +1,6 @@",
        ' import { useState } from "react";',
        '+import { StoryShell } from "./thread-stage-dev-story";',
        " ",
        " export function LocalConversationStageScreen() {",
        "+  return <StoryShell />;",
        " }",
      ].join("\n"),
    },
  ];
  const status = overrides?.status ?? "completed";
  const sourceFileChange = overrides?.fileChange ?? buildFileChangeView(defaultChanges);
  const fileChange = {
    ...sourceFileChange,
    success:
      sourceFileChange.success === undefined
        ? resolveCodexPatchSuccess(status)
        : sourceFileChange.success,
  };
  const label = fileChange.label ?? buildFileChangeLabel(defaultChanges[0]);

  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    entryId: "tool-1",
    type: "file_change",
    kind: "fileChange",
    toolCall: {
      subtype: "fileChange",
      toolName: "file_change",
      args: {
        label,
      },
      result: { changes: fileChange.changes },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
    status,
    fileChange,
  };
}

function buildNormalizedFileChangeEntry(input: {
  status?: "inProgress" | "completed" | "failed" | "declined";
  changes: CodexCanonicalFileUpdateChange[];
}): CodexTranscriptEntry {
  const item = projectCodexCanonicalTurnItemViews({
    threadId: "thread-1",
    turnId: "turn-1",
    observedAtMs: 1,
    turnStatus: "inProgress",
    items: [
      {
        id: "item-file-change",
        type: "fileChange",
        status: input.status ?? "completed",
        changes: input.changes,
      },
    ],
  })[0];
  if (!item) throw new Error("Expected normalized file change entry");
  return projectCodexItemViewToTranscriptEntry(item, "live", 0);
}

function fileChangeHeaders(container: HTMLElement): HTMLElement[] {
  const headers = Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-file-change-row-header], [data-testid='file-change-row-header']",
    ),
  );
  return headers.map(
    (header) => header.querySelector<HTMLElement>(":scope > button[aria-expanded]") ?? header,
  );
}

describe("FileChangeToolCall", () => {
  beforeEach(() => {
    parsePatchFilesCall.mockClear();
    installElementScrollHeight(96);
    installAsyncRequestAnimationFrame();
    installMeasuredResizeObserver({ blockSize: 96, inlineSize: 320 });
    installWindowApi({
      invoke: async (channel: string) =>
        channel === "shell:file-link-openers:list-available" ? ["vscode", "fileManager"] : true,
      on: () => () => {},
    });
  });

  test("uses canonical patch success before approval, cancellation, or generic item status", () => {
    const explicitUnknownRows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        status: "completed",
        fileChange: {
          ...buildFileChangeView([{ type: "add", path: "poem.md", content: "line\n" }]),
          success: null,
        },
      }),
      "/tmp/project",
      undefined,
    );
    const explicitAppliedRows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        status: "inProgress",
        approvalRequestId: "approval-1",
        fileChange: {
          ...buildFileChangeView([{ type: "add", path: "poem.md", content: "line\n" }]),
          success: true,
        },
      }),
      "/tmp/project",
      undefined,
      true,
    );

    expect(explicitUnknownRows[0]?.state ?? "").toBe("streaming");
    expect(explicitAppliedRows[0]?.state ?? "").toBe("applied");
  });

  test("renders visualization-only patches with create precedence and lifecycle visibility", () => {
    const fileChange = {
      changes: {},
      visualizationActivities: [
        { path: "/tmp/chart.html", kind: "update" as const },
        { path: "/tmp/new-chart.html", kind: "create" as const },
      ],
      success: true,
    };
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry({ fileChange })} />
      </TooltipProvider>,
    );

    expect(textContent(container)).toBe("Created visualization");
    expect(Boolean(container.querySelector("[data-file-change-visualization-status]"))).toBe(true);

    const stopped = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({
            status: "inProgress",
            fileChange: { ...fileChange, success: null },
          })}
          isTurnCancelled
        />
      </TooltipProvider>,
    );
    expect(stopped.container.textContent ?? "").toBe("");
  });

  test("resolves the Codex-style open-file target and keeps filename clicks from toggling the row", async () => {
    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry(),
      "/tmp/project",
      undefined,
    );
    expect(rows.length).toBe(1);
    const firstRow = rows[0];
    expect(firstRow?.openPath ?? null).toBe(
      "/tmp/project/src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
    );
    expect(firstRow?.openLine ?? null).toBe(1);

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry()} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const filenameLink = container.querySelector("[data-agent-activity-file-link][role='link']");
    expect(Boolean(filenameLink)).toBe(true);
    await act(async () => {
      fireEvent.click(filenameLink as HTMLElement);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(Boolean(container.textContent?.includes("Edited file"))).toBe(false);
  });

  test("uses canonical fallback diff stats and open line for malformed update hunks", () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/malformed.ts",
        type: "update",
        movePath: null,
        unifiedDiff: ["this is not a hunk header", "+added", "-removed"].join("\n"),
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        fileChange,
        toolCall: {
          subtype: "fileChange",
          toolName: "file_change",
          args: { label: buildFileChangeLabel(changes[0]) },
          result: { changes: fileChange.changes },
        },
      }),
      "/tmp/project",
      undefined,
    );

    expect(rows[0]?.summary?.additions ?? null).toBe(1);
    expect(rows[0]?.summary?.deletions ?? null).toBe(1);
    expect(rows[0]?.openLine ?? null).toBe(1);
  });

  test("does not mount non-streaming collapsed diff content before expansion", async () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry()} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    expect(container.querySelector("[data-file-change-row-body]")).toBe(null);
    expect(Boolean(container.querySelector("diffs-container"))).toBe(false);
    expect(Boolean(container.querySelector('button[aria-label="Copy diff"]'))).toBe(false);

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    const expandedBody = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(Boolean(expandedBody?.querySelector("diffs-container"))).toBe(true);
    expect(Boolean(container.querySelector('button[aria-label="Copy diff"]'))).toBe(true);
  });

  test("skips inline parsing and bounds the fallback for oversized file changes", async () => {
    const item = buildFileChangeEntry({
      fileChange: buildFileChangeView([
        {
          path: "src/large.ts",
          type: "update",
          movePath: null,
          unifiedDiff: ["@@ -0,0 +1 @@", `+${"x".repeat(256 * 1024)}`].join("\n"),
        },
      ]),
    });

    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(item, "/tmp/project", undefined);
    expect(parsePatchFilesCall).not.toHaveBeenCalled();
    expect(rows[0]?.preview.kind).toBe("semantic");

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={item} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );
    fireEvent.click(fileChangeHeaders(container)[0] as HTMLElement);
    await settleAsyncRender();

    expect(container.querySelector("pre")?.textContent?.length ?? 0).toBeLessThanOrEqual(32_000);
  });

  test("shows a withheld diff's measured lines and explains why it is not previewed", async () => {
    const item = buildNormalizedFileChangeEntry({
      changes: [
        {
          path: "src/generated.ts",
          kind: { type: "update", move_path: null },
          diff: "",
          diffWithheld: true,
          lineCounts: { additions: 300, deletions: 12 },
        },
      ],
    });
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={item} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );
    expect(textContent(container)).toContain("+300");
    expect(textContent(container)).toContain("-12");

    fireEvent.click(fileChangeHeaders(container)[0] as HTMLElement);
    await settleAsyncRender();

    expect(textContent(container)).toContain("Change is too large to preview");
    expect(container.querySelector('button[aria-label="Copy diff"]')).toBeNull();
  });

  test("never presents an unmeasured change as an empty +0 -0 edit", async () => {
    const item = buildNormalizedFileChangeEntry({
      changes: [
        {
          path: "src/app.ts",
          kind: { type: "update", move_path: null },
          diff: "",
          diffWithheld: true,
        },
      ],
    });
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={item} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );
    fireEvent.click(fileChangeHeaders(container)[0] as HTMLElement);
    await settleAsyncRender();

    expect(textContent(container)).toContain("Diff unavailable");
    expect(textContent(container)).not.toContain("+0");
  });

  test("declined file changes explain authorization and retain the proposed diff", async () => {
    const review: CodexTranscriptEntry = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "review",
      type: "automaticApprovalReview",
      kind: "systemEvent",
      createdAt: 1,
      updatedAt: 1,
      rawItem: {
        review: { status: "denied", riskLevel: "medium", rationale: "Private review rationale" },
      },
    };
    const item = buildFileChangeEntry({
      status: "declined",
      fileChange: {
        changes: { "src/proposed.ts": { type: "add", content: "export const proposed = true;\n" } },
        success: false,
        visualizationActivities: [{ path: "/tmp/visualizations/example.html", kind: "create" }],
      },
    });
    const { getByRole, getByText, queryByRole, queryByText, container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={item}
          threadCwd="/tmp/project"
          automaticApprovalReviews={[review]}
        />
      </TooltipProvider>,
    );
    const trigger = getByRole("button", { name: "Toggle diff for proposed.ts" });
    expect(getByText("File change declined by auto-review:")).toBeTruthy();
    expect(getByRole("link", { name: "proposed.ts" })).toBeTruthy();
    expect(container.querySelector("[data-file-change-visualization-status]")).toBeNull();
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(getByText("Requires explicit authorization")).toBeTruthy();
    expect(getByRole("button", { name: "Copy diff" })).toBeTruthy();
    expect(queryByRole("button", { name: "Auto-review denied" })).toBeNull();
    expect(queryByText("Private review rationale")).toBeNull();
  });
});
