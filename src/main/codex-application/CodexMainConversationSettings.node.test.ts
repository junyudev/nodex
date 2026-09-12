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
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { conversationFixture } from "./conversation-test-fixture";
import { mutateCanonicalThreadSettingsPatch } from "../../shared/codex-conversation-state/codex-thread-settings-update";

it.effect(
  "Main owner preserves native settings notification while forwarding reviewer update",
  () =>
    Effect.gen(function* () {
      let state = conversationFixture("thread");
      const calls: string[] = [];
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
          requestOnHost: (_host: string, method: string) =>
            Effect.sync(() => {
              calls.push(method);
              if (method === "thread/settings/update")
                state = produce(state, (draft) =>
                  mutateCanonicalThreadSettingsPatch(draft, { model: "notification" }),
                );
              return {};
            }),
        } as unknown as CodexGateway["Service"]),
        Effect.provideService(CodexAppServerCapabilities, {
          forHost: () =>
            Effect.succeed(
              createCodexAppServerCapabilitySnapshot({
                hostId: "local",
                generation: 1,
                userAgent: "0.153.0-alpha.4",
              }),
            ),
        } as unknown as CodexAppServerCapabilities["Service"]),
      );
      assert.strictEqual(
        yield* service.update(
          "local",
          "thread",
          { model: "requested", approvalsReviewer: "user" },
          undefined,
          "turn",
        ),
        true,
      );
      assert.strictEqual(state.latestModel, "notification");
      assert.deepEqual(calls, ["thread/settings/update", "turn/settings/update"]);
      assert.strictEqual(
        yield* service.update("local", "thread", { model: "ignored" }, { ifEffortEquals: "low" }),
        false,
      );
      assert.strictEqual(calls.length, 2);
    }),
);
