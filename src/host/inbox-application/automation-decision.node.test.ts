import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AutomationClaim } from "../automation-application/AutomationApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { StoreAdministration } from "../../main/core-runtime/StoreAdministration";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";
import { InboxDispatchActionSchema } from "../../shared/schemas/inbox";
import {
  inboxDispatchActionFromCore,
  inboxDispatchActionToCore,
  inboxItemFromCore,
  type CoreInboxItem,
} from "../../main/core-client/inbox-adapter";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  AutomationIntent,
} from "../../main/core-client/types";
import { make } from "./InboxApplication";
import { automationDecisionCapture, automationDecisionTitle } from "./automation-decision";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  toCoreAutomationInput,
  projectAutomation,
} from "../automation-application/AutomationProjection";
import { inboxOverRealCore } from "./InboxApplication.test-support";

describe("automation-decision", () => {
  const basis = { page_id: "held-page", content_hash: "a".repeat(64) };
  const action = {
    type: "execute_decision",
    decision_id: "dispatch",
    agent: null,
  } as const;
  const item: CoreInboxItem = {
    row_kind: "intake",
    waiting: true,
    snooze: null,
    page_id: "held-page",
    page_key: "IN-3",
    title: "Review dependencies",
    body: "Reviewed instructions",
    body_truncated: false,
    body_editable: true,
    submitted_at: "2026-10-27T00:00:00Z",
    source: {
      kind: "automation",
      automation_id: "task",
      dispatch_id: "dispatch",
      project_id: null,
      label: "Dependencies",
    },
    kind: "todo",
    important: false,
    suggestion_state: "settled",
    suggestion_error: null,
    scope: { kind: "library" },
    location: { kind: "inbox" },
    revision: 4,
    basis,
    automation_decision: {
      automation_id: "task",
      dispatch_id: "dispatch",
      status: "held",
      first_scheduled_for_ms: 10,
      last_scheduled_for_ms: 20,
      missed_count: 1,
      failure_message: null,
    },
    proposal: {
      answered_question: false,
      explicit_request: false,
      proposal_id: "proposal",
      revision: 2,
      origin: "automation",
      state: "open",
      page_ids: ["held-page"],
      basis: [basis],
      outdated: false,
      action,
      kind: "todo",
      summary: "Run Dependencies",
      rationale: null,
      produced_by: null,
      target_project_name: null,
      chat: null,
      failure_message: null,
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-27T00:00:00Z",
    },
  };
  const heldDecision = {
    dispatchId: "dispatch",
    pageId: "held-page",
    inboxProjectId: null,
    firstScheduledFor: 10,
    lastScheduledFor: 20,
    missedCount: 1,
  };

  const fixture = (message: CoreInboxItem = item) => {
    const applies: ProjectWorkspaceApplyInput[] = [];
    const reads: ProjectWorkspaceRead[] = [];
    const core = {
      workspace: {
        read: (request: ProjectWorkspaceRead) => {
          reads.push(request);
          const value =
            request.kind === "inbox_window"
              ? {
                  kind: "inbox_window",
                  items: {
                    items: [message],
                    next_cursor: null,
                    authority: { projection_revision: 4 },
                  },
                }
              : {
                  kind: "inbox_dispatch_context",
                  context: {
                    scope: { kind: "library" },
                    projects: [],
                    sessions: [],
                    entries: [
                      { page_id: item.page_id, basis, source: item.source, body: item.body },
                    ],
                    open_proposals: [{ proposal_id: "proposal", page_ids: [item.page_id], action }],
                  },
                };
          return Effect.succeed({ store_epoch: "epoch", value });
        },
        apply: (input: ProjectWorkspaceApplyInput) =>
          Effect.sync(() => {
            applies.push(input);
            return { outcome: { inbox_undo_token: null } };
          }),
      },
    } as unknown as CoreModules["Service"];
    const application = make.pipe(
      Effect.provideService(CoreModules, core),
      Effect.provideService(StoreAdministration, {} as StoreAdministration["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        catalog: () => Effect.succeed([]),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(ApplicationSettings, {
        snapshot: () => Effect.succeed({ inbox: DEFAULT_INBOX_SETTINGS }),
      } as unknown as ApplicationSettings["Service"]),
    );
    return { application, applies, reads };
  };

  it("formats the scheduled day in the user's local time zone", () => {
    const when = Date.parse("2026-10-27T01:00:00Z");
    assert.equal(
      automationDecisionTitle("Dependencies", when, "Asia/Singapore"),
      "Dependencies · Oct 27",
    );
    assert.equal(
      automationDecisionTitle("Dependencies", when, "America/Los_Angeles"),
      "Dependencies · Oct 26",
    );
  });

  it("bounds scheduled titles by Unicode code points while preserving their date", () => {
    const when = Date.parse("2026-10-27T01:00:00Z");
    for (const character of ["a", "😀"]) {
      const suffix = " · Oct 27";
      const available = 200 - Array.from(suffix).length;
      const exact = character.repeat(available);
      assert.equal(automationDecisionTitle(exact, when, "UTC"), `${exact}${suffix}`);
      for (const length of [available + 1, 256]) {
        const title = automationDecisionTitle(character.repeat(length), when, "UTC");
        assert.equal(Array.from(title).length, 200);
        assert.equal(title, `${character.repeat(available - 1)}…${suffix}`);
      }
    }
  });

  it.effect("a reclaimed hold lease keeps its message and operation identities", () =>
    Effect.gen(function* () {
      const { application, applies } = fixture();
      const inbox = yield* application;
      const claim = {
        leaseId: "physical-one",
        dispatchId: "dispatch",
        scheduledFor: Date.parse("2026-10-27T12:00:00Z"),
        definition: { name: "Dependencies" },
      } as AutomationClaim;
      yield* inbox.holdAutomationDecision(claim);
      yield* inbox.holdAutomationDecision({ ...claim, leaseId: "physical-two" });
      const capture = automationDecisionCapture(claim.dispatchId);
      assert.equal(applies[0]?.operationId, applies[1]?.operationId);
      assert.deepEqual(applies[0]?.intent, {
        kind: "hold_automation_decision",
        lease_id: "physical-one",
        page_id: capture.pageId,
        document_id: capture.documentId,
        title: automationDecisionTitle("Dependencies", claim.scheduledFor),
      });
      assert.deepEqual(applies[1]?.intent, {
        kind: "hold_automation_decision",
        lease_id: "physical-two",
        page_id: capture.pageId,
        document_id: capture.documentId,
        title: automationDecisionTitle("Dependencies", claim.scheduledFor),
      });
      assert.notEqual(capture.pageId, capture.documentId);
    }),
  );

  it.effect("Run now confirms the open schedule proposal with the message's current basis", () =>
    Effect.gen(function* () {
      const { application, applies } = fixture();
      const inbox = yield* application;
      yield* inbox.confirmAutomationDecision(heldDecision);
      assert.equal(applies.length, 1);
      const intent = applies[0]!.intent;
      assert.equal(intent.kind, "confirm_inbox_dispatch");
      if (intent.kind !== "confirm_inbox_dispatch") return;
      assert.deepEqual(intent.basis, [basis]);
      assert.equal(intent.expected_revision, 2);
      assert.deepEqual(intent.action, action);
      assert.isNull(intent.execution_selection);
    }),
  );

  it.effect("Run now retries the same failed automationDecision waiting in the Inbox", () =>
    Effect.gen(function* () {
      const { application, applies } = fixture({
        ...item,
        automation_decision: {
          ...item.automation_decision!,
          status: "failed",
          failure_message: "Model unavailable",
        },
        proposal: { ...item.proposal!, state: "failed", failure_message: "Model unavailable" },
      });
      const inbox = yield* application;
      yield* inbox.confirmAutomationDecision(heldDecision);
      assert.deepEqual(applies[0]?.intent, {
        kind: "retry_inbox_dispatch",
        proposal_id: "proposal",
      });
    }),
  );

  it.effect(
    "execute_decision preparation validates overrides without selecting a chat execution",
    () =>
      Effect.gen(function* () {
        const { application, applies } = fixture();
        const inbox = yield* application;
        const view = inboxItemFromCore(item);
        const draft = {
          kind: "proposal" as const,
          storeEpoch: "epoch",
          proposalId: "proposal",
          expectedRevision: 2,
          basis: [view.basis],
        };
        const prepared = yield* inbox.prepareConfirmation(draft);
        assert.isNull(prepared.executionSelection);
        const rejected = yield* inbox
          .prepareConfirmation({
            ...draft,
            action: {
              ...inboxDispatchActionFromCore(action),
              agent: {
                instanceId: "removed",
                model: null,
                reasoningEffort: null,
                serviceTier: null,
              },
              type: "execute_decision",
              decisionId: "dispatch",
            },
          })
          .pipe(Effect.flip);
        assert.match(rejected.message, /Agent is unavailable/);
        assert.equal(applies.length, 0);
      }),
  );

  it("round-trips Automation sources, automationDecision state and execute_decision decisions across the Inbox boundary", () => {
    const view = inboxItemFromCore(item);
    assert.deepEqual(view.source, {
      kind: "automation",
      automationId: "task",
      dispatchId: "dispatch",
      projectId: null,
      label: "Dependencies",
    });
    assert.equal(view.proposal?.origin, "automation");
    assert.deepEqual(view.automationDecision, {
      automationId: "task",
      dispatchId: "dispatch",
      status: "held",
      firstScheduledFor: 10,
      lastScheduledFor: 20,
      missedCount: 1,
      failureMessage: null,
    });
    assert.deepEqual(
      inboxDispatchActionToCore(InboxDispatchActionSchema.parse(view.proposal?.action)),
      action,
    );
    const override = {
      ...action,
      agent: { instance_id: "codex", model: "gpt", reasoning_effort: "high", service_tier: "fast" },
    };
    assert.deepEqual(
      inboxDispatchActionToCore(
        InboxDispatchActionSchema.parse(inboxDispatchActionFromCore(override)),
      ),
      override,
    );
  });
});

describe("automation-decision-core", () => {
  it.effect(
    "an ask task holds one Inbox message and admits its reviewed instructions through the scheduler",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { inbox, client } = yield* inboxOverRealCore();
          const apply = (intent: AutomationIntent) =>
            Effect.tryPromise(() =>
              client.automationApply({ operationId: createUuidV7(), intent }),
            );
          const created = yield* apply({
            kind: "create_automation",
            automation_id: "reviewed-task",
            automation: toCoreAutomationInput({
              kind: "cron",
              name: "😀".repeat(256),
              prompt: "Update all dependencies",
              trigger: { kind: "clock", rrule: "FREQ=DAILY" },
              mode: "ask_first",
              projectId: null,
              executionEnvironment: "local",
              cwds: [],
              model: "test-model",
            }),
          });
          const definition = created.outcome.automations[0];
          assert.equal(definition?.mode, "ask_first");
          // A zero retry window makes the task due now without waiting for its schedule.
          yield* apply({
            kind: "reschedule_automation",
            automation_id: "reviewed-task",
            expected_revision: definition?.automation_revision ?? 0,
            not_before_ms: null,
            retry_within_ms: 0,
          });
          const claim = Effect.gen(function* () {
            const due = yield* Effect.tryPromise(() =>
              client.automationRead({ kind: "due_work", lane: "automations" }),
            );
            if (due.value.kind !== "due_work" || !due.value.plan.work_token)
              return assert.fail("No due automationDecision");
            const result = yield* apply({
              kind: "claim_due",
              work_token: due.value.plan.work_token,
              limit: 1,
              lease_duration_ms: 60_000,
            });
            const lease = result.outcome.claimed_leases[0];
            const definition = result.outcome.automations[0];
            if (!lease || !definition) return assert.fail("Missing claimed automationDecision");
            return { lease, definition };
          });
          const held = yield* claim;
          assert.equal(held.lease.purpose, "hold");
          yield* inbox.holdAutomationDecision({
            leaseId: held.lease.lease_id,
            dispatchId: held.lease.dispatch_id,
            purpose: "hold",
            admission: null,
            automationRevision: held.lease.automation_revision,
            scheduledFor: held.lease.scheduled_for_ms,
            attempt: held.lease.attempt,
            expiresAt: held.lease.expires_at_ms,
            definition: projectAutomation(held.definition),
          });
          const window = yield* inbox.window({ scope: { kind: "library" }, filter: "inbox" });
          const message = window.items.find(
            (item) => item.automationDecision?.dispatchId === held.lease.dispatch_id,
          );
          if (!message?.proposal) return assert.fail("Missing scheduled Inbox message");
          assert.equal(message.proposal.origin, "automation");
          assert.equal(Array.from(message.title).length, 200);
          yield* inbox.edit({
            pageId: message.pageId,
            basis: message.basis,
            originalBody: message.body,
            body: "Only update development dependencies",
          });
          const current = (yield* inbox.window({
            scope: { kind: "library" },
            filter: "inbox",
          })).items.find((item) => item.pageId === message.pageId);
          if (!current?.proposal) return assert.fail("Missing edited automationDecision");
          const prepared = yield* inbox.prepareConfirmation({
            kind: "proposal",
            storeEpoch: window.storeEpoch,
            proposalId: current.proposal.proposalId,
            expectedRevision: current.proposal.revision,
            basis: [current.basis],
          });
          if (prepared.kind !== "proposal") return assert.fail("Expected proposal confirmation");
          const { kind: _kind, ...confirmation } = prepared;
          yield* inbox.confirm(confirmation);
          assert.deepEqual(yield* inbox.outbox(20), []);
          const admitted = yield* claim;
          assert.equal(admitted.lease.purpose, "run");
          assert.equal(admitted.lease.dispatch_id, held.lease.dispatch_id);
          assert.include(
            admitted.lease.admission?.prompt ?? "",
            "Only update development dependencies",
          );
        }),
      ),
  );
});
