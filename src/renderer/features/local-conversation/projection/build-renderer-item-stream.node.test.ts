import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem } from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import {
  buildRendererItemStream,
  buildRendererItemStreamProjection,
} from "./build-renderer-item-stream";
import type { ThreadTranscriptBlockModel } from "../thread-stage-types";

function buildEntry(overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("buildRendererItemStream", () => {
  test("hides assistant remark directive lines from search without mutating raw markdown", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "assistant_directive",
          type: "assistant_message",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: [
            "Daily report is ready.",
            "",
            '::inbox-item{title="Daily report ready" summary="Review the clean test summary"}',
            "::archive-thread{}",
            "",
            'Done. ::inbox-item{title="Inline remains visible"}',
          ].join("\n"),
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    const assistant = items[0];
    expect(assistant?.type).toBe("assistantMessage");
    expect(assistant?.type === "assistantMessage" ? assistant.entry.markdownText : "").toBe(
      [
        "Daily report is ready.",
        "",
        '::inbox-item{title="Daily report ready" summary="Review the clean test summary"}',
        "::archive-thread{}",
        "",
        'Done. ::inbox-item{title="Inline remains visible"}',
      ].join("\n"),
    );
    expect(assistant?.searchableText.includes("Daily report ready")).toBe(false);
    expect(assistant?.searchableText.includes("Inline remains visible")).toBe(true);
  });

  test("maps transcript entries into richer renderer item types", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "plan_1",
          type: "plan",
          kind: "plan",
          semanticKind: "todoList",
          markdownText: "1. Research\n2. Implement\n3. Verify",
        }),
        buildEntry({
          itemId: "diff_1",
          type: "turn_diff",
          kind: "systemEvent",
          semanticKind: "diff",
          rawItem: {
            type: "turn-diff",
            unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
          },
        }),
        buildEntry({
          itemId: "reroute_1",
          type: "model_rerouted",
          kind: "systemEvent",
          semanticKind: "modelRerouted",
          markdownText: "Rerouted to gpt-5.4",
        }),
        buildEntry({
          itemId: "auto_review_interruption_1",
          type: "autoReviewInterruptionWarning",
          kind: "systemEvent",
          semanticKind: "autoReviewInterruptionWarning",
          markdownText:
            "Automatic approval review rejected too many approval requests for this turn",
        }),
        buildEntry({
          itemId: "steered_1",
          type: "steered",
          kind: "systemEvent",
          semanticKind: "steered",
          markdownText: "Steered conversation",
        }),
        buildEntry({
          itemId: "tool_1",
          type: "web_search",
          kind: "toolCall",
          semanticKind: "webSearch",
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: { query: "renderer bucketization" },
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe(
      "todoList,turnDiff,modelRerouted,autoReviewInterruptionWarning,steered,webSearch",
    );
  });

  test("maps bundle-native hook, planImplementation, and userInputResponse families", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "hook_1",
          type: "hook",
          kind: "hook",
          semanticKind: "hook",
        }),
        buildEntry({
          itemId: "plan_impl_1",
          type: "planImplementation",
          kind: "planImplementation",
          semanticKind: "planImplementation",
          markdownText: "Implement the plan",
        }),
        buildEntry({
          itemId: "user_input_response_1",
          type: "request_user_input",
          kind: "userInputResponse",
          semanticKind: "userInputResponse",
          userInputQuestions: [],
          userInputAnswers: {},
        }),
        buildEntry({
          itemId: "worktree_init_1",
          type: "worktreeInit",
          kind: "systemEvent",
          semanticKind: "worktreeInit",
          rawItem: {
            id: "worktree_init_1",
            type: "worktreeInit",
            worktreeOutputText: "[info] Worktree created\n",
            setup: null,
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe(
      "hook,planImplementation,userInputResponse,worktreeInit",
    );
  });

  test("maps v2 protocol item types when normalized semantic kind is generic", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "agent_message_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "agent_message_1", type: "agentMessage" },
          markdownText: "Done.",
        }),
        buildEntry({
          itemId: "reasoning_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "reasoning_1", type: "reasoning" },
          markdownText: "Thinking through the dispatch.",
        }),
        buildEntry({
          itemId: "function_output_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: {
            id: "function_output_1",
            type: "functionCallOutput",
            name: "external_lookup",
            namespace: null,
            output: "opaque model-context result",
          },
        }),
        buildEntry({
          itemId: "exec_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "exec_1", type: "commandExecution" },
        }),
        buildEntry({
          itemId: "patch_1",
          kind: "toolCall",
          semanticKind: "systemEvent",
          rawItem: { id: "patch_1", type: "fileChange" },
          fileChange: {
            changes: buildCodexFileChangeMap([
              {
                type: "update",
                path: "src/app.ts",
                unifiedDiff: "",
                movePath: null,
              },
            ]),
          },
        }),
        buildEntry({
          itemId: "mcp_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "mcp_1", type: "mcpToolCall" },
        }),
        buildEntry({
          itemId: "dynamic_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "dynamic_1", type: "dynamicToolCall" },
        }),
        buildEntry({
          itemId: "web_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "web_1", type: "webSearch", query: "Codex app-server" },
        }),
        buildEntry({
          itemId: "image_view_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          imageViewPaths: ["/tmp/reference.png"],
          rawItem: { id: "image_view_1", type: "imageView", path: "/tmp/reference.png" },
        }),
        buildEntry({
          itemId: "compact_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "compact_1", type: "contextCompaction" },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe(
      "assistantMessage,reasoning,exec,fileChange,mcpToolCall,dynamicToolCall,webSearch,imageView,contextCompaction",
    );
  });

  test("preserves canonical consecutive image runs across projected barriers", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "image_1",
          kind: "systemEvent",
          semanticKind: "imageView",
          imageViewPaths: ["/tmp/one.png", "/tmp/adjacent.png"],
          rawItem: { id: "image_1", type: "imageView", path: "/tmp/one.png" },
        }),
        buildEntry({
          itemId: "assistant_between",
          markdownText: "Compared both references.",
        }),
        buildEntry({
          itemId: "image_2",
          kind: "systemEvent",
          semanticKind: "imageView",
          imageViewPaths: ["/tmp/two.png"],
          rawItem: { id: "image_2", type: "imageView", path: "/tmp/two.png" },
          updatedAt: 3,
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe("imageView,assistantMessage,imageView");
    const imageView = items[0];
    expect(imageView?.id).toBe("image_1");
    expect(imageView?.type === "imageView" ? imageView.imageViewPaths?.join(",") : "").toBe(
      "/tmp/one.png,/tmp/adjacent.png",
    );
    const laterImageView = items[2];
    expect(laterImageView?.type === "imageView" ? laterImageView.imageViewPaths : []).toEqual([
      "/tmp/two.png",
    ]);
  });

  test("omits webSearch rows without a visible query", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "web_missing_query",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: {
            id: "web_missing_query",
            type: "webSearch",
            action: {
              type: "search",
              queries: ["fallback should not render"],
            },
          },
        }),
        buildEntry({
          itemId: "web_blank_query",
          type: "web_search",
          kind: "toolCall",
          semanticKind: "webSearch",
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: { query: "   " },
            result: {
              type: "search",
              queries: ["fallback should not render"],
            },
          },
          rawItem: {
            id: "web_blank_query",
            type: "webSearch",
            query: "   ",
            action: {
              type: "search",
              queries: ["fallback should not render"],
            },
          },
        }),
        buildEntry({
          itemId: "web_visible_query",
          type: "web_search",
          kind: "toolCall",
          semanticKind: "webSearch",
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: { query: "thread grouping parity" },
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.id).join(",")).toBe("web_visible_query");
    expect(items.map((item) => item.type).join(",")).toBe("webSearch");
  });

  test("defers ambiguous v2 protocol item families to normalized semantic kind", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "todo_plan_1",
          type: "plan",
          kind: "plan",
          semanticKind: "todoList",
          rawItem: { id: "todo_plan_1", type: "plan" },
          markdownText: "1. Research\n2. Implement",
        }),
        buildEntry({
          itemId: "proposed_plan_1",
          type: "plan",
          kind: "plan",
          semanticKind: "proposedPlan",
          rawItem: { id: "proposed_plan_1", type: "plan" },
          markdownText: "We can refactor the dispatcher.",
        }),
        buildEntry({
          itemId: "multi_agent_1",
          type: "collabAgentToolCall",
          kind: "toolCall",
          semanticKind: "multiAgentAction",
          rawItem: { id: "multi_agent_1", type: "collabAgentToolCall" },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe("todoList,proposedPlan,multiAgentAction");
  });

  test("groups consecutive typed subagent activities and splits at projected barriers", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "sub_agent_1",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-1",
            displayName: "Scout",
            displayStatus: "active",
            isMessage: false,
          },
          rawItem: {
            id: "sub_agent_1",
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: "thread-child-1",
            agentPath: "agents/@Scout",
          },
        }),
        buildEntry({
          itemId: "sub_agent_2",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-2",
            displayName: "Reviewer",
            displayStatus: "updated",
            isMessage: false,
          },
          rawItem: {
            id: "sub_agent_2",
            type: "subAgentActivity",
            kind: "interacted",
            agentThreadId: "thread-child-2",
            agentPath: "Reviewer",
          },
        }),
        buildEntry({
          itemId: "assistant_between_subagents",
          markdownText: "Checked both agents.",
        }),
        buildEntry({
          itemId: "sub_agent_3",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-3",
            displayName: "Finisher",
            displayStatus: "interrupted",
            isMessage: false,
          },
          rawItem: {
            id: "sub_agent_3",
            type: "subAgentActivity",
            kind: "interrupted",
            agentThreadId: "thread-child-3",
            agentPath: "root",
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    const first = items[0];
    const second = items[2];

    expect(items.map((item) => item.type).join(",")).toBe(
      "subagentActivityInlineGroup,assistantMessage,subagentActivityInlineGroup",
    );
    expect(first?.type).toBe("subagentActivityInlineGroup");
    expect(
      first && "subagentActivityRows" in first ? first.subagentActivityRows?.[0]?.displayName : "",
    ).toBe("Scout");
    expect(
      first && "subagentActivityRows" in first ? first.subagentActivityRows?.[0]?.status : "",
    ).toBe("active");
    expect(
      first && "subagentActivityRows" in first
        ? first.subagentActivityRows?.[0]?.statusSummary
        : "",
    ).toBe("Scout started working");
    expect(
      first && "subagentActivityRows" in first ? first.subagentActivityRows?.[1]?.displayName : "",
    ).toBe("Reviewer");
    expect(
      first && "subagentActivityStatusLabel" in first ? first.subagentActivityStatusLabel : "",
    ).toBe("updated");
    expect(
      second && "subagentActivityRows" in second
        ? second.subagentActivityRows?.[0]?.displayName
        : "",
    ).toBe("Finisher");
    expect(
      second && "subagentActivityStatusLabel" in second ? second.subagentActivityStatusLabel : "",
    ).toBe("interrupted");
  });

  test("keeps a hidden non-subagent item as an activity-group boundary", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "sub_agent_before_hidden_boundary",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-1",
            displayName: "Scout",
            displayStatus: "active",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "hidden_sleep_boundary",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "hidden_sleep_boundary", type: "sleep" },
        }),
        buildEntry({
          itemId: "sub_agent_after_hidden_boundary",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-2",
            displayName: "Reviewer",
            displayStatus: "active",
            isMessage: false,
          },
        }),
      ],
      requests: [],
    });

    expect(items.map((item) => item.type)).toEqual([
      "subagentActivityInlineGroup",
      "subagentActivityInlineGroup",
    ]);
  });

  test("deduplicates each subagent group to the last event and only marks its final parent-turn event done", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "sub_agent_1_started",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-1",
            displayName: "Scout",
            displayStatus: "active",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "sub_agent_2_started",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-2",
            displayName: "Reviewer",
            displayStatus: "active",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "sub_agent_1_updated",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-1",
            displayName: "Scout",
            displayStatus: "updated",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "assistant_between_subagent_groups",
          markdownText: "Checked the first updates.",
        }),
        buildEntry({
          itemId: "sub_agent_1_final",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-1",
            displayName: "Scout",
            displayStatus: "active",
            isMessage: false,
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
      turnKey: "turn_1",
      backgroundAgents: [
        {
          conversationId: "thread-child-1",
          parentConversationId: "thread-root",
          parentTurnKey: "turn_1",
          displayName: "Scout",
          actorName: "Scout",
          agentRole: "explorer",
          spawnModel: "gpt-5",
          status: "done",
          statusSummary: "Scout completed the audit",
          lastAssistantMessage: null,
          lastAssistantMessageAtMs: null,
          recencyAtMs: 2,
          showInlineActivity: true,
          canInteract: false,
          diffStats: null,
          role: "backgroundChild",
        },
        {
          conversationId: "thread-child-2",
          parentConversationId: "thread-root",
          parentTurnKey: "turn_1",
          displayName: "Reviewer",
          actorName: "Reviewer",
          agentRole: null,
          spawnModel: null,
          status: "done",
          statusSummary: null,
          lastAssistantMessage: null,
          lastAssistantMessageAtMs: null,
          recencyAtMs: 1,
          showInlineActivity: true,
          canInteract: false,
          diffStats: null,
          role: "backgroundChild",
        },
      ],
    });

    const firstGroup = items[0];
    const finalGroup = items[2];
    const firstRows =
      firstGroup?.type === "subagentActivityInlineGroup"
        ? (firstGroup.subagentActivityRows ?? [])
        : [];
    const finalRows =
      finalGroup?.type === "subagentActivityInlineGroup"
        ? (finalGroup.subagentActivityRows ?? [])
        : [];

    expect(firstRows.map((row) => row.conversationId)).toEqual([
      "thread-child-1",
      "thread-child-2",
    ]);
    expect(firstRows[0]).toMatchObject({
      status: "done",
      activityStatus: "updated",
      statusSummary: "Scout completed the audit",
    });
    expect(firstRows[1]).toMatchObject({
      status: "done",
      activityStatus: "done",
      statusSummary: "Reviewer started working",
    });
    expect(
      firstGroup?.type === "subagentActivityInlineGroup"
        ? firstGroup.subagentActivityStatusLabel
        : null,
    ).toBe("updated");
    expect(finalRows[0]).toMatchObject({
      status: "done",
      activityStatus: "done",
      statusSummary: "Scout completed the audit",
    });
    expect(
      finalGroup?.type === "subagentActivityInlineGroup"
        ? finalGroup.subagentActivityStatusLabel
        : null,
    ).toBe("finished");
  });

  test("uses fallback state for missing or other-parent agents and preserves group-label precedence", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "sub_agent_other_parent",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-other-parent",
            displayName: "Migrated",
            displayStatus: "active",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "sub_agent_waiting",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-waiting",
            displayName: "Waiting",
            displayStatus: "updated",
            isMessage: false,
          },
        }),
        buildEntry({
          itemId: "sub_agent_missing",
          kind: "systemEvent",
          semanticKind: "subAgentActivity",
          subagentActivity: {
            agentThreadId: "thread-child-missing",
            displayName: "Missing",
            displayStatus: "interrupted",
            isMessage: false,
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
      turnKey: "turn_1",
      backgroundAgents: [
        {
          conversationId: "thread-child-other-parent",
          parentConversationId: "thread-root",
          parentTurnKey: "turn_0",
          displayName: "Migrated",
          actorName: "Migrated",
          agentRole: null,
          spawnModel: null,
          status: "active",
          statusSummary: "Working on a newer turn",
          lastAssistantMessage: null,
          lastAssistantMessageAtMs: null,
          recencyAtMs: 2,
          showInlineActivity: true,
          canInteract: false,
          diffStats: null,
          role: "backgroundChild",
        },
        {
          conversationId: "thread-child-waiting",
          parentConversationId: "thread-root",
          parentTurnKey: "turn_1",
          displayName: "Waiting",
          actorName: "Waiting",
          agentRole: null,
          spawnModel: null,
          status: "waiting",
          statusSummary: "Waiting for input",
          lastAssistantMessage: null,
          lastAssistantMessageAtMs: null,
          recencyAtMs: 1,
          showInlineActivity: true,
          canInteract: false,
          diffStats: null,
          role: "backgroundChild",
        },
      ],
    });

    const group = items[0];
    const rows =
      group?.type === "subagentActivityInlineGroup" ? (group.subagentActivityRows ?? []) : [];

    expect(rows[0]).toMatchObject({
      status: "done",
      activityStatus: "started",
      statusSummary: "Migrated started working",
    });
    expect(rows[1]).toMatchObject({
      status: "waiting",
      activityStatus: "updated",
      statusSummary: "Waiting for input",
    });
    expect(rows[2]).toMatchObject({
      status: "done",
      activityStatus: "interrupted",
      statusSummary: "Missing interrupted",
    });
    expect(
      group?.type === "subagentActivityInlineGroup" ? group.subagentActivityStatusLabel : null,
    ).toBe("interrupted");
  });

  test("renders typed hook feedback and generated images while hiding raw-only markers", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "hook_prompt_1",
          type: "hookPrompt",
          kind: "userMessage",
          semanticKind: "userMessage",
          markdownText: "Please address the failing check.",
          hookFeedback: true,
          rawItem: { id: "hook_prompt_1", type: "hookPrompt", fragments: [] },
        }),
        buildEntry({
          itemId: "sleep_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "sleep_1", type: "sleep" },
        }),
        buildEntry({
          itemId: "image_generation_1",
          kind: "systemEvent",
          semanticKind: "generatedImage",
          generatedImage: {
            src: "data:image/png;base64,aW1hZ2U=",
            status: "completed",
          },
          rawItem: {
            id: "image_generation_1",
            type: "imageGeneration",
            result: "aW1hZ2U=",
            status: "completed",
          },
        }),
        buildEntry({
          itemId: "entered_review_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "entered_review_1", type: "enteredReviewMode" },
        }),
        buildEntry({
          itemId: "exited_review_1",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          rawItem: { id: "exited_review_1", type: "exitedReviewMode" },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type)).toEqual(["userMessage", "generatedImage"]);
    expect(items[0]?.type === "userMessage" ? items[0].entry.hookFeedback : false).toBe(true);
  });

  test("omits unanswered user-input requests from inline renderer items", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "request_1",
          type: "request_user_input",
          kind: "userInputRequest",
          semanticKind: "systemEvent",
          userInputQuestions: [
            {
              id: "question_1",
              header: "Question",
              question: "What next?",
              isOther: false,
              isSecret: false,
            },
          ],
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.length).toBe(0);
  });

  test("omits reasoning items whose projected summary is empty", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "reasoning_1",
          type: "reasoning",
          kind: "reasoning",
          semanticKind: "reasoning",
          markdownText: "   ",
          rawItem: {
            id: "reasoning_1",
            type: "reasoning",
            summary: [],
            content: ["internal content only"],
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.length).toBe(0);
  });

  test("keeps Codex tool rows but omits generic tool fallback entries", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "patch_1",
          type: "file_change",
          kind: "fileChange",
          toolCall: {
            subtype: "fileChange",
            toolName: "file_change",
            result: {
              summary: "Edited src/app.tsx",
            },
          },
          fileChange: {
            changes: buildCodexFileChangeMap([
              {
                type: "update",
                path: "src/app.tsx",
                unifiedDiff: "",
                movePath: null,
              },
            ]),
          },
        }),
        buildEntry({
          itemId: "mcp_1",
          type: "mcpToolCall",
          kind: "toolCall",
          semanticKind: "mcpToolCall",
          toolCall: {
            subtype: "mcp",
            toolName: "search_docs",
            server: "docs",
            args: { query: "thread item schema" },
          },
        }),
        buildEntry({
          itemId: "generic_1",
          type: "tool_call",
          kind: "toolCall",
          semanticKind: "toolCall",
          toolCall: {
            subtype: "generic",
            toolName: "summarize_stage_shell",
            args: { section: "footer" },
            result: { summary: "legacy fallback" },
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe("fileChange,mcpToolCall");
  });

  test("omits fileChange rows without canonical patch entries", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "empty_patch_1",
          type: "file_change",
          kind: "fileChange",
          semanticKind: "patch",
          status: "completed",
          fileChange: {
            changes: buildCodexFileChangeMap([]),
          },
        }),
        buildEntry({
          itemId: "raw_protocol_patch_1",
          type: "file_change",
          kind: "fileChange",
          semanticKind: "patch",
          status: "completed",
          fileChange: {
            changes: [
              { path: "src/raw.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@" },
            ] as never,
          },
        }),
      ],
      requests: [],
      turnStatus: "completed",
    });

    expect(items.length).toBe(0);
  });

  test("omits an empty in-progress fileChange row until a change materializes", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "empty_live_patch",
          type: "file_change",
          kind: "fileChange",
          semanticKind: "patch",
          status: "inProgress",
          fileChange: {
            changes: buildCodexFileChangeMap([]),
            success: null,
          },
        }),
      ],
      requests: [],
      turnStatus: "inProgress",
      isLatestTurn: true,
    });

    expect(items).toEqual([]);
  });

  test("injects turn-scoped requests into the renderer item stream", () => {
    const items = buildRendererItemStream({
      entries: [],
      requests: [
        {
          type: "approval",
          requestId: "approval_1",
          kind: "command",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_approval",
          createdAt: 5,
        },
      ],
      turnStatus: "completed",
    });

    expect(items.map((item) => item.type).join(",")).toBe("approval");
  });

  test("indexes the semantic and NFM preview of a Nodex authorization request", () => {
    const items = buildRendererItemStream({
      entries: [],
      requests: [
        {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-1",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "call-1",
          tool: "edit_document",
          effect: "write",
          preview: {
            title: "Append rollout plan",
            summary: "Append four Blocks.",
            details: [{ label: "Document", value: "Launch brief" }],
            nfmPreview: "## Rollout\n\n- Alpha cohort",
          },
          createdAt: 5,
        },
      ],
      turnStatus: "inProgress",
    });

    expect(items[0]?.type).toBe("nodexAgentAuthorization");
    expect(items[0]?.searchableText).toContain("Launch brief");
    expect(items[0]?.searchableText).toContain("Alpha cohort");
  });

  test("indexes a v3 Nested Markdown authorization preview", () => {
    const items = buildRendererItemStream({
      entries: [],
      requests: [
        {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-v3",
          projectId: "project_1",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "call-v3",
          tool: "create_pages",
          effect: "write",
          preview: {
            title: "Create launch Cards",
            summary: "Create two complete Cards.",
            details: [{ label: "Destination", value: "Project Space" }],
            markdownPreview: "## Launch\n\n- Alpha cohort",
          },
          createdAt: 6,
        },
      ],
      turnStatus: "inProgress",
    });

    expect(items[0]?.searchableText).toContain("Project Space");
    expect(items[0]?.searchableText).toContain("Alpha cohort");
  });

  test("does not synthesize worked-for rows in the flat renderer item stream", () => {
    const items = buildRendererItemStream({
      entries: [
        buildEntry({
          itemId: "user_1",
          createdAt: 1_000,
          updatedAt: 1_000,
          type: "user_message",
          kind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          markdownText: "run bun test",
        }),
        buildEntry({
          itemId: "commentary_1",
          createdAt: 2_000,
          updatedAt: 2_000,
          type: "assistant_message",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          assistantPhase: "commentary",
          role: "assistant",
          markdownText: "Running the test suite.",
        }),
        buildEntry({
          itemId: "exec_1",
          createdAt: 3_000,
          updatedAt: 3_000,
          type: "command_execution",
          kind: "commandExecution",
          semanticKind: "exec",
          toolCall: {
            subtype: "command",
            toolName: "exec_command",
          },
        }),
        buildEntry({
          itemId: "assistant_1",
          createdAt: 5_000,
          updatedAt: 5_000,
          type: "assistant_message",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          assistantPhase: "final_answer",
          role: "assistant",
          markdownText: "`bun test` passed.",
        }),
      ],
      requests: [],
      turnStatus: "completed",
      isLatestTurn: true,
    });

    expect(items.map((item) => item.id).join(",")).toBe("user_1,commentary_1,exec_1,assistant_1");
    expect(items.some((item) => item.type === "workedFor")).toBe(false);
  });
});

type Activity = NonNullable<CodexConversationItem["subagentActivity"]>;
type BackgroundAgent = NonNullable<
  Parameters<typeof buildRendererItemStream>[0]["backgroundAgents"]
>[number];

function activityEntry(id: string, overrides: Partial<Activity> = {}): CodexConversationItem {
  return buildEntry({
    itemId: id,
    kind: "systemEvent",
    semanticKind: "subAgentActivity",
    subagentActivity: {
      agentThreadId: id,
      displayName: id.toUpperCase(),
      displayStatus: "active",
      isMessage: false,
      ...overrides,
    },
  });
}

function backgroundAgent(id: string, overrides: Partial<BackgroundAgent> = {}): BackgroundAgent {
  return {
    conversationId: id,
    parentConversationId: "thread_1",
    parentTurnKey: "turn_1",
    displayName: id.toUpperCase(),
    actorName: id.toUpperCase(),
    agentRole: null,
    spawnModel: null,
    status: "active",
    statusSummary: null,
    lastAssistantMessage: null,
    lastAssistantMessageAtMs: null,
    recencyAtMs: 1,
    showInlineActivity: true,
    canInteract: false,
    diffStats: null,
    role: "backgroundChild",
    ...overrides,
  };
}

function activityGroups(items: ReturnType<typeof buildRendererItemStream>) {
  return items.filter(
    (item): item is ThreadTranscriptBlockModel => item.type === "subagentActivityInlineGroup",
  );
}

describe("subagent lifecycle projection", () => {
  test("uses named background rows without anchors, including legacy rows and partial raw coverage", () => {
    const projection = buildRendererItemStreamProjection({
      entries: [activityEntry("a", { displayStatus: "completed" })],
      requests: [],
      turnKey: "turn_1",
      backgroundAgents: [
        backgroundAgent("a", { status: "done" }),
        backgroundAgent("b", { showInlineActivity: false }),
        backgroundAgent("elsewhere", { parentTurnKey: "turn_0" }),
        backgroundAgent("unnamed", { displayName: " " }),
        backgroundAgent("raw-id", { displayName: "raw-id" }),
      ],
    });
    const groups = activityGroups(projection.items);
    expect(projection.subagentActivityState).toEqual({
      hasActivity: true,
      hasActiveActivity: true,
    });
    expect(groups.map((group) => group.subagentActivityAnchorItemId)).toEqual(["a", null]);
    expect(
      groups.map((group) => group.subagentActivityRows?.map((row) => row.conversationId)),
    ).toEqual([["a"], ["b"]]);
    expect(groups[1]?.subagentActivityRows?.[0]).toMatchObject({ canOpen: true, status: "active" });
  });

  test("resolves names by turn and mode, filters unnamed rows, and keeps navigation separate from interaction", () => {
    const items = buildRendererItemStream({
      entries: [
        activityEntry("blank", { displayName: " " }),
        activityEntry("legacy", { displayName: "Event" }),
        activityEntry("modern", { displayName: "Event" }),
        activityEntry("raw", { displayName: "raw" }),
        activityEntry("none", { displayName: null }),
        activityEntry("finished", { displayStatus: "completed" }),
        activityEntry("interrupted", { displayStatus: "interrupted" }),
        activityEntry("active"),
      ],
      requests: [],
      turnKey: "turn_1",
      backgroundAgents: [
        backgroundAgent("blank", { displayName: "Known" }),
        backgroundAgent("legacy", { displayName: "Legacy", showInlineActivity: false }),
        backgroundAgent("modern", { displayName: "Modern" }),
      ],
    });
    const rows = activityGroups(items).flatMap((group) => group.subagentActivityRows ?? []);
    expect(rows.map((row) => [row.displayName, row.canOpen, row.status])).toEqual([
      ["Known", true, "active"],
      ["Legacy", true, "active"],
      ["Event", true, "active"],
      ["FINISHED", false, "done"],
      ["INTERRUPTED", false, "done"],
      ["ACTIVE", true, "active"],
    ]);
  });

  test("normalizes only the final same-turn interruption to finished", () => {
    const items = buildRendererItemStream({
      entries: [
        activityEntry("early", { agentThreadId: "a", displayStatus: "interrupted" }),
        buildEntry({ itemId: "barrier" }),
        activityEntry("last", { agentThreadId: "a", displayStatus: "interrupted" }),
      ],
      requests: [],
      turnKey: "turn_1",
      backgroundAgents: [backgroundAgent("a", { status: "done" })],
    });
    expect(
      activityGroups(items).map((group) => group.subagentActivityRows?.[0]?.activityStatus),
    ).toEqual(["interrupted", "done"]);
  });

  test("messages break lifecycle adjacency even when their marker is suppressed", () => {
    const entries = [
      activityEntry("a"),
      activityEntry("message", { agentThreadId: "a", displayStatus: "updated", isMessage: true }),
      activityEntry("b"),
    ];
    const visible = buildRendererItemStream({ entries, requests: [], canOpenSubagents: true });
    expect(
      activityGroups(visible).map((group) =>
        group.subagentActivityRows?.map((row) => row.conversationId),
      ),
    ).toEqual([["a"], ["b"]]);
    for (const options of [
      { canOpenSubagents: false },
      { canOpenSubagents: true, showFullTranscript: true },
    ]) {
      const all = buildRendererItemStream({ entries, requests: [], ...options });
      expect(all.map((item) => item.id)).toEqual(["a", "message", "b"]);
      expect(all[1]?.searchableText).toBe("Sent message to MESSAGE");
    }
    const parent = buildRendererItemStream({
      entries: [activityEntry("root-message", { displayName: null, isMessage: true })],
      requests: [],
    });
    expect(parent[0]?.searchableText).toBe("Sent message to parent");
  });

  test("message deduplication takes four rows before filtering canOpen and applies the budget per group", () => {
    const entries = [
      activityEntry("a", { displayStatus: "completed" }),
      activityEntry("b"),
      activityEntry("c"),
      activityEntry("d"),
      activityEntry("e"),
      buildEntry({ itemId: "barrier" }),
      activityEntry("f"),
      ...["a", "b", "e", "f"].map((id) =>
        activityEntry(`message-${id}`, {
          agentThreadId: id,
          displayStatus: "updated",
          isMessage: true,
        }),
      ),
    ];
    const items = buildRendererItemStream({ entries, requests: [], canOpenSubagents: true });
    expect(
      items
        .filter((item) => "entry" in item && item.entry.subagentActivity?.isMessage)
        .map((item) => item.id),
    ).toEqual(["message-a", "message-e"]);
  });

  test("named fallback rows suppress covered messages but do not become raw lifecycle members", () => {
    const items = buildRendererItemStream({
      entries: [activityEntry("message-b", { agentThreadId: "b", isMessage: true })],
      requests: [],
      turnKey: "turn_1",
      canOpenSubagents: true,
      backgroundAgents: [backgroundAgent("b", { showInlineActivity: false })],
    });
    expect(items).toHaveLength(1);
    expect(activityGroups(items)[0]?.subagentActivityAnchorItemId).toBeNull();
    expect(activityGroups(items)[0]?.subagentActivityRows?.[0]?.conversationId).toBe("b");
  });

  test("only removes completed empty-prompt spawns whose nonempty receiver list is fully represented", () => {
    const spawn = (id: string, overrides: Record<string, unknown> = {}) =>
      buildEntry({
        itemId: id,
        kind: "toolCall",
        semanticKind: "multiAgentAction",
        rawItem: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreads: [{ threadId: "a", thread: null }],
          prompt: null,
          ...overrides,
        },
      });
    const entries = [
      spawn("covered"),
      spawn("prompted", { prompt: " Inspect " }),
      spawn("running", { status: "inProgress" }),
      spawn("partial", {
        receiverThreads: [
          { threadId: "a", thread: null },
          { threadId: "b", thread: null },
        ],
      }),
      spawn("empty", { receiverThreads: [] }),
    ];
    const items = buildRendererItemStream({
      entries,
      requests: [],
      turnKey: "turn_1",
      backgroundAgents: [backgroundAgent("a")],
    });
    expect(items.filter((item) => item.type === "multiAgentAction").map((item) => item.id)).toEqual(
      ["prompted", "running", "partial", "empty"],
    );
    const otherTurn = buildRendererItemStream({
      entries,
      requests: [],
      turnKey: "turn_2",
      backgroundAgents: [backgroundAgent("a")],
    });
    expect(otherTurn.filter((item) => item.type === "multiAgentAction")).toHaveLength(5);
    const namedActivity = buildRendererItemStream({
      entries: [spawn("covered"), activityEntry("a")],
      requests: [],
    });
    expect(namedActivity.some((item) => item.type === "multiAgentAction")).toBe(false);
    const messageOnly = buildRendererItemStream({
      entries: [spawn("covered"), activityEntry("a", { isMessage: true })],
      requests: [],
    });
    expect(messageOnly.some((item) => item.type === "multiAgentAction")).toBe(true);
  });
});
