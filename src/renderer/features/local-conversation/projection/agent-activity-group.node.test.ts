import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCommandAction,
  CodexConversationItem,
  CodexSemanticItemKind,
  ProtocolAppInfo,
} from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import type { ThreadTranscriptBlockModel } from "../thread-stage-types";
import {
  attachAutomaticApprovalReviewsToToolTargets,
  buildAgentActivityGroupSummaryFact,
  buildV2AgentActivityGroupBlock,
  collectAgentActivityGroupCanonicalFacts,
  resolveAgentActivityGroupActiveSummary,
} from "./agent-activity-group";

type ProtocolMcpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function buildEntry(id: string, overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    entryId: id,
    type: "commandExecution",
    kind: "commandExecution",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildBlock(
  id: string,
  type: ThreadTranscriptBlockModel["type"],
  overrides: Partial<CodexConversationItem> = {},
): ThreadTranscriptBlockModel {
  const semanticKind: CodexSemanticItemKind | undefined =
    type === "exec"
      ? "exec"
      : type === "webSearch"
        ? "webSearch"
        : type === "mcpServerElicitation"
          ? "mcpServerElicitation"
          : undefined;
  const entry = buildEntry(id, {
    semanticKind,
    ...overrides,
  });

  return {
    id,
    turnId: "turn-1",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    searchableText: entry.markdownText ?? "",
    type,
    status: entry.status,
    entry,
  };
}

function readAction(name: string): CodexCommandAction {
  return { type: "read", command: `cat ${name}`, name, path: name };
}

function mcpBlock(
  id: string,
  options: {
    server?: string;
    tool?: string;
    arguments?: ProtocolMcpToolCallItem["arguments"];
    pluginId?: string | null;
    mcpAppResourceUri?: string;
    source?: NonNullable<CodexConversationItem["mcpToolCall"]>["source"];
    status?: CodexConversationItem["status"];
    completed?: boolean;
    rawItem?: Record<string, unknown>;
  } = {},
): ThreadTranscriptBlockModel {
  const server = options.server ?? "browser-use";
  const tool = options.tool ?? "click";
  const status = options.status ?? "inProgress";
  const completed = options.completed ?? status !== "inProgress";
  const rawItem = options.rawItem;

  return buildBlock(id, "mcpToolCall", {
    kind: "toolCall",
    semanticKind: "mcpToolCall",
    status,
    rawItem,
    mcpToolCall: {
      callId: id,
      functionName: `${server}__${tool}`,
      pluginId: options.pluginId ?? null,
      readOnlyHint: null,
      mcpAppResourceUri: options.mcpAppResourceUri,
      source:
        options.source ??
        (server === "browser-use" ? { kind: "browserUse", backend: "iab" } : null),
      invocation: {
        server,
        tool,
        arguments: options.arguments ?? {},
      },
      result: null,
      durationMs: null,
      completed,
    },
  });
}

function mcpApp(id: string, name: string): ProtocolAppInfo {
  return {
    id,
    name,
    description: null,
    logoUrl: `${id}-light.png`,
    logoUrlDark: `${id}-dark.png`,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}

function approvalReview(
  id: string,
  targetItemId: string,
  status: "aborted" | "approved" | "denied" | "inProgress" | "timedOut",
): ThreadTranscriptBlockModel {
  return buildBlock(id, "automaticApprovalReview", {
    kind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: status === "inProgress" ? "inProgress" : "completed",
    rawItem: {
      id,
      targetItemId,
      review: {
        status,
        riskLevel: "high",
        userAuthorization: "unknown",
        rationale: status,
      },
    },
  });
}

describe("generic v2 agent activity group projection", () => {
  test("extracts summary facts directly from raw contiguous v2 leaves", () => {
    const facts = [
      buildAgentActivityGroupSummaryFact(
        buildBlock("create", "fileChange", {
          kind: "fileChange",
          semanticKind: "patch",
          status: "inProgress",
          fileChange: {
            changes: buildCodexFileChangeMap([
              { type: "add", path: "src/new.ts", content: "one\ntwo\n" },
            ]),
          },
        }),
      ),
      buildAgentActivityGroupSummaryFact(
        buildBlock("read", "exec", {
          commandActions: [readAction("src/app.ts")],
        }),
      ),
      buildAgentActivityGroupSummaryFact(
        buildBlock("search", "exec", {
          status: "inProgress",
          commandActions: [
            {
              type: "search",
              command: "rg parity",
              query: "parity",
              path: null,
            },
          ],
        }),
      ),
      buildAgentActivityGroupSummaryFact(
        buildBlock("list", "exec", {
          commandActions: [{ type: "listFiles", command: "ls src", path: "src" }],
        }),
      ),
      buildAgentActivityGroupSummaryFact(mcpBlock("mcp")),
      buildAgentActivityGroupSummaryFact(
        buildBlock("web", "webSearch", {
          webSearch: {
            query: "Nodex",
            action: null,
            completed: false,
            sources: [],
          },
          toolCall: {
            toolName: "web",
            subtype: "webSearch",
            result: { type: "search", query: "Nodex" },
          },
        }),
      ),
      buildAgentActivityGroupSummaryFact(approvalReview("denied", "missing", "denied")),
    ];

    expect(facts.map((fact) => fact.type).join(",")).toBe(
      "patch,exploration,exploration,exploration,mcpToolCall,webSearch,automaticApprovalReview",
    );
    expect(facts[0]?.type === "patch" ? facts[0].runningCreatedLineCount : 0).toBe(2);
    expect(facts[1]?.type === "exploration" ? Array.from(facts[1].readPaths).join(",") : "").toBe(
      "src/app.ts",
    );
    expect(facts[2]?.type === "exploration" ? facts[2].runningSearchCount : 0).toBe(1);
    expect(facts[3]?.type === "exploration" ? facts[3].listCount : 0).toBe(1);
    expect(facts[4]?.type === "mcpToolCall" ? (facts[4].source?.key ?? "") : "").toBe(
      "browser-use",
    );
    expect(facts[5]?.type === "webSearch" ? `${facts[5].count}:${facts[5].runningCount}` : "").toBe(
      "1:1",
    );
  });

  test("keeps immutable full items separate from filtered body and typed header evidence", () => {
    const patch = buildBlock("patch", "fileChange", {
      callId: "patch",
      kind: "fileChange",
      semanticKind: "patch",
      fileChange: {
        changes: buildCodexFileChangeMap([{ type: "add", path: "src/new.ts", content: "line\n" }]),
      },
    });
    const web = buildBlock("web", "webSearch", {
      toolCall: {
        toolName: "web",
        subtype: "webSearch",
        result: { type: "search", query: "Codex" },
      },
    });
    const mcp = mcpBlock("mcp", { status: "completed", completed: true });
    const block = buildV2AgentActivityGroupBlock([patch, web, mcp], "agent-activity-group:patch", {
      bodyEntries: [patch, web],
    });

    expect(block.type).toBe("agentActivityGroup");
    expect(block.renderKey).toBe("agent-activity-group:patch");
    expect(block.entries.map((entry) => entry.type).join(",")).toBe(
      "fileChange,webSearch,mcpToolCall",
    );
    expect(block.bodyEntries.map((entry) => entry.type).join(",")).toBe("fileChange,webSearch");
    expect(block.completedHeader.parts.map((part) => part.kind).join(",")).toBe(
      "mcpSources,fileChanges,webSearch",
    );
    expect(block.completedHeader.iconItem?.type).toBe("mcpToolCall");
    expect(block.header.kind).toBe("summary");
  });

  test("keeps every step's pictures on the group and names inspections in its summary", () => {
    const inspection = buildBlock("inspection", "imageView", {
      kind: "systemEvent",
      semanticKind: "imageView",
      stepImages: [
        { source: "copy-a", name: "before.png" },
        { source: "copy-b", name: "after.png" },
      ],
    });
    const screenshot = mcpBlock("screenshot", {
      server: "node_repl",
      tool: "js",
      status: "completed",
      completed: true,
    });
    screenshot.entry = { ...screenshot.entry, stepImages: [{ source: "tool-result-1" }] };
    const command = buildBlock("command", "exec", { command: "pnpm build" });
    const block = buildV2AgentActivityGroupBlock(
      [inspection, screenshot, command],
      "agent-activity-group:inspection",
    );

    // The group's pictures keep the order the steps brought them back in.
    expect(block.stepImages.map((image) => image.source)).toEqual([
      "copy-a",
      "copy-b",
      "tool-result-1",
    ]);
    // A script that took a screenshot still ran a command; the inspection is named as viewing.
    expect(block.completedHeader.parts).toEqual([
      { kind: "viewedImages", count: 2 },
      { kind: "commands", count: 2 },
    ]);
    expect(block.completedHeader.iconItem?.type).toBe("imageView");
  });

  test("keeps active state and completed header evidence on separate paths", () => {
    const runningCommand = buildBlock("run", "exec", {
      status: "inProgress",
      command: "pnpm test",
      commandActions: [{ type: "unknown", command: "pnpm test" }],
    });
    const completedPatch = buildBlock("patch-done", "fileChange", {
      kind: "fileChange",
      semanticKind: "patch",
      status: "completed",
      fileChange: {
        changes: buildCodexFileChangeMap([
          {
            type: "update",
            path: "src/done.ts",
            movePath: null,
            unifiedDiff: "@@ -1,1 +1,1 @@\n-old\n+new",
          },
        ]),
      },
    });

    const active = resolveAgentActivityGroupActiveSummary([runningCommand, completedPatch]);
    const completedActive = resolveAgentActivityGroupActiveSummary([completedPatch]);
    const completed = buildV2AgentActivityGroupBlock([completedPatch], "completed");

    expect(active?.label ?? "").toBe("Running pnpm test");
    expect(completedActive).toBe(null);
    expect(completed.header.kind).toBe("summary");
    expect(completed.completedHeader.parts).toEqual([{ kind: "fileChanges", count: 1 }]);
  });

  test("names live reads by their file and live folders relative to the command's folder", () => {
    const cwd = "/workspace/tinyboard";
    const label = (action: CodexCommandAction) =>
      resolveAgentActivityGroupActiveSummary([
        buildBlock(`live-${action.type}`, "exec", {
          status: "inProgress",
          cwd,
          command: action.command,
          commandActions: [action],
        }),
      ])?.label;

    expect(
      label({
        type: "read",
        command: "cat /workspace/tinyboard/src/tasks.js",
        name: "tasks.js",
        path: "/workspace/tinyboard/src/tasks.js",
      }),
    ).toBe("Reading tasks.js");
    expect(label({ type: "search", command: "rg x src", query: "x", path: `${cwd}/src` })).toBe(
      "Searching files in src folder",
    );
    expect(label({ type: "listFiles", command: "ls", path: cwd })).toBe(
      "Listing files in . folder",
    );
    expect(label({ type: "listFiles", command: "ls /tmp", path: "/tmp" })).toBe(
      "Listing files in /tmp folder",
    );
  });

  test("resolves MCP active headers from app identity, operation, and invocation context", () => {
    const app = mcpApp("connector_notion", "Notion");
    const item = mcpBlock("notion-search", {
      server: "notion_mcp_server",
      tool: "notion_mcp_server_search",
      arguments: { query: "quarterly roadmap" },
      completed: false,
      status: "inProgress",
    });

    const active = resolveAgentActivityGroupActiveSummary([item], [app]);

    expect(active?.label).toBe('Searching Notion "quarterly roadmap"');
  });

  test("deduplicates repeated file paths while preserving aggregate line counts", () => {
    const edits = Array.from({ length: 5 }, (_, index) =>
      buildBlock(`edit-${index}`, "fileChange", {
        kind: "fileChange",
        semanticKind: "patch",
        fileChange: {
          changes: buildCodexFileChangeMap([
            {
              type: "update",
              path: "src/app.ts",
              movePath: null,
              unifiedDiff: `@@ -1,1 +1,1 @@\n-old ${index}\n+new ${index}`,
            },
          ]),
        },
      }),
    );
    const facts = collectAgentActivityGroupCanonicalFacts(edits);
    const block = buildV2AgentActivityGroupBlock(edits, "deduplicated-edits");

    expect(facts.editedFileCount).toBe(1);
    expect(facts.changedLineCount).toBe(10);
    expect(block.completedHeader.parts).toEqual([{ kind: "fileChanges", count: 1 }]);
  });

  test("preserves MCP source identity and native-app metadata in group facts", () => {
    const facts = collectAgentActivityGroupCanonicalFacts([
      mcpBlock("browser-running", {
        status: "inProgress",
        source: { kind: "browserUse", backend: "chrome" },
      }),
      mcpBlock("preview", {
        server: "computer-use",
        tool: "type_text",
        status: "completed",
        arguments: { target_app_name: "Preview", text: "hello" },
      }),
      mcpBlock("node", {
        server: "node_repl",
        tool: "js",
        status: "completed",
      }),
    ]);

    expect(
      facts.mcpToolCallSources
        .map((source) => `${source.key}:${source.count}:${source.runningCount}`)
        .join("|"),
    ).toBe("browser-use:chrome:1:1|native-app:Preview:1:0|server:node_repl:1:0");
    expect(JSON.stringify(facts.mcpToolCallSources[1]?.nativeAppReference ?? null)).toBe(
      '{"kind":"displayName","displayName":"Preview"}',
    );
  });

  test("reprojects grouped MCP identity when late AppInfo becomes available", () => {
    const entries = [mcpBlock("docs", { server: "docs", status: "completed" })];
    const unresolved = collectAgentActivityGroupCanonicalFacts(entries);
    const resolved = collectAgentActivityGroupCanonicalFacts(entries, [
      mcpApp("connector_docs", "Docs"),
    ]);

    expect(unresolved.mcpToolCallSources[0]?.key).toBe("server:docs");
    expect(resolved.mcpToolCallSources[0]?.key).toBe("app:connector_docs");
    expect(resolved.mcpToolCallSources[0]?.logoUrl).toBe("connector_docs-light.png");
  });

  test("attaches reviews by canonical tool identity before summary folding", () => {
    const patch = buildBlock("patch", "fileChange", {
      callId: "patch-call",
      kind: "fileChange",
      semanticKind: "patch",
      fileChange: {
        changes: buildCodexFileChangeMap([{ type: "add", path: "src/app.ts", content: "line\n" }]),
      },
    });
    const exec = buildBlock("exec", "exec", {
      commandExecutionItemId: "exec-call",
      commandActions: [readAction("src/app.ts")],
    });
    const mcp = mcpBlock("mcp-call", { status: "completed", completed: true });
    const attached = attachAutomaticApprovalReviewsToToolTargets([
      patch,
      approvalReview("patch-denied", "patch-call", "denied"),
      exec,
      approvalReview("exec-approved", "exec-call", "approved"),
      mcp,
      approvalReview("mcp-timeout", "mcp-call", "timedOut"),
    ]);

    const attachedPatch = attached.find((entry) => entry.type === "fileChange");
    const attachedExec = attached.find((entry) => entry.type === "exec");
    const attachedMcp = attached.find((entry) => entry.type === "mcpToolCall");
    const facts = collectAgentActivityGroupCanonicalFacts(
      attached.filter((entry): entry is ThreadTranscriptBlockModel => "entry" in entry),
    );

    expect(attached.map((entry) => entry.type).join(",")).toBe("fileChange,exec,mcpToolCall");
    expect(
      attachedPatch?.type === "fileChange"
        ? (attachedPatch.automaticApprovalReviews?.length ?? 0)
        : 0,
    ).toBe(1);
    expect(
      attachedExec?.type === "exec" ? (attachedExec.automaticApprovalReviews?.length ?? 0) : 0,
    ).toBe(1);
    expect(
      attachedMcp?.type === "mcpToolCall" ? (attachedMcp.automaticApprovalReviews?.length ?? 0) : 0,
    ).toBe(1);
    expect(`${facts.deniedRequestCount}:${facts.timedOutRequestCount}`).toBe("1:1");
  });

  test("does not attach reviews through non-canonical transcript ids", () => {
    const command = buildBlock("item-id-only", "exec", {
      command: "pnpm test",
      commandActions: [],
    });
    const review = approvalReview("review", "item-id-only", "denied");
    const attached = attachAutomaticApprovalReviewsToToolTargets([command, review]);

    expect(attached.map((entry) => entry.type).join(",")).toBe("exec,automaticApprovalReview");
    expect(
      attached[0]?.type === "exec" ? (attached[0].automaticApprovalReviews?.length ?? 0) : 0,
    ).toBe(0);
  });
});
