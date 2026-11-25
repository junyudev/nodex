import { describe, expect, test } from "vite-plus/test";
import {
  collectTurnDiffChangedPaths,
  filterTurnDiffPayload,
  isResourceInsideProjectlessOutputDirectory,
  normalizeTurnDiffPatchBatches,
  shouldSuppressTurnDiffByEndResources,
} from "./projectless-output-scope";
import { describeThreadOutput, resolveThreadOutputOpenAction } from "./thread-output-presentation";
import {
  type ThreadSummaryPanelOutputRow,
  buildThreadSummaryPanelOutputRows,
  collectTurnEndResourcePaths,
  isThreadSummaryPanelImagePreviewableOutput,
  resolveThreadSummaryPanelOutputOpenTarget,
} from "./thread-summary-panel-output-model";
import type { McpToolCallResult, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";

describe("projectless output scope", () => {
  const MIXED_DIFF = [
    "diff --git a/output/inside.ts b/output/inside.ts",
    "--- a/output/inside.ts",
    "+++ b/output/inside.ts",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "diff --git a/output-other/outside.ts b/output-other/outside.ts",
    "--- a/output-other/outside.ts",
    "+++ b/output-other/outside.ts",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");

  describe("projectless output scope", () => {
    test("uses root-or-descendant matching instead of a string prefix", () => {
      const scope = {
        cwd: "/workspace",
        projectlessOutputDirectory: "output",
      };

      expect(
        isResourceInsideProjectlessOutputDirectory({
          ...scope,
          resourcePath: "output/file.ts",
        }),
      ).toBe(true);
      expect(
        isResourceInsideProjectlessOutputDirectory({
          ...scope,
          resourcePath: "output",
        }),
      ).toBe(true);
      expect(
        isResourceInsideProjectlessOutputDirectory({
          ...scope,
          resourcePath: "output-other/file.ts",
        }),
      ).toBe(false);
      expect(
        isResourceInsideProjectlessOutputDirectory({
          ...scope,
          resourcePath: "../output-other/file.ts",
        }),
      ).toBe(false);
    });

    test("filters unified diff blocks and keeps only projectless outputs", () => {
      const filtered = filterTurnDiffPayload(
        { unifiedDiff: MIXED_DIFF },
        {
          cwd: "/workspace",
          projectlessOutputDirectory: "/workspace/output",
        },
      );

      expect(filtered?.unifiedDiff).toContain("output/inside.ts");
      expect(filtered?.unifiedDiff).not.toContain("output-other/outside.ts");
      expect(
        collectTurnDiffChangedPaths(filtered ?? { unifiedDiff: "" }, {
          cwd: "/workspace",
          projectlessOutputDirectory: "/workspace/output",
        }),
      ).toEqual(["/workspace/output/inside.ts"]);
    });

    test("preserves a non-empty unscoped stale payload for Review empty-state handling", () => {
      const payload = filterTurnDiffPayload(
        {
          unifiedDiff: "diff payload retained but no renderable file entries",
        },
        {},
      );

      expect(payload?.unifiedDiff).toBe("diff payload retained but no renderable file entries");
    });

    test("supports patch-batch-only payloads and scopes apply data", () => {
      const filtered = filterTurnDiffPayload(
        {
          unifiedDiff: "",
          patchBatches: [
            {
              cwd: "/workspace",
              changes: [
                { path: "output/inside.ts", type: "add", content: "inside" },
                { path: "output-other/outside.ts", type: "add", content: "outside" },
              ],
            },
          ],
        },
        {
          cwd: "/workspace",
          projectlessOutputDirectory: "/workspace/output",
        },
      );

      expect(filtered?.unifiedDiff).toContain("output/inside.ts");
      expect(filtered?.unifiedDiff).not.toContain("output-other/outside.ts");
      expect(filtered?.patchBatches?.[0]?.changes).toHaveLength(1);
    });

    test("normalizes malformed patch-batch envelopes at the shared boundary", () => {
      const batches = normalizeTurnDiffPatchBatches([
        null,
        { cwd: 42, changes: "not-an-array" },
        { cwd: "/workspace", changes: [{ path: "output/file.ts", type: "add" }] },
      ]);

      expect(batches).toEqual([
        { cwd: null, changes: [] },
        { cwd: "/workspace", changes: [{ path: "output/file.ts", type: "add" }] },
      ]);
    });

    test("suppresses a turn card only when every changed path is an end resource", () => {
      const payload = filterTurnDiffPayload(
        { unifiedDiff: MIXED_DIFF },
        {
          cwd: "/workspace",
          projectlessOutputDirectory: "/workspace/output",
        },
      );
      if (!payload) throw new Error("Expected a scoped diff");

      expect(
        shouldSuppressTurnDiffByEndResources({
          payload,
          endResourcePaths: ["/workspace/output/inside.ts"],
          scope: { cwd: "/workspace", projectlessOutputDirectory: "/workspace/output" },
        }),
      ).toBe(true);
      expect(
        shouldSuppressTurnDiffByEndResources({
          payload,
          endResourcePaths: [],
          scope: { cwd: "/workspace", projectlessOutputDirectory: "/workspace/output" },
        }),
      ).toBe(false);
    });
  });
});

describe("thread output presentation", () => {
  const cwd = "/Users/ada/repo/nodex";

  function file(path: string, kind: "file" | "image" | "generated-image" = "file") {
    const label = path.slice(path.lastIndexOf("/") + 1);
    return { id: `${kind}:${path}`, kind, path, label, title: path } as const;
  }

  describe("describeThreadOutput", () => {
    test("names a generic entry file by its folder and locates it from the working directory", () => {
      expect(
        describeThreadOutput(
          file(`${cwd}/notes.local/artifacts/new-tab-page/report/index.html`),
          cwd,
        ),
      ).toEqual({
        title: "report/index.html",
        kind: "HTML",
        location: { head: "notes.local/artifacts/", tail: "new-tab-page" },
        iconPath: `${cwd}/notes.local/artifacts/new-tab-page/report/index.html`,
      });
    });

    test("spells locations outside the working directory from home and omits the working directory itself", () => {
      expect(describeThreadOutput(file("/Users/ada/Desktop/brief.pdf"), cwd)).toMatchObject({
        title: "brief.pdf",
        kind: "PDF",
        location: { head: "~/", tail: "Desktop" },
      });
      expect(describeThreadOutput(file(`${cwd}/summary.md`), cwd)).toMatchObject({
        title: "summary.md",
        kind: "Markdown",
        location: null,
      });
      expect(describeThreadOutput(file("/tmp/out/data.parquet"), cwd)).toMatchObject({
        kind: "PARQUET",
        location: { head: "/tmp/", tail: "out" },
      });
    });

    test("keeps a generic name bare when it has no named parent", () => {
      expect(describeThreadOutput(file("/index.html"), cwd)).toMatchObject({
        title: "index.html",
        location: { head: "", tail: "/" },
      });
    });

    test("reads images, generated images and files without an extension", () => {
      expect(describeThreadOutput(file(`${cwd}/shots/after.png`), cwd).kind).toBe("Image");
      expect(
        describeThreadOutput(
          {
            ...file(`${cwd}/.codex/generated/a.png`, "generated-image"),
            label: "Generated image 2",
          },
          cwd,
        ),
      ).toMatchObject({ title: "Generated image 2", kind: "Image" });
      expect(describeThreadOutput(file(`${cwd}/LICENSE`), cwd).kind).toBe("File");
    });

    test("describes web resources without a location or file artwork", () => {
      const website: ThreadSummaryPanelOutputRow = {
        id: "website:http://localhost:5173/",
        kind: "website",
        target: "http://localhost:5173/",
        label: "localhost:5173",
        title: "http://localhost:5173/",
      };
      expect(describeThreadOutput(website, cwd)).toEqual({
        title: "localhost:5173",
        kind: "Website",
        location: null,
        iconPath: null,
      });
      expect(
        describeThreadOutput(
          {
            id: "google-drive:x",
            kind: "google-drive",
            url: "https://docs.google.com/spreadsheets/d/x",
            resourceKind: "spreadsheet",
            label: "Q3 plan",
            title: "https://docs.google.com/spreadsheets/d/x",
          },
          cwd,
        ),
      ).toMatchObject({ title: "Q3 plan", kind: "Google Sheets", iconPath: null });
    });
  });

  describe("resolveThreadOutputOpenAction", () => {
    test("renders HTML in the default browser and images in the viewer on this device", () => {
      expect(resolveThreadOutputOpenAction(file(`${cwd}/report/index.html`), "local")).toEqual({
        type: "files",
        path: `${cwd}/report/index.html`,
      });
      expect(resolveThreadOutputOpenAction(file(`${cwd}/after.PNG`), "local")).toEqual({
        type: "files",
        path: `${cwd}/after.PNG`,
      });
      expect(resolveThreadOutputOpenAction(file(`${cwd}/notes.md`), "local")).toEqual({
        type: "files",
        path: `${cwd}/notes.md`,
      });
    });

    test("keeps every remote file in Files", () => {
      for (const path of ["/srv/app/index.html", "/srv/app/after.png", "/srv/app/notes.md"])
        expect(resolveThreadOutputOpenAction(file(path), "remote-host")).toEqual({
          type: "files",
          path,
        });
    });

    test("opens web resources as links", () => {
      expect(
        resolveThreadOutputOpenAction(
          {
            id: "appgen-app:p",
            kind: "appgen-app",
            projectId: "p",
            url: "https://app.example.com",
            label: "Example",
            title: "https://app.example.com",
          },
          "local",
        ),
      ).toEqual({ type: "web", url: "https://app.example.com" });
    });
  });
});

describe("thread summary panel output model", () => {
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
      status: "completed",
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

    test("keeps legacy assistant source references out of outputs", () => {
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

      expect(rows).toEqual([]);
    });

    test("marks generated images, image views, and image file references as previewable", () => {
      const rows = buildThreadSummaryPanelOutputRows([
        buildTurn([
          buildItem("assistant-1", "agentMessage", {
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            markdownText:
              ':codex-file-citation{path="/tmp/nodex/chart.webp"} [report](/tmp/nodex/report.pdf)',
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
      const report = rows.find((row) => outputPath(row) === "/tmp/nodex/report.pdf");
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
          pathStates: new Map(
            ["reports/summary.pdf", "reports/final.pdf"].map((relative) => {
              const path = `/repo/project/${relative}`;
              return [path, { path, exists: true, isGitSourcePath: false }];
            }),
          ),
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
                ':codex-file-citation{path="output/inside.pdf"}',
                ':codex-file-citation{path="outside/outside.pdf"}',
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
        "/repo/project/output/report.pdf,/repo/project/output/chart.png,/repo/project/output/inside.pdf",
      );
    });

    test("classifies a confirmed edited HTML deliverable as a file", () => {
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
          pathStates: new Map([
            [
              "/repo/project/dist/index.html",
              { path: "/repo/project/dist/index.html", exists: true, isGitSourcePath: false },
            ],
          ]),
        },
      );

      expect(rows.length).toBe(1);
      expect(rows[0]?.kind ?? "").toBe("file");
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
});
