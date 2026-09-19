import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { insertCanonicalHistorySearchDraft } from "./codex-canonical-history-search";
import { residentConversationTurns } from "./codex-turn-mutation";

function fixture() {
  const thread = buildAgentActivityV2CorpusThread([]);
  const state = createCodexCanonicalHydratedConversationState(thread, {
    hostId: "local",
    model: "model",
    reasoningEffort: null,
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
  });
  const template = state.turns[0]!;
  const turn = (turnId: string, turnStartedAtMs: number | null) => ({
    ...template,
    turnId,
    turnStartedAtMs,
    items: [],
  });
  return { state, turn };
}

describe("persisted search history placement", () => {
  test("overlap preserves resident entry identity and places surrounding turns without timestamps", () => {
    const f = fixture();
    const before = produce(f.state, (draft) => {
      replaceCanonicalHistoryDraft(draft, [f.turn("anchor", null)], false);
      const history = draft.turnHistory!.history;
      const resident = history.entitiesByKey["turn:anchor"]!;
      delete history.entitiesByKey["turn:anchor"];
      history.entitiesByKey["local-stable"] = resident;
      history.islands[0]!.entries = [{ key: "visible-stable", value: "local-stable" }];
    });
    let applied = false;
    const after = produce(before, (draft) => {
      applied = insertCanonicalHistorySearchDraft(draft, () => "window", {
        turns: [f.turn("older", null), f.turn("anchor", null), f.turn("newer", null)],
        olderCursor: "older-page",
        newerCursor: "newer-page",
      });
    });
    expect(applied).toBe(true);
    expect(residentConversationTurns(after).map((turn) => turn.turnId)).toEqual([
      "older",
      "anchor",
      "newer",
    ]);
    expect(after.turnHistory!.history.islands[0]!.entries[1]).toEqual({
      key: "visible-stable",
      value: "local-stable",
    });
    expect(after.turnHistory!.history.entitiesByKey["turn:anchor"]).toBeUndefined();
    expect(after.turnHistory!.history.isComplete).toBe(false);
  });

  test("refuses disconnected windows when any resident timestamp is unknown", () => {
    const f = fixture();
    const before = produce(f.state, (draft) =>
      replaceCanonicalHistoryDraft(draft, [f.turn("resident", null)], false),
    );
    let applied = true;
    const after = produce(before, (draft) => {
      applied = insertCanonicalHistorySearchDraft(draft, () => "window", {
        turns: [f.turn("match", 10)],
        olderCursor: null,
        newerCursor: null,
      });
    });
    expect(applied).toBe(false);
    expect(after).toBe(before);
  });

  test("orders disconnected windows by timestamp with deterministic Turn identity ties", () => {
    const f = fixture();
    const before = produce(f.state, (draft) =>
      replaceCanonicalHistoryDraft(draft, [f.turn("z", 20)], false),
    );
    const after = produce(before, (draft) => {
      insertCanonicalHistorySearchDraft(draft, () => "window", {
        turns: [f.turn("a", 20)],
        olderCursor: "older",
        newerCursor: "newer",
      });
    });
    expect(residentConversationTurns(after).map((turn) => turn.turnId)).toEqual(["a", "z"]);
    expect(after.turnHistory!.history.islands).toHaveLength(2);
  });
});
