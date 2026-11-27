import { createUuidV7 } from "../../shared/uuid-v7";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  type AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../../main/agent-runtime/AgentRuntimeApplication";
import {
  inboxNewChatAction,
  type InboxAgentChoice,
  type InboxDispatchAction,
} from "../../shared/inbox";
import { InboxPreparedConfirmationSchema } from "../../shared/schemas/inbox";
import { bindTestRouting, captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";

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
const deep: InboxAgentChoice = {
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

      const chosen = yield* prepare({ ...plain, agent: deep });
      assert.deepEqual(chosen.executionSelection?.modelSelection, {
        instanceId: "codex",
        model: "deep-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      // The prepared handoff replays unchanged.
      assert.deepEqual(InboxPreparedConfirmationSchema.parse(chosen), chosen);

      // A choice the catalog cannot run is refused rather than replaced by another model.
      const retired = yield* Effect.flip(
        prepare({ ...plain, agent: { ...deep, model: "retired-model" } }),
      );
      assert.match(retired.message, /selected model is unavailable/);
    }),
  ),
);

it.effect("freezes Inbox Start defaults and replays the dispatch after settings change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let settings: InboxSettings = {
        ...DEFAULT_INBOX_SETTINGS,
        suggestions: "off",
        chatAgent: deep,
        newChatsUseWorktrees: true,
      };
      let catalog = [codex];
      const { inbox, projectId } = yield* inboxOverRealCore(
        Effect.void,
        () => Effect.succeed(catalog),
        () => settings,
      );
      const scope = { kind: "project" as const, projectId };
      const { storeEpoch } = yield* inbox.summary({ scope });
      const input = {
        scope,
        body: "Compare both homepage drafts",
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        operationId: createBoundedOperationId("test.inbox.capture-start"),
        storeEpoch,
        start: { kind: "routed" as const },
      };
      yield* inbox.send(input);
      const [work] = yield* inbox.outbox(16);
      assert.equal(work?.project_id, projectId);
      assert.deepEqual(work?.execution_selection, {
        model_selection: {
          instanceId: "codex",
          model: "deep-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        interaction_mode: "default",
        worktree: true,
      });
      assert.deepEqual(yield* inbox.suggestionRequests(16), []);

      // A retry must return the original decision even if the same request would route now.
      settings = { ...settings, suggestions: "on_request", newChatsUseWorktrees: false };
      catalog = [];
      yield* inbox.send(input);
      assert.deepEqual(yield* inbox.outbox(16), [work]);
      assert.deepEqual(yield* inbox.suggestionRequests(16), []);
    }),
  ),
);

it.effect.each(["new_chat", "routed"] as const)(
  "shows a failed %s start on its saved Inbox row when the Agent is unavailable",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox, projectId } = yield* inboxOverRealCore(
          Effect.void,
          () => Effect.succeed([]),
          () => ({ ...DEFAULT_INBOX_SETTINGS, suggestions: "off", chatAgent: deep }),
        );
        const scope = { kind: "project" as const, projectId };
        const { storeEpoch } = yield* inbox.summary({ scope });
        const pageId = createUuidV7();
        const body = "Compare both homepage drafts";
        const sent = yield* inbox.send({
          scope,
          body,
          pageId,
          documentId: createUuidV7(),
          issuedAt: Date.now(),
          operationId: createBoundedOperationId("test.inbox.capture-start"),
          storeEpoch,
          start: { kind },
        });
        assert.equal(sent.value.state, "saved");
        const { items } = yield* inbox.window({ scope, filter: "inbox" });
        const entry = items.find((item) => item.pageId === pageId);
        assert.equal(entry?.body, body);
        assert.isTrue(entry?.waiting);
        assert.equal(entry?.suggestionState, "failed");
        assert.equal(entry?.suggestionError, "The configured Agent is unavailable");
        assert.isEmpty(yield* inbox.outbox(16));
      }),
    ),
);

it.effect(
  "retries a routed start after a catalog interruption and records an actionable refusal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let catalog: ReturnType<AgentRuntimeApplication["Service"]["catalog"]> = Effect.fail(
          new AgentRuntimeApplicationError({
            operation: "catalog",
            message: "The Agent connection was interrupted",
          }),
        );
        const { inbox, client } = yield* inboxOverRealCore(
          Effect.void,
          () => catalog,
          () => ({ ...DEFAULT_INBOX_SETTINGS, suggestions: "on_request", chatAgent: deep }),
        );
        const { storeEpoch } = yield* inbox.summary({ scope: LIBRARY });
        const pageId = createUuidV7();
        yield* inbox.send({
          scope: LIBRARY,
          body: "Compare both homepage drafts",
          pageId,
          documentId: createUuidV7(),
          issuedAt: Date.now(),
          operationId: createBoundedOperationId("test.inbox.capture-start"),
          storeEpoch,
          start: { kind: "routed" },
        });
        const [request] = yield* inbox.suggestionRequests(1);
        const decisionSessionId = yield* bindTestRouting({ inbox, client }, request!);
        yield* inbox.settleSuggestion({
          request_id: request!.request_id,
          decision_session_id: decisionSessionId,
          generation: request!.generation,
          titles: [],
          suggestions: [
            {
              proposal_id: createUuidV7(),
              page_ids: [pageId],
              action: { type: "new_chat", project_id: null, prompt: "Compare the drafts" },
              summary: "Compare the drafts",
              explicit_request: false,
            },
          ],
          error: null,
          automatic_dispatch: false,
        });

        const readRow = inbox
          .window({ scope: LIBRARY, filter: "inbox" })
          .pipe(Effect.map(({ items }) => items.find((item) => item.pageId === pageId)));

        yield* inbox.autoConfirm;
        assert.equal((yield* readRow)?.suggestionState, "settled");
        assert.isEmpty(yield* inbox.outbox(16));

        catalog = Effect.succeed([]);
        yield* inbox.autoConfirm;
        const entry = yield* readRow;
        assert.equal(entry?.proposal?.state, "open");
        assert.equal(entry?.suggestionState, "failed");
        assert.equal(entry?.suggestionError, "The configured Agent is unavailable");

        catalog = Effect.succeed([codex]);
        yield* inbox.autoConfirm;
        assert.isEmpty(yield* inbox.outbox(16));
        assert.equal((yield* readRow)?.suggestionState, "failed");
      }),
    ),
);

it.effect(
  "derives the kept skills from the proposal and reports another Agent's availability",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const skills = [
          { name: "audit", reason: "Audit the homepage." },
          { name: "review", reason: "Review the current copy." },
        ];
        const { inbox, client, projectId } = yield* inboxOverRealCore(
          Effect.void,
          () => Effect.succeed([codex, { ...codex, instanceId: "other-agent" }]),
          () => DEFAULT_INBOX_SETTINGS,
          {
            executionWorkspace: () =>
              Effect.succeed({ available: true, workspaceRoot: "/repo", sourceRoots: ["/repo"] }),
            skillsForWorkspace: ({ instanceId }) =>
              Effect.succeed(
                skills
                  .filter(({ name }) => instanceId === "codex" || name === "review")
                  .map(({ name }) => ({ name, path: `/repo/${name}/SKILL.md`, enabled: true })),
              ),
          },
        );
        const { pageId } = yield* captureInbox(inbox, "Compare both homepage positions");
        const entry = (yield* inbox.entry(pageId))!;
        const basis = [entry.basis];
        yield* inbox.requestSuggestion({
          requestId: createUuidV7(),
          mode: "auto",
          pageIds: [pageId],
          basis,
        });
        const [request] = yield* inbox.suggestionRequests(1);
        const decisionSessionId = yield* bindTestRouting({ inbox, client }, request!);
        yield* inbox.settleSuggestion({
          request_id: request!.request_id,
          decision_session_id: decisionSessionId,
          generation: request!.generation,
          titles: [],
          produced_by: "Nodex",
          error: null,
          automatic_dispatch: false,
          suggestions: [
            {
              proposal_id: createUuidV7(),
              page_ids: [pageId],
              entry_kind: "question",
              summary: "Compare both positions.",
              rationale: null,
              explicit_request: false,
              action: {
                type: "new_chat",
                project_id: projectId,
                prompt: "Compare both positions.",
                skills,
              },
            },
          ],
        });
        const { item, storeEpoch } = yield* inbox.message(pageId);
        const proposal = item.proposal!;
        const fence = { proposalId: proposal.proposalId, expectedRevision: proposal.revision };
        const action = proposal.action;
        if (action.type !== "new_chat") return assert.fail("Expected a chat proposal");
        assert.deepEqual(
          yield* inbox.skillAvailability({
            ...fence,
            pageId,
            target: { type: "new_chat", projectId: action.projectId, instanceId: "other-agent" },
          }),
          [
            { name: "audit", available: false },
            { name: "review", available: true },
          ],
        );

        const draft = { ...fence, kind: "proposal" as const, storeEpoch, basis, action };
        const refusal = yield* Effect.flip(
          inbox.prepareConfirmation({ ...draft, droppedSkillNames: ["forged"] }),
        );
        assert.match(refusal.message, /not part of this suggestion/);
        const prepared = yield* inbox.prepareConfirmation({
          ...draft,
          droppedSkillNames: ["audit"],
        });
        if (prepared.kind !== "proposal") return assert.fail("Expected a prepared proposal");
        const { kind: _kind, ...confirmation } = prepared;
        yield* inbox.confirm(confirmation);
        yield* inbox.confirm(confirmation);
        const [work] = yield* inbox.outbox(1);
        assert.deepInclude(work!.action, { skills: [skills[1]] });
        assert.deepEqual(work!.skill_invocations, [
          { name: "review", path: "/repo/review/SKILL.md", cwd: "/repo", instanceId: "codex" },
        ]);
      }),
    ),
);
