import { describe, expect, test } from "vite-plus/test";
import type {
  ThreadAgentActivityClassification,
  ThreadAgentActivityUnit,
  ThreadIndexedAgentActivityItem,
} from "../thread-stage-types";
import {
  buildThreadAgentActivityTargetAttribute,
  buildThreadAgentActivityUnitContexts,
  buildThreadAgentActivityUnits,
  collectThreadAgentActivityTargetIds,
  classifyThreadAgentActivityItem,
  classifyThreadDynamicActivityItem,
  classifyThreadMcpActivityItem,
  classifyThreadExecPatchWebActivityItem,
  createThreadAgentActivityItem,
  filterThreadAgentActivityGroupBodyItems,
  isThreadAgentActivityGroup,
  projectThreadIndexedAgentActivityItems,
  removeApprovedThreadAutomaticApprovalReviews,
  resolveThreadVisualizationCommandKind,
  resolveThreadAgentActivityVisibility,
  resolveThreadAgentActivityIdentity,
  resolveThreadPrimaryActivitySliceClosed,
  type ThreadClassifiableActivityTranscriptType,
  type ThreadAgentActivityVisibility,
} from "./agent-activity-v2";
import type {
  CodexConversationItem,
  CodexMcpToolCallSource,
  ProtocolListMcpServerStatusResponse,
} from "../../../lib/types";
import type { ThreadTranscriptBlockModel } from "../thread-stage-types";

interface FixtureItem {
  id: string;
  type: "exec" | "message";
}

const execItem: FixtureItem = { id: "exec-1", type: "exec" };
const messageItem: FixtureItem = { id: "message-1", type: "message" };

function buildConversationItem(
  itemId: string,
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    type: overrides.type ?? "fixture",
    kind: overrides.kind ?? "systemEvent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildTranscriptBlock(
  type: "exec" | "fileChange" | "webSearch",
  overrides: Partial<ThreadTranscriptBlockModel> = {},
): ThreadTranscriptBlockModel & { type: "exec" | "fileChange" | "webSearch" } {
  const defaultEntry =
    type === "fileChange"
      ? buildConversationItem(`${type}-1`, {
          status: "completed",
          fileChange: {
            changes: {
              "src/app.ts": {
                type: "update",
                unifiedDiff: "@@ -1 +1 @@",
                movePath: null,
              },
            },
            success: true,
          },
        })
      : buildConversationItem(`${type}-1`);
  return {
    id: `${type}-1`,
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: "",
    entry: defaultEntry,
    ...overrides,
    type,
  };
}

function buildMcpBlock(
  input: {
    server?: string;
    source?: CodexMcpToolCallSource | null;
    mcpAppResourceUri?: string;
    result?: NonNullable<CodexConversationItem["mcpToolCall"]>["result"];
    superseded?: boolean;
  } = {},
) {
  const entry = buildConversationItem("mcp-1", {
    mcpToolCall: {
      callId: "mcp-1",
      functionName: `${input.server ?? "docs"}__search`,
      pluginId: null,
      readOnlyHint: null,
      mcpAppResourceUri: input.mcpAppResourceUri,
      source: input.source ?? null,
      invocation: {
        server: input.server ?? "docs",
        tool: "search",
        arguments: {},
      },
      result: input.result ?? null,
      durationMs: null,
      completed: true,
    },
  }) as CodexConversationItem & { mcpToolCall: NonNullable<CodexConversationItem["mcpToolCall"]> };
  return {
    ...buildTranscriptBlock("exec", { entry }),
    type: "mcpToolCall" as const,
    entry,
    ...(input.superseded ? { isMcpAppWidgetSuperseded: true } : {}),
  };
}

function buildMcpStatuses(resourceUri: string): ProtocolListMcpServerStatusResponse {
  return {
    data: [
      {
        name: "docs",
        pluginId: null,
        serverInfo: null,
        tools: {
          search: {
            name: "search",
            inputSchema: { type: "object" },
            _meta: { ui: { resourceUri } },
          },
        },
        resources: [],
        resourceTemplates: [],
        runtimeStatus: "connected",
        authStatus: "unsupported",
      },
    ],
    nextCursor: null,
  };
}

function buildDynamicBlock(input: { namespace?: string; tool: string; completed?: boolean }) {
  const dynamicToolCall = {
    callId: `dynamic-${input.tool}`,
    namespace: input.namespace ?? "codex_app",
    tool: input.tool,
    arguments: input.tool === "setup_codex_step" ? { step: "complete" } : {},
    status: input.completed === false ? ("inProgress" as const) : ("completed" as const),
    contentItems: null,
    success: true,
    durationMs: 1,
    completed: input.completed !== false,
  };
  const entry = buildConversationItem(dynamicToolCall.callId, { dynamicToolCall });
  return {
    ...buildTranscriptBlock("exec", { entry }),
    type: "dynamicToolCall" as const,
    entry: entry as CodexConversationItem & { dynamicToolCall: typeof dynamicToolCall },
  };
}

function buildClassifiableBlock(
  type: ThreadClassifiableActivityTranscriptType,
  overrides: Partial<ThreadTranscriptBlockModel> = {},
) {
  const baseType = type === "fileChange" || type === "webSearch" ? type : "exec";
  return {
    ...buildTranscriptBlock(baseType, overrides),
    id: `${type}-1`,
    type,
  } as ThreadTranscriptBlockModel & { type: ThreadClassifiableActivityTranscriptType };
}

describe("agent activity v2 type boundary", () => {
  test("represents every classifier visibility without copying the source item", () => {
    const cases = [
      {
        expected: "hidden",
        classification: null,
      },
      {
        expected: "groupable",
        classification: createThreadAgentActivityItem(execItem, "groupable"),
      },
      {
        expected: "standalone",
        classification: createThreadAgentActivityItem(messageItem, "standalone"),
      },
    ] satisfies readonly {
      expected: ThreadAgentActivityVisibility;
      classification: ThreadAgentActivityClassification<FixtureItem>;
    }[];

    expect(
      cases
        .map(({ classification }) => resolveThreadAgentActivityVisibility(classification))
        .join(","),
    ).toBe("hidden,groupable,standalone");
    expect(cases[1]?.classification?.item === execItem).toBe(true);
    expect(cases[2]?.classification?.item === messageItem).toBe(true);
  });

  test("keeps source indexes transient and final units index-free", () => {
    const classifiedExec = createThreadAgentActivityItem(execItem, "groupable");
    const indexed = {
      activityItem: classifiedExec,
      sourceIndex: 7,
    } satisfies ThreadIndexedAgentActivityItem<FixtureItem>;
    const units: readonly ThreadAgentActivityUnit<FixtureItem>[] = [
      {
        kind: "group",
        key: "agent-activity-group:exec-1",
        items: [indexed.activityItem],
      },
      {
        kind: "standalone",
        key: "agent-activity-standalone:message-1",
        item: createThreadAgentActivityItem(messageItem, "standalone"),
      },
    ];

    expect(units.map((unit) => isThreadAgentActivityGroup(unit)).join(",")).toBe("true,false");
    expect(units[0]?.kind === "group" ? units[0].items.length : 0).toBe(1);
    expect("sourceIndex" in units[0]!).toBe(false);
    expect("sourceIndex" in units[1]!).toBe(false);
  });

  test("classifies exec and patch as groupable after exact approved-review cleanup", () => {
    const approvedReview = buildConversationItem("review-approved", {
      rawItem: { review: { status: "approved" } },
    });
    const deniedReview = buildConversationItem("review-denied", {
      rawItem: { review: { status: "denied" } },
    });
    const exec = buildTranscriptBlock("exec", {
      automaticApprovalReviews: [approvedReview, deniedReview],
    });
    const patch = buildTranscriptBlock("fileChange", {
      automaticApprovalReviews: [deniedReview],
    });

    const classifiedExec = classifyThreadExecPatchWebActivityItem(exec);
    const classifiedPatch = classifyThreadExecPatchWebActivityItem(patch);

    expect(classifiedExec?.grouping).toBe("groupable");
    expect(classifiedExec?.item === exec).toBe(false);
    expect(classifiedExec?.item.automaticApprovalReviews?.length).toBe(1);
    expect(classifiedExec?.item.automaticApprovalReviews?.[0] === deniedReview).toBe(true);
    expect(classifiedPatch?.grouping).toBe("groupable");
    expect(classifiedPatch?.item === patch).toBe(true);
  });

  test("removes the review property when every attached review is approved", () => {
    const exec = buildTranscriptBlock("exec", {
      automaticApprovalReviews: [
        buildConversationItem("review-approved", {
          rawItem: { review: { status: "approved" } },
        }),
      ],
    });

    const cleaned = removeApprovedThreadAutomaticApprovalReviews(exec);

    expect(cleaned === exec).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned, "automaticApprovalReviews")).toBe(false);
  });

  test("uses normalized web query rather than searchable text for visibility", () => {
    const hidden = buildTranscriptBlock("webSearch", {
      searchableText: "unrelated raw payload text",
      entry: buildConversationItem("web-hidden", {
        webSearch: { query: " \n\t ", action: null, completed: false },
      }),
    });
    const visible = buildTranscriptBlock("webSearch", {
      searchableText: "",
      entry: buildConversationItem("web-visible", {
        webSearch: { query: " codex lifecycle ", action: null, completed: true },
      }),
    });

    expect(classifyThreadExecPatchWebActivityItem(hidden)).toBe(null);
    const classifiedVisible = classifyThreadExecPatchWebActivityItem(visible);
    expect(classifiedVisible?.grouping).toBe("groupable");
    expect(classifiedVisible?.item === visible).toBe(true);
  });

  test("defensively suppresses an ordinary empty file-change item", () => {
    const emptyPatch = buildTranscriptBlock("fileChange", {
      status: "inProgress",
      entry: buildConversationItem("empty-patch", {
        status: "inProgress",
        fileChange: { changes: {} },
      }),
    });

    expect(classifyThreadExecPatchWebActivityItem(emptyPatch)).toBe(null);
  });

  test("makes computer-use source and server calls standalone barriers", () => {
    const sourceCall = buildMcpBlock({
      server: "node_repl",
      source: { kind: "computerUse", app: null },
    });
    const serverCall = buildMcpBlock({ server: "computer-use" });
    const browserCall = buildMcpBlock({
      server: "node_repl",
      source: { kind: "browserUse", backend: "chrome" },
    });

    expect(classifyThreadMcpActivityItem(sourceCall, null)?.grouping).toBe("standalone");
    expect(classifyThreadMcpActivityItem(serverCall, null)?.grouping).toBe("standalone");
    expect(classifyThreadMcpActivityItem(browserCall, null)?.grouping).toBe("groupable");
  });

  test("uses the shared MCP metadata resolver and honors superseded widgets", () => {
    const statusResolved = buildMcpBlock();
    const direct = buildMcpBlock({ mcpAppResourceUri: "ui://direct" });
    const superseded = buildMcpBlock({
      mcpAppResourceUri: "ui://direct",
      superseded: true,
    });

    expect(
      classifyThreadMcpActivityItem(statusResolved, buildMcpStatuses("ui://status"))?.grouping,
    ).toBe("standalone");
    expect(classifyThreadMcpActivityItem(direct, null)?.grouping).toBe("standalone");
    expect(
      classifyThreadMcpActivityItem(superseded, buildMcpStatuses("ui://status"))?.grouping,
    ).toBe("groupable");
  });

  test("keeps successful unknown-status MCP apps groupable until confirmed", () => {
    const successfulResult = {
      content: [],
      structuredContent: null,
      _meta: null,
    };
    const maybeApp = buildMcpBlock({
      result: {
        type: "success",
        content: [],
        structuredContent: null,
        raw: successfulResult,
      },
    });

    expect(classifyThreadMcpActivityItem(maybeApp, null)?.grouping).toBe("groupable");
    expect(classifyThreadMcpActivityItem(maybeApp, { data: [], nextCursor: null })?.grouping).toBe(
      "groupable",
    );
  });

  test("classifies only the exact namespaced handoff entry as standalone", () => {
    const handoff = buildDynamicBlock({ tool: "handoff_thread" });
    const foreignHandoff = buildDynamicBlock({
      namespace: "unsupported_namespace",
      tool: "handoff_thread",
    });
    const completedSetup = buildDynamicBlock({
      namespace: "unsupported_namespace",
      tool: "setup_codex_step",
    });
    const automation = buildDynamicBlock({ tool: "automation_update" });

    expect(classifyThreadDynamicActivityItem(handoff)?.grouping).toBe("standalone");
    expect(classifyThreadDynamicActivityItem(foreignHandoff)?.grouping).toBe("groupable");
    expect(classifyThreadDynamicActivityItem(completedSetup)?.grouping).toBe("groupable");
    expect(classifyThreadDynamicActivityItem(automation)?.grouping).toBe("groupable");
  });

  test("exhaustively separates always-standalone and always-hidden transcript families", () => {
    const standaloneTypes = [
      "assistantMessage",
      "autoReviewInterruptionWarning",
      "contextCompaction",
      "imageView",
      "multiAgentAction",
      "realtimeTranscript",
      "streamError",
      "subagentActivityInlineGroup",
      "systemError",
      "userInputResponse",
      "userMessage",
      "worktreeInit",
    ] satisfies readonly ThreadClassifiableActivityTranscriptType[];
    const hiddenTypes = [
      "automationUpdate",
      "forkedFromConversation",
      "generatedImage",
      "modelChanged",
      "modelRerouted",
      "permissionRequest",
      "personalityChanged",
      "planImplementation",
      "proposedPlan",
      "reasoning",
      "remoteTaskCreated",
      "steered",
      "todoList",
      "turnDiff",
      "userInput",
    ] satisfies readonly ThreadClassifiableActivityTranscriptType[];

    expect(
      standaloneTypes
        .map((type) =>
          resolveThreadAgentActivityVisibility(
            classifyThreadAgentActivityItem(buildClassifiableBlock(type)),
          ),
        )
        .every((visibility) => visibility === "standalone"),
    ).toBe(true);
    expect(
      hiddenTypes
        .map((type) =>
          resolveThreadAgentActivityVisibility(
            classifyThreadAgentActivityItem(buildClassifiableBlock(type)),
          ),
        )
        .every((visibility) => visibility === "hidden"),
    ).toBe(true);
  });

  test("classifies every automatic approval review status exactly", () => {
    const cases = [
      ["approved", "hidden"],
      ["inProgress", "groupable"],
      ["aborted", "standalone"],
      ["denied", "standalone"],
      ["timedOut", "standalone"],
    ] as const;

    const actual = cases.map(([status]) => {
      const block = buildClassifiableBlock("automaticApprovalReview", {
        entry: buildConversationItem(`review-${status}`, {
          rawItem: { review: { status } },
        }),
      });
      return resolveThreadAgentActivityVisibility(classifyThreadAgentActivityItem(block));
    });

    expect(actual.join(",")).toBe(cases.map(([, expected]) => expected).join(","));
  });

  test("classifies completed elicitation from exact OpenAI image-picker predicate", () => {
    const elicitation = (
      completed: boolean,
      kind: string,
      properties: Record<string, unknown> = {},
    ) =>
      buildClassifiableBlock("mcpServerElicitation", {
        entry: buildConversationItem(`elicitation-${kind}`, {
          rawItem: {
            completed,
            elicitation: {
              kind,
              schema: { type: "object", properties },
            },
          },
        }),
      });
    const cases = [
      [elicitation(false, "openaiForm", { image: { type: "openai/imagePicker" } }), "hidden"],
      [elicitation(true, "unsupportedOpenAIForm"), "hidden"],
      [elicitation(true, "generic"), "standalone"],
      [elicitation(true, "openaiForm", { name: { type: "string" } }), "standalone"],
      [elicitation(true, "openaiForm", { image: { type: "openai/imagePicker" } }), "groupable"],
    ] as const;

    const actual = cases.map(([item]) =>
      resolveThreadAgentActivityVisibility(classifyThreadAgentActivityItem(item)),
    );
    expect(actual.join(",")).toBe(cases.map(([, expected]) => expected).join(","));
  });

  test("filters only an immediately paired terminal-compatible visualization command", () => {
    const visualizationCommand = (executionStatus: CodexConversationItem["executionStatus"]) =>
      buildClassifiableBlock("exec", {
        entry: buildConversationItem(`visualization-${executionStatus ?? "missing"}`, {
          executionStatus,
          parsedCmd: {
            type: "unknown",
            cmd: "mkdir -p .codex/visualizations/2026/07/11/thread && touch .codex/visualizations/2026/07/11/thread/chart.html",
            isFinished: executionStatus !== "inProgress",
          },
        }),
      });
    const patch = buildClassifiableBlock("fileChange", {
      entry: buildConversationItem("visualization-patch", {
        fileChange: {
          changes: {},
          visualizationActivities: [
            {
              path: ".codex/visualizations/2026/07/11/thread/chart.html",
              kind: "create",
            },
          ],
          success: true,
        },
      }),
    });

    const paired = projectThreadIndexedAgentActivityItems([
      visualizationCommand("completed"),
      patch,
    ]);
    const failed = projectThreadIndexedAgentActivityItems([visualizationCommand("failed"), patch]);

    expect(paired.map(({ sourceIndex }) => sourceIndex).join(",")).toBe("1");
    expect(failed.map(({ sourceIndex }) => sourceIndex).join(",")).toBe("0,1");
  });

  test("uses source adjacency before hidden-item removal for visualization pairing", () => {
    const command = buildClassifiableBlock("exec", {
      entry: buildConversationItem("visualization-command", {
        executionStatus: "completed",
        parsedCmd: {
          type: "unknown",
          cmd: "touch .codex/visualizations/2026/07/11/thread/chart.html",
          isFinished: true,
        },
      }),
    });
    const hiddenReasoning = buildClassifiableBlock("reasoning");
    const patch = buildClassifiableBlock("fileChange", {
      entry: buildConversationItem("visualization-patch", {
        fileChange: {
          changes: {},
          visualizationActivities: [{ path: "visualizations/chart.html", kind: "update" }],
          success: true,
        },
      }),
    });

    const indexed = projectThreadIndexedAgentActivityItems([command, hiddenReasoning, patch]);

    expect(indexed.map(({ sourceIndex }) => sourceIndex).join(",")).toBe("0,2");
  });

  test("filters only the visualize skill definition read and preserves original indexes", () => {
    const skillRead = (skillId: string) =>
      buildClassifiableBlock("exec", {
        entry: buildConversationItem(`read-${skillId}`, {
          cwd: "/workspace",
          executionStatus: "completed",
          parsedCmd: {
            type: "read",
            cmd: `cat .codex/skills/.system/${skillId}/SKILL.md`,
            name: "SKILL.md",
            path: `.codex/skills/.system/${skillId}/SKILL.md`,
            isFinished: true,
          },
        }),
      });

    const indexed = projectThreadIndexedAgentActivityItems([
      buildClassifiableBlock("exec"),
      skillRead("visualize"),
      skillRead("imagegen"),
    ]);

    expect(indexed.map(({ sourceIndex }) => sourceIndex).join(",")).toBe("0,2");
  });

  test("matches visualization write and delete command kinds exactly", () => {
    expect(
      resolveThreadVisualizationCommandKind(
        "apply_patch <<'PATCH'\n*** Add File: .codex/visualizations/2026/07/11/thread/chart.html",
      ),
    ).toBe("create");
    expect(
      resolveThreadVisualizationCommandKind(
        "apply_patch <<'PATCH'\n*** Update File: .codex/visualizations/2026/07/11/thread/chart.html",
      ),
    ).toBe("update");
    expect(
      resolveThreadVisualizationCommandKind(
        "apply_patch <<'PATCH'\n*** Delete File: .codex/visualizations/2026/07/11/thread/chart.html",
      ),
    ).toBe(null);
    expect(resolveThreadVisualizationCommandKind("cat .codex/visualizations/chart.html")).toBe(
      null,
    );
  });

  test("builds maximal mixed-family groups and preserves one-item groups", () => {
    const sourceItems = [
      buildClassifiableBlock("exec"),
      buildClassifiableBlock("webSearch", {
        entry: buildConversationItem("web-visible", {
          webSearch: { query: "activity grouping", action: null, completed: true },
        }),
      }),
      buildClassifiableBlock("assistantMessage"),
      buildClassifiableBlock("fileChange"),
    ];
    const indexed = projectThreadIndexedAgentActivityItems(sourceItems);

    const units = buildThreadAgentActivityUnits(indexed);

    expect(units.map(({ kind }) => kind).join(",")).toBe("group,standalone,group");
    expect(units[0]?.kind === "group" ? units[0].items.length : 0).toBe(2);
    expect(
      units[0]?.kind === "group" ? units[0].items.map(({ item }) => item.type).join(",") : "",
    ).toBe("exec,webSearch");
    expect(units[1]?.kind === "standalone" ? units[1].item.item.type : "").toBe("assistantMessage");
    expect(units[2]?.kind === "group" ? units[2].items.length : 0).toBe(1);
    expect(units[2]?.kind === "group" ? (units[2].items[0]?.item.type ?? "") : "").toBe(
      "fileChange",
    );
  });

  test("does not deduplicate repeated source activities inside a maximal group", () => {
    const firstPatch = buildClassifiableBlock("fileChange", { id: "patch-1" });
    const secondPatch = buildClassifiableBlock("fileChange", { id: "patch-2" });

    const units = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([firstPatch, secondPatch]),
    );

    expect(units.length).toBe(1);
    expect(units[0]?.kind === "group" ? units[0].items.length : 0).toBe(2);
  });

  test("keys units with string-only identity precedence and exact fallback types", () => {
    const idFirst = buildClassifiableBlock("multiAgentAction", {
      entry: buildConversationItem("multi-local", {
        callId: "call-second",
        requestId: "request-third",
        rawItem: { id: "id-first", handoffId: "handoff-fourth" },
      }),
    });
    const splitExec = buildClassifiableBlock("exec", {
      entry: buildConversationItem("raw-command", {
        callId: "raw-command:1",
        rawItem: { id: "raw-command" },
      }),
    });
    const numericRequest = buildClassifiableBlock("userInputResponse", {
      entry: buildConversationItem("local-response", {
        requestId: 42,
        rawItem: { requestId: 42 },
      }),
    });
    const handoffFallback = buildClassifiableBlock("realtimeTranscript", {
      entry: buildConversationItem("local-realtime", {
        rawItem: { handoffId: "handoff-only" },
      }),
    });

    expect(
      resolveThreadAgentActivityIdentity(createThreadAgentActivityItem(idFirst, "standalone"), 3),
    ).toBe("id-first");
    expect(
      resolveThreadAgentActivityIdentity(createThreadAgentActivityItem(splitExec, "groupable"), 4),
    ).toBe("raw-command:1");
    expect(
      resolveThreadAgentActivityIdentity(
        createThreadAgentActivityItem(numericRequest, "standalone"),
        5,
      ),
    ).toBe("user-input-response:5");
    expect(
      resolveThreadAgentActivityIdentity(
        createThreadAgentActivityItem(handoffFallback, "standalone"),
        6,
      ),
    ).toBe("handoff-only");
  });

  test("questions from one message retain distinct stable activity identities", () => {
    const questions = [0, 1].map((questionIndex) => {
      const id = JSON.stringify(["request_user_input_async", "ask", questionIndex]);
      return buildClassifiableBlock("assistantMessage", {
        entry: buildConversationItem(id, {
          rawItem: { id: "ask" },
          asyncQuestion: {
            id,
            sourceItemId: "ask",
            questionIndex,
            title: "Question",
            options: [],
          },
        }),
      });
    });
    const identities = questions.map((question, index) =>
      resolveThreadAgentActivityIdentity(
        createThreadAgentActivityItem(question, "standalone"),
        index,
      ),
    );
    expect(new Set(identities).size).toBe(2);
    expect(identities).toEqual(questions.map((question) => question.entry.asyncQuestion?.id));
  });

  test("uses first group identity and keeps keys stable across streaming changes", () => {
    const active = buildClassifiableBlock("exec", {
      entry: buildConversationItem("command-local", {
        callId: "command-stable",
        executionStatus: "inProgress",
      }),
    });
    const completed = buildClassifiableBlock("exec", {
      entry: buildConversationItem("command-local", {
        callId: "command-stable",
        executionStatus: "completed",
      }),
    });

    const activeKey = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([active]),
    )[0]?.key;
    const completedKey = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([completed]),
    )[0]?.key;

    expect(activeKey).toBe("agent-activity-group:command-stable");
    expect(completedKey).toBe(activeKey);
  });

  test("collects only string id/callId targets in source order without dedupe", () => {
    const duplicateIdA = buildClassifiableBlock("exec", {
      entry: buildConversationItem("command-a", { callId: "same id" }),
    });
    const duplicateIdB = buildClassifiableBlock("exec", {
      entry: buildConversationItem("command-b", { callId: "same id" }),
    });
    const numericRequest = buildClassifiableBlock("userInputResponse", {
      entry: buildConversationItem("response", { requestId: 9, rawItem: { requestId: 9 } }),
    });
    const units = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([duplicateIdA, duplicateIdB, numericRequest]),
    );
    const group = units[0]!;
    const requestUnit = units[1]!;

    expect(collectThreadAgentActivityTargetIds(group).join(",")).toBe("same id,same id");
    expect(
      buildThreadAgentActivityTargetAttribute(group)?.["data-local-conversation-item-target-ids"],
    ).toBe("same%20id same%20id");
    expect(collectThreadAgentActivityTargetIds(requestUnit).length).toBe(0);
    expect(buildThreadAgentActivityTargetAttribute(requestUnit)).toBe(undefined);
  });

  test("derives the primary slice closed boundary from assistant and streaming state", () => {
    expect(
      resolveThreadPrimaryActivitySliceClosed({
        hasRenderableAssistant: false,
        isTurnInProgress: true,
        keepOpenWhileStreaming: false,
      }),
    ).toBe(false);
    expect(
      resolveThreadPrimaryActivitySliceClosed({
        hasRenderableAssistant: true,
        isTurnInProgress: true,
        keepOpenWhileStreaming: false,
      }),
    ).toBe(true);
    expect(
      resolveThreadPrimaryActivitySliceClosed({
        hasRenderableAssistant: true,
        isTurnInProgress: true,
        keepOpenWhileStreaming: true,
      }),
    ).toBe(false);
    expect(
      resolveThreadPrimaryActivitySliceClosed({
        hasRenderableAssistant: true,
        isTurnInProgress: false,
        keepOpenWhileStreaming: true,
      }),
    ).toBe(true);
  });

  test("models latest, open, cancelled, and exploring context per slice", () => {
    const mainUnits = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([
        buildClassifiableBlock("exec"),
        buildClassifiableBlock("assistantMessage"),
      ]),
    );
    const persistentUnits = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([
        buildClassifiableBlock("exec", {
          entry: buildConversationItem("persistent", { callId: "persistent" }),
        }),
      ]),
    );
    const postAssistantUnits = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([
        buildClassifiableBlock("automaticApprovalReview", {
          entry: buildConversationItem("review-denied", {
            rawItem: { review: { status: "denied" } },
          }),
        }),
      ]),
    );

    const contexts = buildThreadAgentActivityUnitContexts({
      slices: [
        {
          kind: "main",
          units: mainUnits,
          isActivitySliceClosed: false,
          isExploring: true,
        },
        {
          kind: "persistent",
          units: persistentUnits,
          isActivitySliceClosed: false,
          isExploring: true,
        },
        {
          kind: "postAssistant",
          units: postAssistantUnits,
          isActivitySliceClosed: true,
          isExploring: true,
        },
      ],
      isTurnInProgress: true,
      isTurnCancelled: false,
    });

    expect(contexts.map(({ sliceKind }) => sliceKind).join(",")).toBe(
      "main,main,persistent,postAssistant",
    );
    expect(contexts.map(({ isLatestVisibleUnit }) => isLatestVisibleUnit).join(",")).toBe(
      "false,true,true,true",
    );
    expect(contexts.map(({ isActivitySliceOpen }) => isActivitySliceOpen).join(",")).toBe(
      "true,true,true,false",
    );
    expect(contexts.map(({ isExploring }) => isExploring).join(",")).toBe("true,true,false,false");
    expect(contexts.every(({ isTurnCancelled }) => !isTurnCancelled)).toBe(true);
  });

  test("never marks a non-progress turn slice open even before assistant closure", () => {
    const units = buildThreadAgentActivityUnits(
      projectThreadIndexedAgentActivityItems([buildClassifiableBlock("exec")]),
    );
    const [context] = buildThreadAgentActivityUnitContexts({
      slices: [
        {
          kind: "main",
          units,
          isActivitySliceClosed: false,
          isExploring: false,
        },
      ],
      isTurnInProgress: false,
      isTurnCancelled: true,
    });

    expect(context?.isLatestVisibleUnit).toBe(true);
    expect(context?.isActivitySliceClosed).toBe(false);
    expect(context?.isActivitySliceOpen).toBe(false);
    expect(context?.isTurnCancelled).toBe(true);
  });

  test("computes expandability after exact group body filtering", () => {
    const unfinishedSearch = buildTranscriptBlock("exec", {
      status: "inProgress",
      entry: buildConversationItem("search", {
        status: "inProgress",
        parsedCmd: {
          type: "search",
          cmd: "rg parity",
          query: "parity",
          path: null,
          isFinished: false,
        },
      }),
    });
    const summaryOnly = buildDynamicBlock({ tool: "get_handoff_status" });
    const ordinaryDynamic = buildDynamicBlock({ tool: "read_thread" });
    const filteredSummaryOnly = filterThreadAgentActivityGroupBodyItems(
      [
        createThreadAgentActivityItem(unfinishedSearch, "groupable"),
        createThreadAgentActivityItem(summaryOnly, "groupable"),
      ],
      false,
    );
    const expandableMixed = filterThreadAgentActivityGroupBodyItems(
      [...filteredSummaryOnly.items, createThreadAgentActivityItem(ordinaryDynamic, "groupable")],
      false,
    );
    const cancelledEmptyPatch = buildTranscriptBlock("fileChange", {
      status: "inProgress",
      entry: buildConversationItem("visualization", {
        status: "inProgress",
        fileChange: {
          changes: {},
          visualizationActivities: [{ path: "visualizations/chart.html", kind: "create" }],
        },
      }),
    });
    const filteredCancelledPatch = filterThreadAgentActivityGroupBodyItems(
      [createThreadAgentActivityItem(cancelledEmptyPatch, "groupable")],
      true,
    );

    expect(filteredSummaryOnly.items.length).toBe(1);
    expect(filteredSummaryOnly.canExpand).toBe(false);
    expect(expandableMixed.canExpand).toBe(true);
    expect(filteredCancelledPatch.items.length).toBe(0);
    expect(filteredCancelledPatch.canExpand).toBe(false);
  });
});
