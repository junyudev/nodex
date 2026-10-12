import { describe, expect, test } from "vite-plus/test";
import type { McpToolCallResult, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import {
  buildThreadSummaryPanelOutputRows,
  collectTurnEndResourcePaths,
  isThreadSummaryPanelImagePreviewableOutput,
  resolveThreadSummaryPanelOutputOpenTarget,
  type ThreadSummaryPanelOutputRow,
} from "./thread-summary-panel-output-model";

type ProtocolMcpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function buildTurn(items: CodexConversationItem[]): CodexConversationTurn {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    itemIds: items.map((item) => item.itemId),
    items,
  };
}

function buildTurnWithStatus(
  items: CodexConversationItem[],
  status: CodexConversationTurn["status"],
): CodexConversationTurn {
  return {
    ...buildTurn(items),
    status,
  };
}

function buildItem(
  itemId: string,
  type: string,
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    entryId: itemId,
    type,
    kind: "systemEvent",
    semanticKind: "systemEvent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function outputPath(row: ThreadSummaryPanelOutputRow): string {
  return "path" in row ? row.path : "";
}

function buildMcpSuccessItem(
  itemId: string,
  input: {
    server: string;
    tool: string;
    structuredContent: McpToolCallResult["structuredContent"];
    arguments?: ProtocolMcpToolCallItem["arguments"];
  },
): CodexConversationItem {
  return buildItem(itemId, "mcpToolCall", {
    kind: "toolCall",
    semanticKind: "toolCall",
    mcpToolCall: {
      callId: itemId,
      functionName: `${input.server}__${input.tool}`,
      pluginId: null,
      readOnlyHint: true,
      mcpAppResourceUri: undefined,
      source: null,
      invocation: {
        server: input.server,
        tool: input.tool,
        arguments: input.arguments ?? {},
      },
      result: {
        type: "success",
        content: [],
        structuredContent: input.structuredContent,
        raw: {
          content: [],
          structuredContent: input.structuredContent,
          _meta: null,
        },
      },
      durationMs: null,
      completed: true,
    },
  });
}

describe("buildThreadSummaryPanelOutputRows", () => {
  test("does not derive summary panel outputs from file changes", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildItem("file-change", "fileChange", {
          kind: "fileChange",
          semanticKind: "patch",
          fileChange: {
            label: "src/app.ts",
            changes: buildCodexFileChangeMap([
              {
                type: "update",
                path: "src/app.ts",
                movePath: null,
                unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
              },
            ]),
          },
        }),
      ]),
    ]);

    expect(rows.length).toBe(0);
  });

  test("collects image outputs from protocol image items", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildItem("generated-1", "imageGeneration", {
          rawItem: {
            id: "generated-1",
            type: "imageGeneration",
            status: "completed",
            result: "",
            savedPath: "/tmp/nodex/generated-one.png",
          },
        }),
        buildItem("image-view-1", "imageView", {
          rawItem: {
            id: "image-view-1",
            type: "imageView",
            path: "/tmp/nodex/reference.jpg",
          },
        }),
      ]),
    ]);

    expect(rows.length).toBe(2);
    expect(rows.map(outputPath).join(",")).toBe(
      "/tmp/nodex/generated-one.png,/tmp/nodex/reference.jpg",
    );
    expect(rows.map((row) => row.kind).join(",")).toBe("generated-image,image");
  });

  test("collects file outputs from assistant file references", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurn([
          buildItem("assistant-1", "agentMessage", {
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            markdownText:
              "Updated \u3010F:src/renderer/app.tsx\u2020L10-L12\u3011 and reviewed \u3010F:src/renderer/app.tsx\u2020L40\u3011.",
          }),
        ]),
      ],
      {
        cwd: "/repo/project",
      },
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.kind ?? "").toBe("file");
    expect(rows[0] ? outputPath(rows[0]) : "").toBe("/repo/project/src/renderer/app.tsx");
    expect(rows[0]?.label ?? "").toBe("app.tsx");
  });

  test("marks generated images, image views, and image file references as previewable", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText:
            "Saved \u3010F:/tmp/nodex/chart.webp\u2020L1\u3011 and \u3010F:/tmp/nodex/report.txt\u2020L1\u3011.",
        }),
        buildItem("image-view-1", "imageView", {
          rawItem: {
            id: "image-view-1",
            type: "imageView",
            path: "/tmp/nodex/reference.jpg",
          },
        }),
        buildItem("generated-1", "imageGeneration", {
          rawItem: {
            id: "generated-1",
            type: "imageGeneration",
            status: "completed",
            result: "",
            savedPath: "/tmp/nodex/generated.png",
          },
        }),
      ]),
    ]);

    const chart = rows.find((row) => outputPath(row) === "/tmp/nodex/chart.webp");
    const report = rows.find((row) => outputPath(row) === "/tmp/nodex/report.txt");
    const imageView = rows.find((row) => outputPath(row) === "/tmp/nodex/reference.jpg");
    const generated = rows.find((row) => outputPath(row) === "/tmp/nodex/generated.png");

    expect(chart ? isThreadSummaryPanelImagePreviewableOutput(chart) : false).toBe(true);
    expect(imageView ? isThreadSummaryPanelImagePreviewableOutput(imageView) : false).toBe(true);
    expect(generated ? isThreadSummaryPanelImagePreviewableOutput(generated) : false).toBe(true);
    expect(report ? isThreadSummaryPanelImagePreviewableOutput(report) : true).toBe(false);
  });

  test("promotes referenced image files to generated image outputs", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: "Generated \u3010F:/tmp/nodex/generated.png\u2020L1\u3011.",
        }),
        buildItem("generated-1", "imageGeneration", {
          rawItem: {
            id: "generated-1",
            type: "imageGeneration",
            status: "completed",
            result: "",
            savedPath: "/tmp/nodex/generated.png",
          },
        }),
      ]),
    ]);

    expect(rows.length).toBe(1);
    expect(rows[0]?.kind ?? "").toBe("generated-image");
    expect(rows[0]?.label ?? "").toBe("Generated image 1");
  });

  test("deduplicates by path and promotes generated images", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildItem("image-view-1", "imageView", {
          rawItem: {
            id: "image-view-1",
            type: "imageView",
            path: "/tmp/nodex/generated.png",
          },
        }),
        buildItem("generated-1", "imageGeneration", {
          rawItem: {
            id: "generated-1",
            type: "imageGeneration",
            status: "completed",
            result: "",
            savedPath: "/tmp/nodex/generated.png",
          },
        }),
      ]),
    ]);

    expect(rows.length).toBe(1);
    expect(rows[0]?.kind ?? "").toBe("generated-image");
    expect(rows[0]?.label ?? "").toBe("Generated image 1");
  });

  test("limits summary outputs to the first five rows", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn(
        Array.from({ length: 7 }, (_, index) =>
          buildItem(`image-${index}`, "imageView", {
            rawItem: {
              id: `image-${index}`,
              type: "imageView",
              path: `/tmp/nodex/image-${index}.png`,
            },
          }),
        ),
      ),
    ]);

    expect(rows.length).toBe(5);
    expect(rows.map(outputPath).join(",")).toBe(
      "/tmp/nodex/image-0.png,/tmp/nodex/image-1.png,/tmp/nodex/image-2.png,/tmp/nodex/image-3.png,/tmp/nodex/image-4.png",
    );
  });

  test("collects Google Drive and localhost website outputs from completed assistant end cards", () => {
    const driveUrl = "https://docs.google.com/document/d/doc-123/edit";
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildMcpSuccessItem("drive-tool", {
          server: "google-drive",
          tool: "create_document",
          structuredContent: {
            title: "Reference Roadmap",
            document_url: driveUrl,
          },
        }),
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: [
            `Created [Draft](${driveUrl}).`,
            "Preview: http://localhost:5173/preview",
          ].join("\n"),
        }),
      ]),
    ]);

    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.kind).join(",")).toBe("google-drive,website");

    const drive = rows.find((row) => row.kind === "google-drive");
    expect(drive?.label ?? "").toBe("Reference Roadmap");
    expect(drive && "url" in drive ? drive.url : "").toBe(driveUrl);
    expect(drive && "resourceKind" in drive ? drive.resourceKind : "").toBe("document");

    const website = rows.find((row) => row.kind === "website");
    expect(website?.label ?? "").toBe("localhost:5173/preview");
    const target = website ? resolveThreadSummaryPanelOutputOpenTarget(website) : null;
    expect(target?.type ?? "").toBe("url");
    expect(target?.type === "url" ? target.url : "").toBe("http://localhost:5173/preview");
  });

  test("collects appgen app outputs from sites MCP successes and suppresses localhost fallback", () => {
    const rows = buildThreadSummaryPanelOutputRows([
      buildTurn([
        buildMcpSuccessItem("appgen-tool", {
          server: "codex_apps",
          tool: "sites.publish",
          structuredContent: {
            project_id: "appgprj_story",
            current_live_url: "https://story-app.example.com/",
            title: "Story app",
          },
        }),
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: "Preview: http://localhost:5173/preview",
        }),
      ]),
    ]);

    expect(rows.length).toBe(1);
    expect(rows[0]?.kind ?? "").toBe("appgen-app");
    expect(rows[0]?.label ?? "").toBe("Story app");
    const target = rows[0] ? resolveThreadSummaryPanelOutputOpenTarget(rows[0]) : null;
    expect(target?.type ?? "").toBe("url");
    expect(target?.type === "url" ? target.url : "").toBe("https://story-app.example.com/");
  });

  test("collects markdown file links outside fenced code blocks", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurn([
          buildItem("assistant-1", "agentMessage", {
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            markdownText: [
              "Saved [report](docs/report.pdf).",
              "```",
              "[ignored](docs/ignored.pdf)",
              "```",
              "Also saved `[deck](slides/deck.pptx)`.",
            ].join("\n"),
          }),
        ]),
      ],
      {
        cwd: "/repo/project",
      },
    );

    expect(rows.length).toBe(2);
    expect(rows.map(outputPath).join(",")).toBe(
      "/repo/project/docs/report.pdf,/repo/project/slides/deck.pptx",
    );
  });

  test("collects completed edited resource artifacts without treating ordinary source patches as outputs", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurn([
          buildItem("file-change", "fileChange", {
            kind: "fileChange",
            semanticKind: "patch",
            fileChange: {
              label: "artifacts",
              changes: buildCodexFileChangeMap([
                { type: "add", path: "reports/summary.pdf", content: "%PDF" },
                {
                  type: "update",
                  path: "reports/draft.pdf",
                  movePath: "reports/final.pdf",
                  unifiedDiff: "@@ -1 +1 @@\n-draft\n+final",
                },
                {
                  type: "update",
                  path: "src/app.ts",
                  movePath: null,
                  unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
                },
              ]),
            },
          }),
        ]),
      ],
      {
        cwd: "/repo/project",
      },
    );

    expect(rows.length).toBe(2);
    expect(rows.map(outputPath).join(",")).toBe(
      "/repo/project/reports/summary.pdf,/repo/project/reports/final.pdf",
    );
  });

  test("does not collect edited resource artifacts before a turn completes", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurnWithStatus(
          [
            buildItem("file-change", "fileChange", {
              kind: "fileChange",
              semanticKind: "patch",
              fileChange: {
                label: "report.pdf",
                changes: buildCodexFileChangeMap([
                  { type: "add", path: "reports/summary.pdf", content: "%PDF" },
                ]),
              },
            }),
          ],
          "inProgress",
        ),
      ],
      {
        cwd: "/repo/project",
      },
    );

    expect(rows.length).toBe(0);
  });

  test("filters artifact resources through the projectless output directory", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurn([
          buildItem("assistant-1", "agentMessage", {
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            markdownText: [
              "Saved \u3010F:output/inside.pdf\u2020L1\u3011.",
              "Also saved \u3010F:outside/outside.pdf\u2020L1\u3011.",
            ].join("\n"),
          }),
          buildItem("generated-1", "imageGeneration", {
            rawItem: {
              id: "generated-1",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "output/chart.png",
            },
          }),
          buildItem("generated-2", "imageGeneration", {
            rawItem: {
              id: "generated-2",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "outside/chart.png",
            },
          }),
          buildItem("file-change", "fileChange", {
            kind: "fileChange",
            semanticKind: "patch",
            fileChange: {
              label: "reports",
              changes: buildCodexFileChangeMap([
                { type: "add", path: "output/report.pdf", content: "%PDF" },
                { type: "add", path: "outside/report.pdf", content: "%PDF" },
              ]),
            },
          }),
        ]),
      ],
      {
        cwd: "/repo/project",
        projectlessOutputDirectory: "output",
      },
    );

    expect(rows.length).toBe(3);
    expect(rows.map(outputPath).join(",")).toBe(
      "/repo/project/output/inside.pdf,/repo/project/output/chart.png,/repo/project/output/report.pdf",
    );
  });

  test("uses a single completed edited HTML artifact as a local website output", () => {
    const rows = buildThreadSummaryPanelOutputRows(
      [
        buildTurn([
          buildItem("file-change", "fileChange", {
            kind: "fileChange",
            semanticKind: "patch",
            fileChange: {
              label: "dist/index.html",
              changes: buildCodexFileChangeMap([
                { type: "add", path: "dist/index.html", content: "<!doctype html>" },
              ]),
            },
          }),
        ]),
      ],
      {
        cwd: "/repo/project",
      },
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.kind ?? "").toBe("website");
    expect(rows[0]?.label ?? "").toBe("index.html");
    const target = rows[0] ? resolveThreadSummaryPanelOutputOpenTarget(rows[0]) : null;
    expect(target?.type ?? "").toBe("file");
    expect(target?.type === "file" ? target.path : "").toBe("/repo/project/dist/index.html");
  });
});

describe("collectTurnEndResourcePaths", () => {
  test("collects linked presentation outputs while excluding fenced-code examples", () => {
    const paths = collectTurnEndResourcePaths(
      buildTurn([
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: [
            "Download [the completed deck](slides/final.pptx).",
            "```md",
            "[example only](slides/not-created.pptx)",
            "```",
          ].join("\n"),
        }),
      ]),
    );

    expect(paths).toEqual(["slides/final.pptx"]);
  });

  test("collects explicitly exported presentation artifacts once", () => {
    const paths = collectTurnEndResourcePaths(
      buildTurn([
        buildItem("file-change", "fileChange", {
          kind: "fileChange",
          semanticKind: "patch",
          fileChange: {
            label: "slides",
            changes: buildCodexFileChangeMap([
              { type: "add", path: "slides/review.pptx", content: "presentation" },
            ]),
          },
        }),
        buildItem("assistant-1", "agentMessage", {
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText:
            'Created 【slides/review.pptx†L1】. :codex-file-citation{path="slides/review.pptx" purpose="output"}',
        }),
      ]),
    );

    expect(paths).toEqual(["slides/review.pptx"]);
  });
});
