/* oxlint-disable effecttsgo/strict-effect-provide -- This scoped test provides the callback runtime at its entry point. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { produce, type Draft } from "immer";
import { make } from "./CodexMainConversationEdit";
import { CodexMainConversationManagers, type MainConversationManager } from "./CodexMainConversationManagers";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities, createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { layer as callbacks } from "../app/ScopedCallbackRuntime";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";

it.effect("Main edit reverts retained identities then admits the original native input and context", () => Effect.gen(function* () {
  let state = produce(conversationFixture("thread", [turnFixture("message"), turnFixture("automatic")]), (draft) => {
    draft.turns[0]!.params.input = [{ type: "text", text: "original", text_elements: [] }, { type: "localImage", path: "/image.png" }];
    draft.turns[1]!.params.input = [];
    replaceCanonicalHistoryDraft(draft, draft.turns, false);
  });
  const calls: string[] = [];
  let admitted: ConversationFollowerTurnStart | undefined;
  const manager = { hostId: "local", generation: 1, assertCurrent: () => {}, stream: { getRole: () => ({ role: "owner" }) } } as unknown as MainConversationManager;
  const service = yield* make.pipe(
    Effect.provideService(CodexMainConversationManagers, { get: () => Effect.succeed(manager) } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(CodexMainConversationSettings, { awaitCurrent: () => Effect.sync(() => { calls.push("settings"); }) } as unknown as CodexMainConversationSettings["Service"]),
    Effect.provideService(ConversationEntityMap, { current: () => ({ readCanonicalState: () => state, mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => { state = produce(state, recipe); } }) } as unknown as ConversationEntityMap["Service"]),
    Effect.provideService(CodexGateway, { requestOnHost: (_host: string, method: string, params: unknown) => Effect.sync(() => {
      calls.push(method);
      assert.strictEqual(method, "thread/revert");
      assert.deepEqual(params, { threadId: "thread", beforeTurnId: "message" });
      return { thread: { id: "thread", sessionId: "new-session", path: null, cwd: "/returned", status: { type: "idle" } }, turnsBackwardsCursor: "retained", itemsBackwardsCursor: null };
    }) } as unknown as CodexGateway["Service"]),
    Effect.provideService(CodexAppServerCapabilities, { forHost: () => Effect.succeed(createCodexAppServerCapabilitySnapshot({ hostId: "local", generation: 1, userAgent: "0.153.0" })) } as unknown as CodexAppServerCapabilities["Service"]),
    Effect.provideService(CodexTurnCommands, {
      prepareNativeStart: (_id: string, _prompt: string, _overrides: unknown, request: TurnStartParams, context: ConversationFollowerTurnStart["context"]) => Effect.sync(() => { calls.push("prepare"); admitted = { request: { ...request, clientUserMessageId: "edit" }, context }; return admitted; }),
      inspectPreparedNativeStart: (operation: ConversationFollowerTurnStart) => Effect.succeed({ request: operation.request }),
      executePreparedNativeStart: () => Effect.sync(() => { calls.push("start"); return {}; }),
      releasePreparedNativeStart: () => { calls.push("release"); },
    } as unknown as CodexTurnCommands["Service"]),
  );
  yield* service.edit("local", "thread", { turnId: "message", message: "edited", writingBlockContextPrepared: true });
  assert.deepEqual(calls, ["settings", "thread/revert", "prepare", "start", "release"]);
  assert.deepEqual(admitted?.request.input, [{ type: "text", text: "edited", text_elements: [] }, { type: "localImage", path: "/image.png" }]);
  assert.strictEqual(admitted?.request.cwd, "/returned");
  assert.strictEqual(admitted?.context?.useAppServerPermissionDefault, true);
  assert.strictEqual(admitted?.context?.writingBlockContextPrepared, true);
  assert.strictEqual(residentConversationTurns(state).length, 0);
}).pipe(Effect.provide(callbacks)));
