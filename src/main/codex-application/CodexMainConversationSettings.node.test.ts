import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { produce, type Draft } from "immer";
import { make } from "./CodexMainConversationSettings";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { conversationFixture } from "./conversation-test-fixture";
import { mutateCanonicalThreadSettingsPatch } from "../../shared/codex-conversation-state/codex-thread-settings-update";

it.effect(
  "Main owner applies model controls, preserves native notifications and ignores historical policy",
  () =>
    Effect.gen(function* () {
      let state = conversationFixture("thread");
      const calls: { method: string; params: unknown }[] = [];
      const manager = {
        hostId: "local",
        generation: 1,
        assertCurrent: () => {},
        stream: { getRole: () => ({ role: "owner" }) },
      } as unknown as MainConversationManager;
      const service = yield* make.pipe(
        Effect.provideService(CodexMainConversationManagers, {
          get: () => Effect.succeed(manager),
        } as unknown as CodexMainConversationManagers["Service"]),
        Effect.provideService(ConversationEntityMap, {
          current: () => ({
            readCanonicalState: () => state,
            mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
              state = produce(state, recipe);
            },
          }),
        } as unknown as ConversationEntityMap["Service"]),
        Effect.provideService(CodexGateway, {
          requestOnHost: (_host: string, method: string, params: unknown) =>
            Effect.sync(() => {
              calls.push({ method, params });
              if (method === "thread/settings/update")
                state = produce(state, (draft) =>
                  mutateCanonicalThreadSettingsPatch(draft, { model: "notification" }),
                );
              return {};
            }),
        } as unknown as CodexGateway["Service"]),
      );
      const historicalPayload = {
        model: "requested",
        approvalPolicy: "on-request" as const,
        approvalsReviewer: "guardian_subagent" as const,
        sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
        permissions: "old-restricted-profile",
      };
      assert.strictEqual(yield* service.update("local", "thread", historicalPayload), true);
      assert.strictEqual(state.latestModel, "notification");
      assert.deepEqual(calls, [
        { method: "thread/settings/update", params: { threadId: "thread", model: "requested" } },
      ]);
      assert.strictEqual(
        yield* service.update("local", "thread", { model: "ignored" }, { ifEffortEquals: "low" }),
        false,
      );
      assert.strictEqual(calls.length, 1);
    }),
);
