import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WorkApplication, make as makeWork } from "../work-application/WorkApplication";
import { make as makeScheduler } from "../work-application/WorkScheduler";
import { captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";

const catalog: AgentRuntimeApplication["Service"]["catalog"] = () =>
  Effect.succeed([
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-03T00:00:00.000Z",
      models: [
        {
          slug: "default-model",
          name: "Default",
          isCustom: false,
          isDefault: true,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Effort",
                type: "select",
                currentValue: "medium",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ]);

it.effect(
  "starts a confirmed plan root, then releases its dependent after acceptance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox, core, client, identity, projectId } = yield* inboxOverRealCore(
          Effect.void,
          catalog,
          () => ({ ...DEFAULT_INBOX_SETTINGS, dispatchMode: "act_on_requests" }),
        );
        const scope = { kind: "project" as const, projectId };
        yield* captureInbox(inbox, "Prepare a brief, then implement it", scope);
        const window = yield* inbox.window({ scope, filter: "inbox" });
        const item = window.items[0]!;
        const action: import("../../shared/inbox").InboxDispatchAction = {
          type: "plan",
          summary: "Prepare and implement",
          steps: [
            {
              key: "a",
              projectId,
              title: "Prepare",
              body: "Write **a brief**.",
              agent: { instanceId: "codex", model: "default-model", effort: "high" },
              blockedBy: [],
            },
            {
              key: "b",
              projectId,
              title: "Implement",
              body: "Implement the brief.",
              agent: null,
              blockedBy: ["a"],
            },
          ],
        };
        const proposalId = "test-plan-proposal";
        yield* inbox.propose({
          proposalId,
          pageIds: [item.pageId],
          basis: [inboxPageBasisToCore(item.basis)],
          action,
          kind: "todo",
          summary: "Prepare and implement",
          rationale: null,
          producedBy: "Nodex",
        });
        yield* inbox.autoConfirm;
        const pending = yield* inbox.window({ scope, filter: "inbox" });
        assert.equal(pending.items[0]?.proposal?.state, "open");
        const prepared = yield* inbox.prepareConfirmation({
          kind: "proposal",
          storeEpoch: window.storeEpoch,
          proposalId,
          expectedRevision: 1,
          basis: [item.basis],
        });
        assert.equal(prepared.executionSelection?.modelSelection.model, "default-model");
        assert.equal(prepared.kind, "proposal");
        if (prepared.kind !== "proposal") return assert.fail("Expected plan proposal");
        const { kind: _kind, ...input } = prepared;
        const result = yield* inbox.confirm(input);
        const [a, b] = result.value.createdPageIds!;
        assert.isString(a);
        assert.isString(b);
        const repeated = yield* inbox.confirm(input);
        assert.deepEqual(repeated.value.createdPageIds, [a, b]);
        const work = yield* makeWork.pipe(
          Effect.provideService(CoreModules, core),
          Effect.provideService(AgentRuntimeApplication, { catalog } as never),
          Effect.provideService(ApplicationSettings, {
            snapshot: () => Effect.succeed({ inbox: DEFAULT_INBOX_SETTINGS }),
          } as never),
        );
        const scheduler = yield* makeScheduler.pipe(
          Effect.provideService(CoreModules, core),
          Effect.provideService(WorkApplication, work),
        );
        const outbox = () =>
          core.workspace
            .read({ kind: "page_work_outbox", limit: 100 }, undefined, null)
            .pipe(
              Effect.map((snapshot) =>
                snapshot.value.kind === "page_work_outbox" ? snapshot.value.launches : [],
              ),
            );
        yield* scheduler.sweep;
        let launches = yield* outbox();
        assert.deepEqual(
          launches.map((launch) => launch.page_id),
          [a],
        );
        const root = launches[0]!;
        assert.equal(root.selection.effort, "high");
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createBoundedOperationId("test.plan.bind"),
            intent: {
              kind: "create_agent_runtime_session",
              session_id: root.session_id,
              project_id: projectId,
              title: "Prepare",
              initial_page_ids: [],
              runtime_id: "test-runtime",
              runtime_thread_id: "test-root",
              launch_request_id: root.launch_id,
            },
          }),
        );
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createBoundedOperationId("test.plan.report"),
            intent: {
              kind: "agent_command",
              provenance: {
                profile_id: identity.profileId,
                authority: {
                  thread_id: "test-root",
                  root_thread_id: "test-root",
                  turn_id: "test-run",
                  actor_project_id: projectId,
                  library_id: identity.libraryId,
                  store_epoch: identity.storeEpoch,
                  runtime: {
                    session_id: root.session_id,
                    runtime_id: "test-runtime",
                    turn_kind: "run",
                  },
                },
              },
              intent: {
                kind: "report_page_work",
                page_id: a!,
                outcome: "ready",
                summary: "The brief is ready.",
              },
            },
          }),
        );
        yield* scheduler.sweep;
        assert.deepEqual(
          (yield* outbox()).map((launch) => launch.page_id),
          [a],
        );
        yield* work.acceptWork({
          operationId: createBoundedOperationId("test.plan.accept"),
          pageId: a!,
        });
        yield* scheduler.sweep;
        launches = yield* outbox();
        assert.deepEqual(new Set(launches.map((launch) => launch.page_id)), new Set([a, b]));
        const dependent = launches.find((launch) => launch.page_id === b)!;
        assert.include(dependent.brief, "The brief is ready.");
        assert.equal(dependent.selection.model, "default-model");
        yield* scheduler.sweep;
        assert.equal((yield* outbox()).length, 2);
        const history = (yield* inbox.window({ scope, filter: "processed" })).items.find(
          (entry) => entry.pageId === item.pageId,
        )!;
        assert.equal(history.proposal?.summary, "Planned 2 cards");
        assert.deepEqual(history.proposal?.createdPageIds, [a, b]);
      }),
    ),
  120_000,
);
