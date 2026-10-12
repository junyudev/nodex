import { assert, it } from "@effect/vitest";
import { produce } from "immer";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { codexCanonicalConversationActivityStatus } from "./CodexConversationProjection";

function fixture() {
  return createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread(), {
    hostId: "local",
    model: "fixture-model",
    reasoningEffort: null,
    cwd: "/work",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/work"],
  });
}

it("canonical active metadata remains authoritative after the legacy array is cleared", () => {
  const legacy = fixture();
  const state = produce(legacy, (draft) => {
    replaceCanonicalHistoryDraft(
      draft,
      legacy.turns.map((turn) => ({ ...turn, status: "inProgress" })),
      true,
    );
  });
  assert.deepStrictEqual(state.turns, []);
  assert.strictEqual(codexCanonicalConversationActivityStatus(state), "active");
});

it("a completed canonical native Turn suppresses its stale running legacy copy", () => {
  const legacy = fixture();
  const canonical = produce(legacy, (draft) => {
    replaceCanonicalHistoryDraft(
      draft,
      legacy.turns.map((turn) => ({ ...turn, status: "completed" })),
      true,
    );
  });
  const state = {
    ...canonical,
    turns: legacy.turns.map((turn) => ({ ...turn, status: "inProgress" as const })),
  };
  assert.strictEqual(codexCanonicalConversationActivityStatus(state), "idle");
});

it.each(["unmatched-native", "optimistic-local"] as const)(
  "%s legacy activity supplements canonical history without replacing its identities",
  (kind) => {
    const legacy = fixture();
    const canonical = produce(legacy, (draft) => {
      replaceCanonicalHistoryDraft(
        draft,
        legacy.turns.map((turn) => ({ ...turn, status: "completed" })),
        true,
      );
    });
    const state = {
      ...canonical,
      turns: legacy.turns.map((turn) => ({
        ...turn,
        turnId: kind === "optimistic-local" ? null : "new-native-turn",
        status: "inProgress" as const,
      })),
    };
    assert.strictEqual(codexCanonicalConversationActivityStatus(state), "active");
  },
);

it("legacy-only activity and an absent conversation retain their status contract", () => {
  const state = fixture();
  assert.strictEqual(
    codexCanonicalConversationActivityStatus({
      ...state,
      turns: state.turns.map((turn) => ({ ...turn, status: "inProgress" })),
    }),
    "active",
  );
  assert.strictEqual(
    codexCanonicalConversationActivityStatus({
      ...state,
      turns: state.turns.map((turn) => ({ ...turn, status: "completed" })),
    }),
    "idle",
  );
  assert.strictEqual(codexCanonicalConversationActivityStatus(null), "idle");
});
