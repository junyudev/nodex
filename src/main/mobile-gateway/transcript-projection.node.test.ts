import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { ChatItem, ChatSnapshot } from "@nodex/mobile-protocol";
import { describe, expect, test } from "vitest";
import {
  approvalOptions,
  boundChatItem,
  chatItemId,
  chatPatch,
  parseChatItemId,
  projectRequests,
  projectRuntimeItem,
  runtimeActivity,
  transcriptWindow,
  utf8Tail,
} from "./transcript-projection";

const at = "2026-11-04T12:00:00.000Z";
const base = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
} as const;

const assistant = (id: string, text: string): ChatItem => ({
  kind: "assistant",
  id,
  at,
  text,
  streaming: true,
  truncated: false,
});
const snapshot = (items: ChatItem[]): ChatSnapshot => ({
  sessionId: "chat",
  revision: 0,
  title: "Title",
  projectName: null,
  items,
  historyCursor: null,
  state: {
    status: "running",
    activeRunId: "run",
    queuedCount: 0,
    requests: [],
    agentLabel: null,
    sendBlockedReason: null,
  },
});

describe("Mobile transcript", () => {
  test.each([
    [{ ...base, type: "command_execution", input: "echo hi", output: "hi" }, "command"],
    [{ ...base, type: "file_change", fileName: "a.md", diffStr: "+ added" }, "file"],
    [{ ...base, type: "file_search", pattern: "notes" }, "search"],
    [{ ...base, type: "web_search", patterns: ["notes"] }, "web"],
    [
      { ...base, type: "dynamic_tool", toolName: "read_page", input: {}, output: { id: 3 } },
      "tool",
    ],
    [
      {
        ...base,
        type: "subagent",
        subagentId: "child",
        childThreadId: "child-thread",
        driver: "codex",
        providerInstanceId: "codex",
        origin: "app_owned",
        prompt: "Read the Page",
        result: "Done",
      },
      "agent",
    ],
    [
      { ...base, type: "proposed_plan", planId: "plan", markdown: "Steps", streaming: false },
      "plan",
    ],
  ] as const)("projects a work category", (item, category) => {
    expect(projectRuntimeItem("chat", item satisfies AgentTurnItem)).toMatchObject({
      kind: "activity",
      category,
      at,
    });
  });

  test("a message reads as arriving only while its own run is live", () => {
    const message = {
      ...base,
      type: "assistant_message",
      messageId: "message",
      text: "Half a repl",
      streaming: true,
    } satisfies AgentTurnItem;
    const streaming = (activeRunId: string | null) =>
      projectRuntimeItem("chat", message, undefined, undefined, { activeRunId });
    expect(streaming(message.runId)).toMatchObject({ kind: "assistant", streaming: true });
    expect(streaming("the-run-that-resumed-it")).toMatchObject({ streaming: false });
    expect(streaming(null)).toMatchObject({ streaming: false });
  });

  test("preserves queued messages and inherited item coordinates", () => {
    const item = projectRuntimeItem(
      "chat",
      {
        ...base,
        type: "user_message",
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "queued_turn",
        messageId: "message",
        text: "Read this",
        attachments: [],
      },
      "ancestor",
      "source-item",
      { queued: true },
    );
    expect(item).toMatchObject({ kind: "user", queued: true, files: [] });
    if (!item) throw new Error("A user message is always shown");
    expect(parseChatItemId(item.id)).toEqual(["ancestor", "source-item", null]);
    expect(parseChatItemId(item.id + "=")).toBeNull();
    expect(chatItemId("ancestor", "source-item")).toBe(item.id);
  });

  test("keeps valid UTF-8 tails and makes the older window resumable", () => {
    expect(utf8Tail("a🙂b", 4)).toEqual({ text: "b", truncated: true });
    expect(utf8Tail("a🙂b", 5)).toEqual({ text: "🙂b", truncated: true });
    const rows = Array.from({ length: 100 }, (_, index) => ({
      item: assistant(String(index), "a"),
      cursor: String(index),
    }));
    const small = transcriptWindow(rows, false);
    expect(small.items).toHaveLength(80);
    expect(small.items[0]?.id).toBe("79");
    expect(small.items.at(-1)?.id).toBe("0");
    expect(small.historyCursor).toBe("79");
    const large = transcriptWindow(
      rows.map((row) => ({
        ...row,
        item: assistant(row.item.id, "a".repeat(80 * 1024) + "tail"),
      })),
      false,
    );
    expect(large.items).toHaveLength(3);
    expect(large.historyCursor).toBe("2");
    expect(large.items[0]).toMatchObject({ kind: "assistant", truncated: true });
    expect(Buffer.byteLength(JSON.stringify(large.items))).toBeLessThan(256 * 1024);
    const command = projectRuntimeItem("chat", {
      ...base,
      type: "command_execution",
      input: "echo",
      output: "x".repeat(4096) + "tail",
    });
    if (!command) throw new Error("A command is always shown");
    expect(boundChatItem(command)).toMatchObject({
      outputTruncated: true,
      output: expect.stringMatching(/tail$/u),
    });
  });

  test("appends a UTF-16 suffix and upserts after replacement or settlement", () => {
    const previous = snapshot([assistant("item", "🙂")]);
    const added = assistant("item", "🙂 more");
    expect(chatPatch(previous, snapshot([added]))).toEqual([
      { op: "append", itemId: "item", offset: 2, text: " more" },
    ]);
    const replaced = assistant("item", "Different");
    expect(chatPatch(previous, snapshot([replaced]))).toEqual([{ op: "upsert", item: replaced }]);
    const done = { ...added, streaming: false };
    expect(chatPatch(previous, snapshot([done]))).toEqual([{ op: "upsert", item: done }]);
  });

  test("preserves provider option identities and elevates a pending approval", () => {
    const options = approvalOptions({
      ...base,
      type: "approval_request",
      requestId: "request",
      requestKind: "command",
      options: [
        { label: "Allow once", decision: "accept", optionId: "once" },
        { label: "Allow this workspace", decision: "accept", optionId: "workspace" },
      ],
    });
    expect(options.map(({ optionId }) => optionId)).toEqual(["once", "workspace"]);
    expect(options[0]?.id).not.toBe(options[1]?.id);
    expect(
      runtimeActivity({
        sessionId: "chat",
        threadId: "thread",
        status: "running",
        activeRunId: "run",
        pendingRequestCount: 1,
        approvalPrompt: "Run git status?",
        backgroundTasks: [],
        providerInstanceId: "agent",
        model: "model",
        updatedAt: at,
      }),
    ).toEqual({
      sessionId: "chat",
      status: "waiting",
      pendingRequestCount: 1,
      attention: "Run git status?",
    });
  });
});

describe("pending requests", () => {
  // A real snapshot carries its items only as display rows.
  const snapshotOf = (items: readonly unknown[], requests: readonly unknown[]) =>
    ({
      turnItems: [],
      visibleTurnItems: (items as readonly { id: string }[]).map((item) => ({
        item,
        sourceItemId: item.id,
        sourceThreadId: "thread",
      })),
      runtimeRequests: requests,
    }) as unknown as AgentSnapshot["projection"];
  const live = (id: string, status = "pending") => ({
    id,
    status,
    responseCapability: { type: "live" },
  });
  const approval = (overrides: Record<string, unknown> = {}) => ({
    ...base,
    id: "approval",
    type: "approval_request",
    requestId: "request",
    requestKind: "command",
    prompt: "touch ~/file",
    status: "waiting",
    ...overrides,
  });

  test("finds an approval in the snapshot's rows, refusal first and the exact command shown", () => {
    const [request] = projectRequests(
      snapshotOf(
        [
          approval({
            options: [
              { decision: "accept", label: "Approve once" },
              { decision: "cancel", label: "Cancel" },
            ],
          }),
        ],
        [live("request")],
      ),
    );
    expect(request).toMatchObject({ kind: "approval", requestId: "request", runId: "run" });
    if (request?.kind !== "approval") throw new Error("Expected an approval");
    expect(request.detail).toBe("touch ~/file");
    expect(request.options.map(({ label, tone }) => [label, tone])).toEqual([
      ["Decline and stop", "danger"],
      ["Approve", "primary"],
    ]);
  });

  test("offers every decision when the provider advertises none", () => {
    const [request] = projectRequests(snapshotOf([approval()], [live("request")]));
    if (request?.kind !== "approval") throw new Error("Expected an approval");
    expect(request.options.map(({ label }) => label)).toEqual([
      "Decline",
      "Approve",
      "Allow for this chat",
      "Decline and stop",
    ]);
  });

  test("ignores an approval that was answered or can no longer be answered", () => {
    expect(projectRequests(snapshotOf([approval()], [live("request", "resolved")]))).toEqual([]);
    expect(
      projectRequests(
        snapshotOf([approval()], [{ ...live("request"), responseCapability: { type: "gone" } }]),
      ),
    ).toEqual([]);
  });

  test("keeps a question for a secret on the desktop", () => {
    const question = { id: "q", question: "Token?", header: "", options: [], isSecret: true };
    expect(
      projectRequests(
        snapshotOf(
          [
            {
              ...base,
              id: "input",
              type: "user_input_request",
              requestId: "request",
              questions: [question],
            },
          ],
          [live("request")],
        ),
      ),
    ).toEqual([]);
  });
});

describe("what the transcript leaves out", () => {
  test.each([
    { type: "approval_request", requestId: "r", requestKind: "command" },
    { type: "checkpoint" },
    { type: "user_input_request", requestId: "r", questions: [], status: "waiting" },
  ])("hides $type", (item) => {
    expect(
      projectRuntimeItem("chat", { ...base, id: "i", ...item } as unknown as AgentTurnItem),
    ).toBeNull();
  });
});
