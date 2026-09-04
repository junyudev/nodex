import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
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
        "@@ -1,5 +1,7 @@",
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
  changes: Array<{
    path: string;
    kind: { type: "add" | "delete" } | { type: "update"; move_path: string | null };
    diff: string;
  }>;
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
      invoke: async () => true,
      on: () => () => {},
    });
  });

  test("expands into an inline diff frame with the Codex-style inner header", async () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry()} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    expect(Boolean(container.textContent?.includes("Edited file"))).toBe(true);
    expect(Boolean(container.textContent?.includes("local-conversation-stage-screen.tsx"))).toBe(
      true,
    );
    expect(Boolean(container.textContent?.includes("+2"))).toBe(true);
    expect(Boolean(container.textContent?.includes("-0"))).toBe(true);
    expect(Boolean(container.querySelector('button[aria-label="Copy diff"]'))).toBe(true);

    const body = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(Boolean(body)).toBe(true);
    expect(body?.querySelectorAll("diffs-container").length ?? 0).toBe(1);
    const diffHost = body?.querySelector<HTMLElement>("diffs-container.nodex-inline-diff") ?? null;
    expect(Boolean(diffHost)).toBe(true);
    await waitFor(() => {
      expect(Boolean(diffHost?.shadowRoot?.textContent?.includes("StoryShell"))).toBe(true);
    });
  });

  test("renders live file-change stats with the static Codex patch-row chip", () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({ status: "inProgress" })}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("+2"))).toBe(true);
    expect(Boolean(textContent(container).includes("-0"))).toBe(true);
    expect(Boolean(container.querySelector(".diff-stat-digit-column"))).toBe(false);
    expect(Boolean(container.querySelector("[data-tool-activity-icon='edit-files']"))).toBe(true);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(true);
  });

  test("derives pending and stopped row states from approval and turn state", () => {
    const pendingRows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        status: "inProgress",
        approvalRequestId: "approval-1",
      }),
      "/tmp/project",
      undefined,
    );
    const stoppedRows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        status: "inProgress",
        fileChange: buildFileChangeView([{ type: "add", path: "poem.md", content: "line\n" }]),
      }),
      "/tmp/project",
      undefined,
      true,
    );

    expect(pendingRows[0]?.state ?? "").toBe("pending");
    expect(pendingRows[0]?.showActionLabel ?? true).toBe(false);
    expect(stoppedRows[0]?.state ?? "").toBe("stopped");
    expect(stoppedRows[0]?.label ?? "").toBe("Stopped creating");
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

  test("prefers grantRoot when resolving patch paths", () => {
    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({ grantRoot: "/tmp/granted" }),
      "/tmp/thread-cwd",
      "/tmp/project",
    );

    expect(rows[0]?.openPath ?? null).toBe(
      "/tmp/granted/src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
    );
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

  test("keeps detail-disabled patch rows static and non-disclosable", () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry()}
          threadCwd="/tmp/project"
          showDiffDetails={false}
        />
      </TooltipProvider>,
    );

    const header = container.querySelector<HTMLElement>("[data-testid='file-change-row-header']");
    expect(Boolean(header)).toBe(true);
    expect(header?.getAttribute("aria-expanded") ?? null).toBe(null);
    expect(Boolean(header?.querySelector("button[aria-expanded]"))).toBe(false);
    expect(Boolean(container.querySelector("[data-file-change-row-body]"))).toBe(false);
    expect(Boolean(container.querySelector("[data-thread-find-skip]"))).toBe(false);
  });

  test("keeps empty update diffs as a visible streaming edit row", () => {
    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildNormalizedFileChangeEntry({
        status: "inProgress",
        changes: [
          {
            path: "src/app.ts",
            kind: { type: "update", move_path: null },
            diff: "",
          },
        ],
      }),
      "/tmp/project",
      undefined,
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.key ?? "").toBe("src/app.ts");
    expect(rows[0]?.state ?? "").toBe("streaming");
    expect(rows[0]?.label ?? "").toBe("Editing");
    expect(rows[0]?.displayPath ?? "").toBe("src/app.ts");
    expect(rows[0]?.summary?.additions ?? -1).toBe(0);
    expect(rows[0]?.summary?.deletions ?? -1).toBe(0);
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
    fireEvent.click(filenameLink as HTMLElement);
    await settleAsyncRender();

    expect(Boolean(container.textContent?.includes("Edited file"))).toBe(false);
  });

  test("opens collapsed patch paths in the side panel unless the click is modified", () => {
    let sidePanelTarget: { path: string; workspaceRoot?: string | null } | null = null;
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({ grantRoot: "/tmp/granted" })}
          threadCwd="/tmp/project"
          onOpenFileInSidePanel={(target) => {
            sidePanelTarget = target;
          }}
        />
      </TooltipProvider>,
    );
    const filenameLink = container.querySelector<HTMLElement>(
      "[data-agent-activity-file-link][role='link']",
    );
    expect(Boolean(filenameLink)).toBe(true);

    fireEvent.click(filenameLink as HTMLElement, { metaKey: true });
    expect(sidePanelTarget).toBe(null);

    fireEvent.click(filenameLink as HTMLElement);
    expect(sidePanelTarget).toMatchObject({
      path: "/tmp/granted/src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
      workspaceRoot: "/tmp/granted",
    });
  });

  test("derives parsed file diff stats from actual changed lines", () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
        type: "update",
        movePath: null,
        unifiedDiff: [
          "@@ -3,11 +3,12 @@",
          ' import { LocalConversationFooter } from "./local-conversation-footer";',
          ' import { ThreadStageHeader } from "./local-conversation-stage-header";',
          ' import { LocalConversationThreadBody } from "./local-conversation-thread-body";',
          '+import { StoryShell } from "./thread-stage-dev-story";',
          " ",
          " export function LocalConversationStageScreen({ model, actions, initialUiState }: ThreadStageScreenProps) {",
          "   const [errorMessage, setErrorMessage] = useState<string | null>(null);",
          " ",
          "   return (",
          '-    <div className="flex h-full min-h-0 flex-col bg-(--background)">',
          '+    <StoryShell className="flex h-full min-h-0 flex-col bg-(--background)">',
          "       <ThreadStageHeader model={model} actions={actions} onErrorMessage={setErrorMessage} />",
          "       <LocalConversationThreadBody",
          "@@ -22,6 +23,6 @@",
          "         errorMessage={errorMessage}",
          "         onErrorMessage={setErrorMessage}",
          "       />",
          "-    </div>",
          "+    </StoryShell>",
          "   );",
          " }",
        ].join("\n"),
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        fileChange,
        toolCall: {
          subtype: "fileChange",
          toolName: "file_change",
          args: {
            label: buildFileChangeLabel(changes[0]),
          },
          result: { changes: fileChange.changes },
        },
      }),
      "/tmp/project",
      undefined,
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.summary?.additions ?? null).toBe(3);
    expect(rows[0]?.summary?.deletions ?? null).toBe(2);
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

  test("toggles multi-file rows independently", async () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/one.ts",
        type: "update",
        movePath: null,
        unifiedDiff: ["@@ -1 +1 @@", "-console.log('one');", "+console.log('ONE');"].join("\n"),
      },
      {
        path: "src/two.ts",
        type: "update",
        movePath: null,
        unifiedDiff: ["@@ -1 +1 @@", "-console.log('two');", "+console.log('TWO');"].join("\n"),
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const multiFileEntry = buildFileChangeEntry({
      fileChange,
      toolCall: {
        subtype: "fileChange",
        toolName: "file_change",
        args: {
          label: undefined,
        },
        result: { changes: fileChange.changes },
      },
    });

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={multiFileEntry} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const toggles = fileChangeHeaders(container);
    expect(toggles.length).toBe(2);

    fireEvent.click(toggles[0]!);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-file-change-row-body] diffs-container").length).toBe(
        1,
      );
    });
    expect(Boolean(textContent(container).includes("Edited file"))).toBe(true);

    const diffHost = container.querySelector<HTMLElement>(".nodex-inline-diff");
    expect(Boolean(diffHost)).toBe(true);
    expect(Boolean(diffHost?.shadowRoot?.querySelector("[data-diffs-header]"))).toBe(false);
  });

  test("keeps the file-change body on explicit pixel height instead of switching to auto", async () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry()} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    const body = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(Boolean(body)).toBe(true);
    expect(body?.style.height === "auto").toBe(false);
  });

  test("does not mount non-streaming collapsed diff content before expansion", async () => {
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={buildFileChangeEntry()} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const collapsedBody = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(Boolean(collapsedBody)).toBe(true);
    expect(Boolean(collapsedBody?.querySelector("diffs-container"))).toBe(false);
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

  test("renders created files from v2 protocol changes as inline diffs", async () => {
    const item = buildNormalizedFileChangeEntry({
      changes: [
        {
          path: "src/local-conversation-resume-loader.tsx",
          kind: { type: "add" },
          diff: [
            'import { NodexLogoMarkIcon } from "@/components/shared/icons";',
            "",
            "const NODEX_LOGO_MASK_IMAGE = 'url(data:image/svg+xml,%3Csvg/...)';",
            "",
            "export function LocalConversationResumeLoader() {",
            "  return <NodexLogoMarkIcon />;",
            "}",
          ].join("\n"),
        },
      ],
    });

    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(item, "/tmp/project", undefined);
    expect(rows.length).toBe(1);
    expect(rows[0]?.summary?.additions ?? null).toBe(7);
    expect(rows[0]?.summary?.deletions ?? null).toBe(0);

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall item={item} threadCwd="/tmp/project" />
      </TooltipProvider>,
    );

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);
    expect(Boolean(textContent(container).includes("Created"))).toBe(true);
    expect(Boolean(textContent(container).includes("+7"))).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Created file"))).toBe(true);
    expect(Boolean(textContent(container).includes("local-conversation-resume-loader.tsx"))).toBe(
      true,
    );
    const diffHost = container.querySelector<HTMLElement>(".nodex-inline-diff");
    expect(Boolean(diffHost)).toBe(true);
    await waitFor(() => {
      expect(Boolean(diffHost?.shadowRoot?.textContent?.includes("NodexLogoMarkIcon"))).toBe(true);
    });
    const body = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(body?.querySelectorAll("diffs-container").length ?? 0).toBe(1);
  });

  test("renders multi-file created rows with visible diff content under the expanded frame header", async () => {
    const changes: CodexFileChange[] = [
      {
        path: "tools/extract-thread-floating-activity-card-artifacts.mjs",
        type: "add",
        content:
          "export const extractor = true;\nexport function extractArtifacts() {\n  return extractor;\n}\n",
      },
      {
        path: "tools/verify-thread-floating-activity-card-artifacts.mjs",
        type: "add",
        content: "export const verifier = true;\n",
      },
    ];
    const fileChange = buildFileChangeView(changes);
    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({
            fileChange,
            toolCall: {
              subtype: "fileChange",
              toolName: "file_change",
              args: {
                label: undefined,
              },
              result: { changes: fileChange.changes },
            },
          })}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    const toggles = fileChangeHeaders(container);
    expect(toggles.length).toBe(2);
    fireEvent.click(toggles[0]!);
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Created file"))).toBe(true);
    expect(
      Boolean(
        textContent(container).includes("extract-thread-floating-activity-card-artifacts.mjs"),
      ),
    ).toBe(true);
    const body = container.querySelector<HTMLElement>("[data-file-change-row-body]");
    expect(body?.querySelectorAll("diffs-container").length ?? 0).toBe(1);
    const diffHost = body?.querySelector<HTMLElement>("diffs-container.nodex-inline-diff") ?? null;
    expect(Boolean(diffHost)).toBe(true);
    await waitFor(() => {
      expect(Boolean(diffHost?.shadowRoot?.textContent?.includes("extractArtifacts"))).toBe(true);
    });
  });

  test("never falls back to raw patch text", async () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/new-file.ts",
        type: "add",
        content: "export function Foo() {}\n",
      },
      {
        path: "src/deleted-file.ts",
        type: "delete",
        content: "export function Gone() {}\n",
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({
            fileChange,
            toolCall: {
              subtype: "fileChange",
              toolName: "file_change",
              args: {
                label: undefined,
              },
              result: { changes: fileChange.changes },
            },
          })}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("*** Begin Patch"))).toBe(false);
    expect(Boolean(container.querySelector('button[aria-label="Copy diff"]'))).toBe(true);
  });

  test("renders declined file changes with rejected status copy", async () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/new-file.ts",
        type: "add",
        content: "export const created = true;\n",
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry({
            status: "declined",
            fileChange,
            toolCall: {
              subtype: "fileChange",
              toolName: "file_change",
              args: {
                label: buildFileChangeLabel(changes[0]),
              },
              result: { changes: fileChange.changes },
            },
          })}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Rejected"))).toBe(true);

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Created file"))).toBe(false);
  });

  test("renders failed file changes with rejected status copy", () => {
    const changes: CodexFileChange[] = [
      {
        path: "src/new-file.ts",
        type: "add",
        content: "export const created = true;\n",
      },
    ];
    const fileChange = buildFileChangeView(changes);

    const rows = fileChangeToolCallTestHelpers.buildFileChangeRows(
      buildFileChangeEntry({
        status: "failed",
        fileChange,
        toolCall: {
          subtype: "fileChange",
          toolName: "file_change",
          args: {
            label: buildFileChangeLabel(changes[0]),
          },
          result: { changes: fileChange.changes },
        },
      }),
      "/tmp/project",
      undefined,
    );

    expect(rows[0]?.label ?? null).toBe("Rejected");
    expect(rows[0]?.expandedLabel ?? null).toBe(null);
  });

  test("renders attached automatic approval reviews inside the expanded patch row", async () => {
    const reviewItem: CodexTranscriptEntry = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "automatic-approval-review:review-1",
      entryId: "automatic-approval-review:review-1",
      type: "automaticApprovalReview",
      kind: "systemEvent",
      semanticKind: "automaticApprovalReview",
      status: "completed",
      markdownText: "This edit is high risk.",
      rawItem: {
        targetItemId: "tool-1",
        review: {
          status: "denied",
          riskLevel: "high",
          userAuthorization: "unknown",
          rationale: "This edit is high risk.",
        },
        action: null,
      },
      createdAt: 1,
      updatedAt: 1,
    };

    const { container } = render(
      <TooltipProvider>
        <FileChangeToolCall
          item={buildFileChangeEntry()}
          threadCwd="/tmp/project"
          automaticApprovalReviews={[reviewItem]}
        />
      </TooltipProvider>,
    );

    const summaryToggle = fileChangeHeaders(container)[0] ?? null;
    expect(Boolean(summaryToggle)).toBe(true);
    expect(Boolean(container.querySelector("[data-testid='file-change-row-header'] svg"))).toBe(
      true,
    );

    fireEvent.click(summaryToggle as HTMLElement);
    await settleAsyncRender();

    const reviewButton =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
        textContent(element).includes("Auto-review denied high risk"),
      ) ?? null;
    expect(Boolean(reviewButton)).toBe(true);
    expect(
      Boolean(textContent(reviewButton as HTMLElement).includes("Auto-review denied high risk")),
    ).toBe(true);
    expect(Boolean(textContent(reviewButton as HTMLElement).includes("High risk"))).toBe(false);
    expect(reviewButton?.getAttribute("aria-expanded") ?? null).toBe("false");

    fireEvent.click(reviewButton as HTMLElement);
    await waitFor(() => {
      expect(reviewButton?.getAttribute("aria-expanded") ?? null).toBe("true");
    });
    expect(Boolean(textContent(container).includes("This edit is high risk."))).toBe(true);
  });
});
