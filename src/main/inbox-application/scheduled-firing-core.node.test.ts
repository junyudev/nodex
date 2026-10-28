import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AutomationIntent } from "../core-client/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  toCoreAutomationDefinitionInput,
  projectAutomationDefinition,
} from "../automation-application/AutomationProjection";
import { inboxOverRealCore } from "./InboxApplication.test-support";

it.effect(
  "an ask task holds one Inbox message and admits its reviewed instructions through the scheduler",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox, client } = yield* inboxOverRealCore();
        const apply = (intent: AutomationIntent) =>
          Effect.tryPromise(() => client.automationApply({ operationId: createUuidV7(), intent }));
        const created = yield* apply({
          kind: "create_definition",
          automation_id: "reviewed-task",
          definition: toCoreAutomationDefinitionInput({
            kind: "cron",
            name: "😀".repeat(256),
            prompt: "Update all dependencies",
            rrule: "FREQ=DAILY",
            launch: "ask",
            projectId: null,
            executionEnvironment: "local",
            cwds: [],
            model: "test-model",
          }),
        });
        const definition = created.outcome.definitions[0];
        assert.equal(definition?.launch, "ask");
        // A zero retry window makes the task due now without waiting for its schedule.
        yield* apply({
          kind: "reschedule_definition",
          automation_id: "reviewed-task",
          expected_revision: definition?.definition_revision ?? 0,
          not_before_ms: null,
          retry_within_ms: 0,
        });
        const claim = Effect.gen(function* () {
          const due = yield* Effect.tryPromise(() =>
            client.automationRead({ kind: "due_work", lane: "definitions" }),
          );
          if (due.value.kind !== "due_work" || !due.value.plan.work_token)
            return assert.fail("No due firing");
          const result = yield* apply({
            kind: "claim_due",
            work_token: due.value.plan.work_token,
            limit: 1,
            lease_duration_ms: 60_000,
          });
          const lease = result.outcome.claimed_leases[0];
          const definition = result.outcome.definitions[0];
          if (!lease || !definition) return assert.fail("Missing claimed firing");
          return { lease, definition };
        });
        const held = yield* claim;
        assert.equal(held.lease.purpose, "hold");
        yield* inbox.holdScheduledFiring({
          leaseId: held.lease.lease_id,
          dispatchId: held.lease.dispatch_id,
          purpose: "hold",
          admission: null,
          definitionRevision: held.lease.definition_revision,
          scheduledFor: held.lease.scheduled_for_ms,
          attempt: held.lease.attempt,
          expiresAt: held.lease.expires_at_ms,
          definition: projectAutomationDefinition(held.definition),
        });
        const window = yield* inbox.window({ scope: { kind: "library" }, filter: "inbox" });
        const message = window.items.find(
          (item) => item.firing?.dispatchId === held.lease.dispatch_id,
        );
        if (!message?.proposal) return assert.fail("Missing scheduled Inbox message");
        assert.equal(message.proposal.origin, "schedule");
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
        if (!current?.proposal) return assert.fail("Missing edited firing");
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
