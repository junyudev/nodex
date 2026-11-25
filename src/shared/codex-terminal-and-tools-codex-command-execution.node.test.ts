import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexCommandApprovalPreview,
  formatCodexExecPolicyAmendmentCommand,
  formatCodexExecPolicyAmendmentMenuSummary,
  getDisplayCommand,
} from "./codex-command-execution";
import type {
  CodexApprovalRequest,
  CodexFileChangeMap,
  CodexProtocolRequestId,
  CodexTurnDiffPatchBatch,
  CodexMcpServerElicitationRequest,
} from "./types";
import { resolveCodexFileChangeActivity } from "./codex-file-change-activity";
import {
  buildCodexFileChangeFromProtocol,
  buildCodexFileChangeMap,
  buildCodexFileChangePatchRows,
  buildCodexFileChangeUnifiedDiff,
  buildCodexTurnDiffFromPatchBatches,
  getCodexFileChangeEntries,
  getCodexFileChangePaths,
  hasCodexFileChangeEntries,
  resolveCodexFileChangeDisplayStatus,
  resolveCodexPatchSuccess,
  stripCodexVisualizationDiffBlocks,
  summarizeCodexFileChangePatch,
  summarizeCodexUnifiedDiff,
} from "./codex-file-change";
import {
  buildCodexMcpElicitationFormModel,
  buildCodexMcpServerElicitationResponse,
  createInitialCodexMcpElicitationFormValues,
  isRenderableMcpServerElicitationRequest,
  normalizeCodexMcpServerElicitationMode,
  normalizeCodexMcpServerElicitationResponse,
  validateCodexMcpElicitationFormValues,
} from "./codex-mcp-elicitation";

describe("codex command execution", () => {
  function buildCommandRequest(overrides?: Partial<CodexApprovalRequest>): CodexApprovalRequest {
    return {
      type: "approval",
      requestId: "approval-1",
      kind: "command",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      createdAt: 1,
      ...overrides,
    };
  }

  describe("codex command execution helpers", () => {
    test("keeps command display unwrapping available from the shared command model", () => {
      expect(getDisplayCommand("/bin/zsh -lc 'echo hello'")).toBe("echo hello");
      expect(getDisplayCommand("git status --short")).toBe("git status --short");
    });

    test("builds command approval previews from command action commands first", () => {
      const preview = buildCodexCommandApprovalPreview(
        buildCommandRequest({
          command: "bash -lc 'cat package.json'",
          commandActions: [
            {
              type: "read",
              command: "cat package.json",
              name: "package.json",
              path: "package.json",
            },
            { type: "search", command: "rg TODO src", query: "TODO", path: "src" },
          ],
          cmd: ["legacy", "fallback"],
        }),
      );

      expect(preview?.kind ?? "").toBe("command");
      expect(preview?.kind === "command" ? preview.commandText : "").toBe(
        "cat package.json && rg TODO src",
      );
    });

    test("falls back to an Electron-style execpolicy amendment command", () => {
      const preview = buildCodexCommandApprovalPreview(
        buildCommandRequest({
          proposedExecpolicyAmendment: ["git", "commit", "-m", "hello world"],
        }),
      );

      expect(formatCodexExecPolicyAmendmentCommand(["git", "commit", "-m", "hello world"])).toBe(
        'git commit -m "hello world"',
      );
      expect(preview?.kind === "command" ? preview.commandText : "").toBe(
        'git commit -m "hello world"',
      );
    });

    test("keeps multiline execpolicy amendments out of compact menu descriptions", () => {
      expect(
        formatCodexExecPolicyAmendmentMenuSummary(["bash", "-lc", "echo one\necho two"]) ?? "",
      ).toBe("");
    });

    test("builds network approval previews without requiring command text", () => {
      const preview = buildCodexCommandApprovalPreview(
        buildCommandRequest({
          networkApprovalContext: {
            host: "api.example.com",
            protocol: "https",
          },
        }),
      );

      expect(preview?.kind ?? "").toBe("network");
      expect(preview?.kind === "network" ? preview.reason : "").toBe(
        "Reason: api.example.com isn't on the current network allowlist",
      );
    });
  });
});

describe("resolveCodexFileChangeActivity", () => {
  test("keeps empty lifecycle state while suppressing semantic activity", () => {
    const activity = resolveCodexFileChangeActivity({
      status: "inProgress",
      fileChange: { changes: {} },
    });

    expect(activity).toMatchObject({
      visibility: "suppressed",
      lifecycle: "inProgress",
      success: null,
      hasMaterializedChanges: false,
      canExpandBody: false,
      displayPaths: [],
    });
  });

  test("suppresses empty terminal rows but keeps materialized rows", () => {
    expect(
      resolveCodexFileChangeActivity({
        status: "completed",
        fileChange: { changes: {} },
      }).visibility,
    ).toBe("suppressed");

    expect(
      resolveCodexFileChangeActivity({
        status: "completed",
        fileChange: {
          changes: {
            "src/app.ts": {
              type: "update",
              unifiedDiff: "@@ -1 +1 @@",
              movePath: null,
            },
          },
        },
      }).visibility,
    ).toBe("terminal");
  });
});

describe("codex file change", () => {
  function countDiffGitSections(diff: string, path: string): number {
    return diff.split("\n").filter((line) => line === `diff --git a/${path} b/${path}`).length;
  }

  describe("codex file change turn diff synthesis", () => {
    test("strips visualization blocks while preserving ordinary turn diff blocks", () => {
      const ordinary = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
      const visualization = [
        "diff --git a/.codex/visualizations/2026/07/11/thread/chart.html b/.codex/visualizations/2026/07/11/thread/chart.html",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/.codex/visualizations/2026/07/11/thread/chart.html",
        "@@ -0,0 +1 @@",
        "+<html></html>",
        "",
      ].join("\n");

      expect(stripCodexVisualizationDiffBlocks(`${ordinary}${visualization}`)).toBe(ordinary);
    });

    test("folds repeated update changes for the same cwd and path into one diff section", () => {
      const batches: CodexTurnDiffPatchBatch[] = [
        {
          cwd: "/repo",
          changes: [
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+intermediate",
            },
          ],
        },
        {
          cwd: "/repo",
          changes: [
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3 +3 @@\n-before\n+final",
            },
          ],
        },
      ];

      const diff = buildCodexTurnDiffFromPatchBatches(batches);

      expect(countDiffGitSections(diff, "src/app.ts")).toBe(1);
      expect(diff.includes("+intermediate")).toBe(true);
      expect(diff.includes("+final")).toBe(true);
      expect(diff.endsWith("\n")).toBe(true);
    });

    test("keeps identical paths in different cwd scopes separate", () => {
      const batches: CodexTurnDiffPatchBatch[] = [
        {
          cwd: "/repo-a",
          changes: [
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: "@@ -1 +1 @@\n-a\n+b",
            },
          ],
        },
        {
          cwd: "/repo-b",
          changes: [
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: "@@ -1 +1 @@\n-c\n+d",
            },
          ],
        },
      ];

      const diff = buildCodexTurnDiffFromPatchBatches(batches);

      expect(countDiffGitSections(diff, "src/app.ts")).toBe(2);
    });

    test("does not merge add delete or moved update sections into ordinary updates", () => {
      const batches: CodexTurnDiffPatchBatch[] = [
        {
          cwd: "/repo",
          changes: [
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
            },
            {
              type: "add",
              path: "src/app.ts",
              content: "created\n",
            },
            {
              type: "update",
              path: "src/app.ts",
              movePath: "src/old-app.ts",
              unifiedDiff: "@@ -1 +1 @@\n-before\n+after",
            },
          ],
        },
      ];

      const diff = buildCodexTurnDiffFromPatchBatches(batches);

      expect(countDiffGitSections(diff, "src/app.ts")).toBe(2);
      expect(diff.includes("diff --git a/src/app.ts b/src/old-app.ts")).toBe(true);
    });

    test("ignores empty invalid changes and returns an empty diff for no material patches", () => {
      const batches: CodexTurnDiffPatchBatch[] = [
        {
          cwd: "/repo",
          changes: [
            { type: "update", path: "src/app.ts", movePath: null, unifiedDiff: "" },
            { type: "unknown", path: "src/app.ts", content: "ignored" },
            null,
          ],
        },
      ];

      expect(buildCodexTurnDiffFromPatchBatches(batches)).toBe("");
    });

    test("builds path-keyed patch maps with duplicate paths overwriting earlier changes", () => {
      const changes = buildCodexFileChangeMap([
        {
          path: "src/app.ts",
          type: "add",
          content: "first\n",
        },
        {
          path: "src/app.ts",
          type: "update",
          movePath: null,
          unifiedDiff: "@@ -1 +1 @@\n-first\n+second",
        },
      ]);
      const entries = getCodexFileChangeEntries(changes);

      expect(entries.length).toBe(1);
      expect(entries[0]?.[0] ?? "").toBe("src/app.ts");
      expect(entries[0]?.[1].type ?? "").toBe("update");
      expect(getCodexFileChangePaths(changes).join(",")).toBe("src/app.ts");
    });

    test("builds canonical patch rows from the path-keyed map for thread and request previews", () => {
      const changes = buildCodexFileChangeMap([
        {
          path: "src/app.ts",
          type: "add",
          content: "first\n",
        },
        {
          path: "src/app.ts",
          type: "update",
          movePath: null,
          unifiedDiff: ["@@ -1,2 +1,3 @@", " keep", "-first", "+second", "+third"].join("\n"),
        },
      ]);

      const rows = buildCodexFileChangePatchRows(changes);
      const summary = summarizeCodexFileChangePatch(changes);

      expect(rows.length).toBe(1);
      expect(rows[0]?.key ?? "").toBe("src/app.ts");
      expect(rows[0]?.action ?? "").toBe("edit");
      expect(rows[0]?.summary?.additions ?? -1).toBe(2);
      expect(rows[0]?.summary?.deletions ?? -1).toBe(1);
      expect(summary?.fileCount ?? -1).toBe(1);
      expect(summary?.additions ?? -1).toBe(2);
      expect(summary?.deletions ?? -1).toBe(1);
      expect(summary?.firstPath ?? "").toBe("src/app.ts");
      expect(summary?.hasChanges ?? false).toBe(true);
    });

    test("keeps empty update diffs as renderable patch rows", () => {
      const change = buildCodexFileChangeFromProtocol({
        path: "src/app.ts",
        kind: "update",
        diff: "",
      });
      const diff = change ? buildCodexFileChangeUnifiedDiff(change) : null;

      expect(change?.type ?? null).toBe("update");
      expect(diff?.startsWith("diff --git a/src/app.ts b/src/app.ts") ?? false).toBe(true);
      expect(diff?.includes("--- a/src/app.ts\n+++ b/src/app.ts") ?? false).toBe(true);
    });

    test("keeps binary-looking add payloads out of textual unified diffs", () => {
      const change = buildCodexFileChangeFromProtocol({
        path: "assets/logo.png",
        kind: "add",
        diff: "\u0000PNG\r\n\u001a\nbinary-data",
      });
      const changes = change ? buildCodexFileChangeMap([change]) : {};
      const rows = buildCodexFileChangePatchRows(changes);
      const turnDiff = buildCodexTurnDiffFromPatchBatches([
        { cwd: "/repo", changes: change ? [change] : [] },
      ]);

      expect(change?.type ?? "").toBe("nonRenderable");
      expect(rows.length).toBe(1);
      expect(rows[0]?.unifiedDiff).toBe(null);
      expect(rows[0]?.safety?.skipReason ?? "").toBe("binary");
      expect(turnDiff).toBe("");
    });

    test("keeps oversized add payloads as metadata-only patch rows", () => {
      const change = buildCodexFileChangeFromProtocol({
        path: "logs/debug.txt",
        kind: "add",
        diff: "a".repeat(1024 * 1024 + 1),
      });
      const changes = change ? buildCodexFileChangeMap([change]) : {};
      const summary = summarizeCodexFileChangePatch(changes);

      expect(change?.type ?? "").toBe("nonRenderable");
      expect(change?.type === "nonRenderable" ? change.safety.skipReason : "").toBe("tooLarge");
      expect(summary?.fileCount ?? 0).toBe(1);
      expect(summary?.hasChanges ?? false).toBe(true);
    });

    test("filters non-canonical patch map entries before rendering", () => {
      const malformedMap = {
        "src/good.ts": { type: "add", content: "ok\n" },
        "": { type: "add", content: "missing path\n" },
        "0": { path: "src/raw.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@" },
      } as unknown as CodexFileChangeMap;
      const rawProtocolArray = [
        { path: "src/raw.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@" },
      ] as unknown as CodexFileChangeMap;

      const entries = getCodexFileChangeEntries(malformedMap);

      expect(entries.length).toBe(1);
      expect(entries[0]?.[0] ?? "").toBe("src/good.ts");
      expect(hasCodexFileChangeEntries(malformedMap)).toBe(true);
      expect(getCodexFileChangeEntries(rawProtocolArray).length).toBe(0);
      expect(hasCodexFileChangeEntries(rawProtocolArray)).toBe(false);
    });

    test("builds Codex-style unified diffs from patch map entries", () => {
      const movedDiff = buildCodexFileChangeUnifiedDiff("src/app.ts", {
        type: "update",
        movePath: "src/app-renamed.ts",
        unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
      });
      const emptyCreateDiff = buildCodexFileChangeUnifiedDiff("empty.txt", {
        type: "add",
        content: "",
      });

      expect(Boolean(movedDiff?.startsWith("diff --git a/src/app.ts b/src/app-renamed.ts"))).toBe(
        true,
      );
      expect(Boolean(movedDiff?.includes("--- a/src/app.ts\n+++ b/src/app-renamed.ts"))).toBe(true);
      expect(Boolean(emptyCreateDiff?.includes("new file mode 100644"))).toBe(true);
      expect(Boolean(emptyCreateDiff?.includes("@@"))).toBe(false);
    });

    test("summarizes unified diffs from the same Codex helper used for row body and copy text", () => {
      const diff = buildCodexFileChangeUnifiedDiff("src/app.ts", {
        type: "update",
        movePath: null,
        unifiedDiff: ["@@ -10,2 +10,3 @@", " keep", "-old", "+new", "+extra"].join("\n"),
      });
      const summary = summarizeCodexUnifiedDiff(diff);

      expect(summary?.additions ?? -1).toBe(2);
      expect(summary?.deletions ?? -1).toBe(1);
      expect(summary?.openLine ?? -1).toBe(10);
    });

    test("falls back to line-scan stats with open line 1 when diff parsing fails", () => {
      const summary = summarizeCodexUnifiedDiff(
        ["not a unified diff", "+added", "-removed"].join("\n"),
      );

      expect(summary?.additions ?? -1).toBe(1);
      expect(summary?.deletions ?? -1).toBe(1);
      expect(summary?.openLine ?? -1).toBe(1);
    });

    test("keeps empty but parseable file diffs openable at line 1", () => {
      const diff = buildCodexFileChangeUnifiedDiff("empty.txt", {
        type: "add",
        content: "",
      });
      const summary = summarizeCodexUnifiedDiff(diff);

      expect(summary?.additions ?? -1).toBe(0);
      expect(summary?.deletions ?? -1).toBe(0);
      expect(summary?.openLine ?? -1).toBe(1);
    });

    test("maps file-change item status to patch success", () => {
      expect(resolveCodexPatchSuccess("inProgress")).toBe(null);
      expect(resolveCodexPatchSuccess("completed")).toBe(true);
      expect(resolveCodexPatchSuccess("failed")).toBe(false);
      expect(resolveCodexPatchSuccess("declined")).toBe(false);
    });

    test("maps file-change lifecycle to Codex Electron display status precedence", () => {
      const cases: Array<{
        success: boolean | null | undefined;
        approvalRequestId: CodexProtocolRequestId | null | undefined;
        isTurnCancelled: boolean;
        expected: string;
      }> = [
        { success: true, approvalRequestId: null, isTurnCancelled: false, expected: "applied" },
        {
          success: true,
          approvalRequestId: "approval-1",
          isTurnCancelled: true,
          expected: "applied",
        },
        { success: false, approvalRequestId: null, isTurnCancelled: false, expected: "rejected" },
        {
          success: false,
          approvalRequestId: "approval-1",
          isTurnCancelled: true,
          expected: "rejected",
        },
        {
          success: null,
          approvalRequestId: "approval-1",
          isTurnCancelled: false,
          expected: "pending",
        },
        { success: undefined, approvalRequestId: 73, isTurnCancelled: false, expected: "pending" },
        { success: null, approvalRequestId: "", isTurnCancelled: true, expected: "pending" },
        { success: null, approvalRequestId: null, isTurnCancelled: true, expected: "stopped" },
        {
          success: undefined,
          approvalRequestId: undefined,
          isTurnCancelled: true,
          expected: "stopped",
        },
        { success: null, approvalRequestId: null, isTurnCancelled: false, expected: "streaming" },
        {
          success: undefined,
          approvalRequestId: undefined,
          isTurnCancelled: false,
          expected: "streaming",
        },
      ];

      for (const input of cases) {
        expect(resolveCodexFileChangeDisplayStatus(input)).toBe(input.expected);
      }
    });
  });
});

describe("isRenderableMcpServerElicitationRequest", () => {
  test("canonicalizes the legacy OpenAI form spelling at state boundaries", () => {
    expect(normalizeCodexMcpServerElicitationMode("openaiForm")).toBe("openai/form");
    expect(normalizeCodexMcpServerElicitationMode("openai/form")).toBe("openai/form");
    expect(normalizeCodexMcpServerElicitationMode("form")).toBe("form");
    expect(normalizeCodexMcpServerElicitationMode("url")).toBe("url");
  });

  test("does not project device user verification into the generic elicitation UI", () => {
    expect(
      isRenderableMcpServerElicitationRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps",
        environmentId: null,
        mode: "openai/userVerification",
        _meta: null,
        title: "Approve",
        description: "Verify this action",
        challenge: "AQID",
      }),
    ).toBe(false);
  });

  test("declines invalid url-mode elicitations before they enter the request plane", () => {
    expect(
      isRenderableMcpServerElicitationRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser",
        environmentId: null,
        mode: "url",
        _meta: null,
        message: "Open this URL?",
        url: "http://example.test",
        elicitationId: "elicitation-1",
      }),
    ).toBe(false);
  });

  test("accepts ordinary https url-mode elicitations", () => {
    expect(
      isRenderableMcpServerElicitationRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser",
        environmentId: null,
        mode: "url",
        _meta: null,
        message: "Open this URL?",
        url: "https://example.test/path",
        elicitationId: "elicitation-1",
      }),
    ).toBe(true);
  });

  test("requires Codex Apps auth failure metadata on ChatGPT hosts", () => {
    const base = {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "codex_apps",
      environmentId: null,
      mode: "url" as const,
      message: "Connect the app?",
      url: "https://chatgpt.com/connect",
      elicitationId: "elicitation-1",
    };

    expect(
      isRenderableMcpServerElicitationRequest({
        ...base,
        _meta: null,
      }),
    ).toBe(false);
    expect(
      isRenderableMcpServerElicitationRequest({
        ...base,
        _meta: {
          _codex_apps: {
            connector_auth_failure: {
              is_auth_failure: true,
              connector_id: "gmail",
              connector_name: "Gmail",
              install_url: "https://chatgpt.com/connect/gmail",
              requested_scopes: ["mail.read"],
            },
          },
        },
      }),
    ).toBe(true);
  });

  test("normalizes action-only and contentful MCP elicitation responses", () => {
    expect(JSON.stringify(normalizeCodexMcpServerElicitationResponse("decline"))).toBe(
      JSON.stringify({
        action: "decline",
        content: null,
        _meta: null,
      }),
    );
    expect(JSON.stringify(normalizeCodexMcpServerElicitationResponse("accept"))).toBe(
      JSON.stringify({
        action: "accept",
        content: {},
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("accept", {
          library: "react",
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "accept",
        content: {
          library: "react",
        },
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("decline", {
          ignored: true,
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "decline",
        content: null,
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("cancel", {
          ignored: true,
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "cancel",
        content: null,
        _meta: null,
      }),
    );
  });

  test("builds and validates typed form elicitation content", () => {
    const request: CodexMcpServerElicitationRequest = {
      type: "mcpServerElicitation",
      requestId: "mcp-1",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "generic",
      mode: "form",
      serverName: "Context7",
      message: "Choose docs",
      requestedSchema: {
        type: "object",
        required: ["library"],
        properties: {
          library: {
            type: "string",
            title: "Library",
            minLength: 1,
          },
          includeExamples: {
            type: "boolean",
            title: "Include examples",
            default: true,
          },
          depth: {
            type: "integer",
            title: "Depth",
            default: 2,
            minimum: 1,
            maximum: 5,
          },
          sections: {
            type: "array",
            title: "Sections",
            items: {
              type: "string",
              enum: ["api", "guides"],
            },
            default: ["api"],
          },
        },
      },
      createdAt: 1,
    };

    const model = buildCodexMcpElicitationFormModel(request);
    expect(model?.kind).toBe("supported");
    if (model?.kind !== "supported") throw new Error("expected supported form model");

    const initial = createInitialCodexMcpElicitationFormValues(model.fields);
    expect(JSON.stringify(initial)).toBe(
      JSON.stringify({
        library: "",
        includeExamples: true,
        depth: "2",
        sections: ["api"],
      }),
    );

    const invalid = validateCodexMcpElicitationFormValues(model.fields, initial);
    expect(JSON.stringify(invalid.invalidFieldNames)).toBe(JSON.stringify(["library"]));
    expect(invalid.content).toBe(null);

    const valid = validateCodexMcpElicitationFormValues(model.fields, {
      ...initial,
      library: "react",
      depth: "3",
      sections: ["guides"],
    });
    expect(JSON.stringify(valid.content)).toBe(
      JSON.stringify({
        library: "react",
        includeExamples: true,
        depth: 3,
        sections: ["guides"],
      }),
    );
  });

  test("marks unsupported OpenAI forms instead of pretending JSON is approvable content", () => {
    const model = buildCodexMcpElicitationFormModel({
      type: "mcpServerElicitation",
      requestId: "mcp-1",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "generic",
      mode: "openai/form",
      serverName: "Context7",
      message: "Unsupported",
      requestedSchema: {
        type: "object",
        properties: {
          nested: {
            type: "object",
          },
        },
      },
      createdAt: 1,
    });

    expect(model?.kind).toBe("unsupported");
  });
});
