import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { InboxChatAgent } from "../../shared/inbox";
import { InboxPreparedConfirmationSchema } from "../../shared/schemas/inbox";
import { captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";

type Provider = Effect.Success<ReturnType<AgentRuntimeApplication["Service"]["catalog"]>>[number];

const LIBRARY = { kind: "library" } as const;
const effort = {
  id: "reasoningEffort",
  label: "Effort",
  type: "select" as const,
  currentValue: "medium",
  options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
};
const codex: Provider = {
  instanceId: "codex",
  displayName: "Codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T00:00:00.000Z",
  models: [
    {
      slug: "default-model",
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [effort] },
    },
    {
      slug: "deep-model",
      name: "Deep",
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    },
  ],
  slashCommands: [],
  skills: [],
};
const deep: InboxChatAgent = {
  instanceId: "codex",
  model: "deep-model",
  reasoningEffort: "high",
  serviceTier: null,
};

it.effect("freezes a new chat on the model chosen for it, or else on the Inbox's own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox } = yield* inboxOverRealCore(Effect.void, () => Effect.succeed([codex]));
      const { pageId } = yield* captureInbox(inbox, "Compare both homepage positions");
      const [item] = (yield* inbox.window({ scope: LIBRARY, filter: "inbox" })).items;
      if (!item) return assert.fail("Missing captured message");
      const draft = {
        kind: "direct" as const,
        storeEpoch: (yield* inbox.summary({ scope: LIBRARY })).storeEpoch,
        pageIds: [pageId],
        basis: [item.basis],
        action: { type: "new_chat" as const, projectId: null, prompt: "Compare both positions" },
      };

      const inboxOwn = yield* inbox.prepareConfirmation(draft);
      assert.deepEqual(inboxOwn.executionSelection?.modelSelection, {
        instanceId: "codex",
        model: "default-model",
      });

      const chosen = yield* inbox.prepareConfirmation({ ...draft, chatAgent: deep });
      assert.deepEqual(chosen.executionSelection?.modelSelection, {
        instanceId: "codex",
        model: "deep-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      // The prepared handoff replays unchanged: the choice survives only as its frozen selection.
      assert.deepEqual(InboxPreparedConfirmationSchema.parse(chosen), chosen);

      // Only a new chat runs on a chosen model.
      const kept = yield* inbox.prepareConfirmation({
        ...draft,
        action: { type: "keep" },
        chatAgent: deep,
      });
      assert.isNull(kept.executionSelection);

      // A choice the catalog cannot run is refused rather than replaced by another model.
      const retired = yield* Effect.flip(
        inbox.prepareConfirmation({ ...draft, chatAgent: { ...deep, model: "retired-model" } }),
      );
      assert.match(retired.message, /selected model is unavailable/);
    }),
  ),
);
