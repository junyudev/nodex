import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import {
  inboxNewChatAction,
  type InboxChatAgent,
  type InboxDispatchAction,
} from "../../shared/inbox";
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

it.effect("freezes a new chat on the Agent its decision chose, or else on the Inbox's own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox } = yield* inboxOverRealCore(Effect.void, () => Effect.succeed([codex]));
      const { pageId } = yield* captureInbox(inbox, "Compare both homepage positions");
      const [item] = (yield* inbox.window({ scope: LIBRARY, filter: "inbox" })).items;
      if (!item) return assert.fail("Missing captured message");
      const plain = inboxNewChatAction(null, "Compare both positions");
      const draft = (action: InboxDispatchAction) => ({
        kind: "direct" as const,
        storeEpoch: "",
        pageIds: [pageId],
        basis: [item.basis],
        action,
      });
      const storeEpoch = (yield* inbox.summary({ scope: LIBRARY })).storeEpoch;
      const prepare = (action: InboxDispatchAction) =>
        inbox.prepareConfirmation({ ...draft(action), storeEpoch });

      const inboxOwn = yield* prepare(plain);
      assert.deepEqual(inboxOwn.executionSelection?.modelSelection, {
        instanceId: "codex",
        model: "default-model",
      });
      assert.isNull(inboxOwn.executionSelection?.orchestration ?? null);

      const planned = yield* prepare({
        ...plain,
        agent: deep,
        delegates: [{ work: "The data migration", agent: { ...deep, reasoningEffort: "low" } }],
        plan: "Write the migration before the UI.",
      });
      assert.deepEqual(planned.executionSelection?.modelSelection, {
        instanceId: "codex",
        model: "deep-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      // The delegation instructions are written once, against the catalog that resolved the chat.
      const orchestration = planned.executionSelection?.orchestration ?? "";
      assert.include(orchestration, "Write the migration before the UI.");
      assert.include(
        orchestration,
        '{"providerInstanceId":"codex","model":"deep-model","options":[{"id":"reasoningEffort","value":"low"}]}',
      );
      // The prepared handoff replays unchanged.
      assert.deepEqual(InboxPreparedConfirmationSchema.parse(planned), planned);

      // A choice the catalog cannot run is refused rather than replaced by another model.
      const retired = yield* Effect.flip(
        prepare({ ...plain, agent: { ...deep, model: "retired-model" } }),
      );
      assert.match(retired.message, /selected model is unavailable/);
    }),
  ),
);
