import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { CodexConversationEntityDocument } from "./codex-conversation-entity-document";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { mutateCodexConversationFrameTextDeltas } from "./codex-conversation-state/codex-frame-text-delta";
import { mutateCodexConversationCommandOutput } from "./codex-conversation-state/codex-command-execution-stream";
import { CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX } from "./codex-conversation-state/codex-command-output-queue";
import {
  buildCodexTranscriptAcceptedMutation,
  applyCodexTranscriptTextChange,
  projectCodexTranscriptUpdate,
  type CodexTranscriptTextChange,
} from "./codex-transcript-projection";

const command = (text: string | null): ThreadItem => ({
  type: "commandExecution",
  id: "item",
  command: "echo",
  cwd: "/tmp",
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: text,
  exitCode: null,
  durationMs: null,
});
function fixture(item: ThreadItem) {
  return createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: "thread",
      turns: [
        {
          id: "turn",
          rootTurnId: null,
          status: "inProgress",
          itemsView: "full",
          items: [item],
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      ],
    },
    {
      hostId: "local",
      model: "fixture",
      reasoningEffort: null,
      cwd: "/tmp",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    },
  );
}
const update = {
  conversationId: "thread",
  turnId: "turn",
  itemId: "item",
  target: { type: "plan" as const },
  delta: " next",
};

describe("accepted canonical text mutation evidence", () => {
  test("long append uses post-write positions without comparing previously accepted text", () => {
    const before = fixture({ type: "plan", id: "item", text: "x".repeat(1_000_000) });
    const changes: CodexTranscriptTextChange[] = [];
    const mutation = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) =>
        mutateCodexConversationFrameTextDeltas(draft, [update, { ...update, delta: " final" }], {
          now: () => 1,
          onAcceptedText: (change) => changes.push(change),
        }),
      )!;
    const startsWith = vi.spyOn(String.prototype, "startsWith").mockImplementation(() => {
      throw new Error("Unexpected comparison of prior text");
    });
    let accepted;
    try {
      accepted = buildCodexTranscriptAcceptedMutation(
        before,
        mutation.after,
        mutation.patches,
        changes,
      );
    } finally {
      startsWith.mockRestore();
    }
    expect(accepted?.changes).toEqual([
      {
        type: "text",
        key: { hostId: "local", threadId: "thread", entityKey: "turn:turn", itemId: "item" },
        target: { field: "text" },
        edits: [{ at: 1_000_000, deleteCount: 0, insert: " next" }],
      },
      {
        type: "text",
        key: { hostId: "local", threadId: "thread", entityKey: "turn:turn", itemId: "item" },
        target: { field: "text" },
        edits: [{ at: 1_000_005, deleteCount: 0, insert: " final" }],
      },
    ]);
    expect(
      projectCodexTranscriptUpdate(
        { hostId: "local", threadId: "thread" },
        before,
        mutation.after,
        { patches: mutation.patches, acceptedTranscriptText: accepted },
      ),
    ).toEqual({ type: "changes", changes });
  });

  test("missing/foreign/invalid deltas never emit accepted writes", () => {
    const before = fixture({ type: "reasoning", id: "item", summary: [], content: [] });
    const onAcceptedText = vi.fn();
    const receipt = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) =>
        mutateCodexConversationFrameTextDeltas(
          draft,
          [
            { ...update, conversationId: "other" },
            update,
            { ...update, target: { type: "reasoningSummary", summaryIndex: -1 } },
          ],
          { now: () => 1, onAcceptedText },
        ),
      )!;
    expect(receipt.after).toBe(before);
    expect(onAcceptedText).not.toHaveBeenCalled();
  });

  test("reasoning parts are accepted before their sequential text edits", () => {
    const before = fixture({ type: "reasoning", id: "item", summary: [], content: [] });
    const changes: CodexTranscriptTextChange[] = [];
    const receipt = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) =>
        mutateCodexConversationFrameTextDeltas(
          draft,
          [
            { ...update, target: { type: "reasoningSummary", summaryIndex: 0 }, delta: "" },
            { ...update, target: { type: "reasoningSummary", summaryIndex: 0 }, delta: "one" },
            { ...update, target: { type: "reasoningContent", contentIndex: 0 }, delta: "full" },
          ],
          { now: () => 1, onAcceptedText: (change) => changes.push(change) },
        ),
      )!;
    const accepted = buildCodexTranscriptAcceptedMutation(
      before,
      receipt.after,
      receipt.patches,
      changes,
    )!;
    let replayed = before.turns[0]!.items[0]!;
    for (const change of accepted.changes)
      replayed = applyCodexTranscriptTextChange(replayed, change);
    expect(replayed).toEqual(receipt.after.turns[0]!.items[0]);
    expect(accepted.changes.map(({ type }) => type)).toEqual([
      "text-parts",
      "text",
      "text",
      "text-parts",
      "text",
    ]);
  });

  test.each([
    { current: null, delta: "new" },
    { current: "old", delta: " append" },
    { current: "x".repeat(19_999), delta: "tail" },
    { current: `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}${"x".repeat(20_000)}`, delta: "tail" },
    { current: "old", delta: "y".repeat(20_001) },
  ])(
    "bounded command edits exactly reproduce accepted tail/prefix output %#",
    ({ current, delta }) => {
      const before = fixture(command(current));
      const changes: CodexTranscriptTextChange[] = [];
      const receipt = new CodexConversationEntityDocument()
        .withCanonicalState(before)
        .mutate((draft) =>
          mutateCodexConversationCommandOutput(
            draft,
            { conversationId: "thread", turnId: "turn", itemId: "item", delta },
            { onAcceptedText: (change) => changes.push(change) },
          ),
        )!;
      const accepted = buildCodexTranscriptAcceptedMutation(
        before,
        receipt.after,
        receipt.patches,
        changes,
      )!;
      let replayed = before.turns[0]!.items[0]!;
      for (const change of accepted.changes)
        replayed = applyCodexTranscriptTextChange(replayed, change);
      expect(replayed).toEqual(receipt.after.turns[0]!.items[0]);
    },
  );

  test("mixed item writes and stale host/position evidence require ordinary item updates", () => {
    const before = fixture({ type: "plan", id: "item", text: "start" });
    const changes: CodexTranscriptTextChange[] = [];
    const receipt = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) => {
        mutateCodexConversationFrameTextDeltas(draft, [update], {
          now: () => 1,
          onAcceptedText: (change) => changes.push(change),
        });
        draft.turns[0]!.items.push({ type: "plan", id: "added", text: "other" });
      })!;
    expect(
      buildCodexTranscriptAcceptedMutation(before, receipt.after, receipt.patches, changes),
    ).toBeUndefined();
    const textOnly = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) => {
        (draft.turns[0]!.items[0] as Extract<ThreadItem, { type: "plan" }>).text += update.delta;
      })!;
    expect(
      buildCodexTranscriptAcceptedMutation(
        before,
        textOnly.after,
        textOnly.patches,
        changes.map((change) => ({ ...change, key: { ...change.key, hostId: "remote" } })),
      ),
    ).toBeUndefined();
    const wrongPosition: CodexTranscriptTextChange = {
      type: "text",
      key: changes[0]!.key,
      target: { field: "text" },
      edits: [{ at: 6, deleteCount: 0, insert: update.delta }],
    };
    expect(
      buildCodexTranscriptAcceptedMutation(before, textOnly.after, textOnly.patches, [
        wrongPosition,
      ]),
    ).toBeUndefined();
  });
});
