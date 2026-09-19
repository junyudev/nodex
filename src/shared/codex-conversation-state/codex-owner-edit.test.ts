import { expect, test } from "vite-plus/test";
import { produce } from "immer";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { mutateCodexCanonicalRevert } from "./codex-rollback-state";
import { residentConversationTurns } from "./codex-turn-mutation";
import {
  editCanonicalLastUserTurn,
  replaceCanonicalEditedPrompt,
  type CanonicalEditClient,
} from "./codex-owner-edit";
import type {
  ThreadRevertResponse,
  Turn,
  TurnStartParams,
} from "@nodex/codex-app-server-protocol/v2";

function harness() {
  const turn = (id: string): Turn => ({
    id,
    status: "completed",
    itemsView: "full",
    items: [],
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    historyMode: "paginated" as const,
    turns: [turn("message"), turn("automatic")],
  };
  let state = createCodexCanonicalHydratedConversationState(thread, {
    hostId: "local",
    model: "m",
    reasoningEffort: null,
    cwd: "/workspace",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: [],
  });
  state = produce(state, (draft) => {
    draft.turns[0]!.params.input = [
      { type: "text", text: "# Files\n## My request for Codex:\nold", text_elements: [] },
      { type: "localImage", path: "/image.png" },
    ];
    draft.turns[1]!.params.input = [];
    replaceCanonicalHistoryDraft(draft, draft.turns, false);
  });
  const calls: string[] = [];
  const starts: TurnStartParams[] = [];
  const response: ThreadRevertResponse = {
    thread: { ...thread, turns: [], cwd: "/returned" },
    turnsBackwardsCursor: "retained",
    itemsBackwardsCursor: "items",
  };
  const client: CanonicalEditClient = {
    getConversation: () => state,
    awaitSettings: async () => {
      calls.push("settings");
    },
    supportsRevert: () => true,
    readPermissionOverrides: async () => {
      calls.push("config");
      return (cwd) => {
        calls.push(`permission:${cwd}`);
        return { approvalPolicy: "never" };
      };
    },
    revert: async (_id, before) => {
      calls.push(`revert:${before}`);
      return response;
    },
    rollback: async () => {
      throw new Error("unexpected rollback");
    },
    applyRevert: (_id, result, turns) => {
      state = produce(state, (draft) =>
        mutateCodexCanonicalRevert(draft, result, new Set(turns.map((turn) => turn.turnId))),
      );
    },
    applyRollback: () => {},
    start: async (request) => {
      starts.push(request);
    },
  };
  return { client, calls, starts, read: () => state };
}

test("editing the latest message also reverts trailing automatic turns and keeps non-text input", async () => {
  const f = harness();
  await editCanonicalLastUserTurn(f.client, "id", {
    turnId: "message",
    message: "new",
    shouldSendPermissionOverrides: true,
  });
  expect(f.calls).toEqual(["settings", "config", "revert:message", "permission:/returned"]);
  expect(f.starts[0]?.input).toEqual([
    { type: "text", text: "# Files\n## My request:\nnew\n", text_elements: [] },
    { type: "localImage", path: "/image.png" },
  ]);
  expect(f.starts[0]?.turnTrigger).toBe("edit_user_message");
  expect(residentConversationTurns(f.read())).toEqual([]);
  expect(f.read().turnHistory?.history.islands.at(-1)?.olderBoundary).toMatchObject({
    status: "available",
    handle: { cursor: "retained", oldestLoadedTurnId: null },
  });
  expect(f.read().paginatedHistory).toEqual({ itemsBackwardsCursor: "items" });
});

test("prompt editing replaces only the last request marker and resets plain text", () => {
  expect(
    replaceCanonicalEditedPrompt(
      "one\n## My request:\nquoted\n## My request for Codex:\nold",
      "new",
    ),
  ).toBe("one\n## My request:\nquoted\n## My request:\nnew\n");
  expect(replaceCanonicalEditedPrompt("plain old", "new")).toBe("new");
});
