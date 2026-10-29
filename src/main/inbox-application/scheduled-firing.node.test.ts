import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AutomationDefinitionClaim } from "../automation-application/AutomationApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { StoreAdministration } from "../core-runtime/StoreAdministration";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";
import { InboxDispatchActionSchema } from "../../shared/schemas/inbox";
import {
  inboxDispatchActionFromCore,
  inboxDispatchActionToCore,
  inboxItemFromCore,
  type CoreInboxItem,
} from "../core-client/inbox-adapter";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import { make } from "./InboxApplication";
import { scheduledFiringCapture, scheduledFiringTitle } from "./scheduled-firing";

const basis = { page_id: "held-page", content_hash: "a".repeat(64) };
const action = {
  type: "run_task",
  automation_id: "task",
  dispatch_id: "dispatch",
  agent: null,
} as const;
const item: CoreInboxItem = {
  page_id: "held-page",
  page_key: "IN-3",
  title: "Review dependencies",
  body: "Reviewed instructions",
  body_truncated: false,
  body_editable: true,
  submitted_at: "2026-10-27T00:00:00Z",
  source: {
    kind: "scheduled_task",
    automation_id: "task",
    dispatch_id: "dispatch",
    project_id: null,
    label: "Dependencies",
  },
  kind: "todo",
  important: false,
  state: "open",
  suggestion_state: "settled",
  suggestion_error: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  revision: 4,
  basis,
  firing: {
    automation_id: "task",
    dispatch_id: "dispatch",
    status: "held",
    first_scheduled_for_ms: 10,
    last_scheduled_for_ms: 20,
    missed_count: 1,
    failure_message: null,
  },
  proposal: {
    proposal_id: "proposal",
    revision: 2,
    origin: "schedule",
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
const heldFiring = {
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
                  entries: [{ page_id: item.page_id, basis, source: item.source, body: item.body }],
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
    scheduledFiringTitle("Dependencies", when, "Asia/Singapore"),
    "Dependencies · Oct 27",
  );
  assert.equal(
    scheduledFiringTitle("Dependencies", when, "America/Los_Angeles"),
    "Dependencies · Oct 26",
  );
});

it("bounds scheduled titles by Unicode code points while preserving their date", () => {
  const when = Date.parse("2026-10-27T01:00:00Z");
  for (const character of ["a", "😀"]) {
    const suffix = " · Oct 27";
    const available = 200 - Array.from(suffix).length;
    const exact = character.repeat(available);
    assert.equal(scheduledFiringTitle(exact, when, "UTC"), `${exact}${suffix}`);
    for (const length of [available + 1, 256]) {
      const title = scheduledFiringTitle(character.repeat(length), when, "UTC");
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
    } as AutomationDefinitionClaim;
    yield* inbox.holdScheduledFiring(claim);
    yield* inbox.holdScheduledFiring({ ...claim, leaseId: "physical-two" });
    const capture = scheduledFiringCapture(claim.dispatchId);
    assert.equal(applies[0]?.operationId, applies[1]?.operationId);
    assert.deepEqual(applies[0]?.intent, {
      kind: "hold_scheduled_firing",
      lease_id: "physical-one",
      page_id: capture.pageId,
      document_id: capture.documentId,
      title: scheduledFiringTitle("Dependencies", claim.scheduledFor),
    });
    assert.deepEqual(applies[1]?.intent, {
      kind: "hold_scheduled_firing",
      lease_id: "physical-two",
      page_id: capture.pageId,
      document_id: capture.documentId,
      title: scheduledFiringTitle("Dependencies", claim.scheduledFor),
    });
    assert.notEqual(capture.pageId, capture.documentId);
  }),
);

it.effect("Run now confirms the open schedule proposal with the message's current basis", () =>
  Effect.gen(function* () {
    const { application, applies } = fixture();
    const inbox = yield* application;
    yield* inbox.confirmScheduledFiring(heldFiring);
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

it.effect("Run now retries the same failed firing waiting in the Inbox", () =>
  Effect.gen(function* () {
    const { application, applies } = fixture({
      ...item,
      firing: { ...item.firing!, status: "failed", failure_message: "Model unavailable" },
      proposal: { ...item.proposal!, state: "failed", failure_message: "Model unavailable" },
    });
    const inbox = yield* application;
    yield* inbox.confirmScheduledFiring(heldFiring);
    assert.deepEqual(applies[0]?.intent, {
      kind: "retry_inbox_dispatch",
      proposal_id: "proposal",
    });
  }),
);

it.effect("run_task preparation validates overrides without selecting a chat execution", () =>
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
          agent: { instanceId: "removed", model: null, reasoningEffort: null, serviceTier: null },
          type: "run_task",
          automationId: "task",
          dispatchId: "dispatch",
        },
      })
      .pipe(Effect.flip);
    assert.match(rejected.message, /Agent is unavailable/);
    assert.equal(applies.length, 0);
  }),
);

it("round-trips scheduled sources, firing state and run_task decisions across the Inbox boundary", () => {
  const view = inboxItemFromCore(item);
  assert.deepEqual(view.source, {
    kind: "scheduled_task",
    automationId: "task",
    dispatchId: "dispatch",
    projectId: null,
    label: "Dependencies",
  });
  assert.equal(view.proposal?.origin, "schedule");
  assert.deepEqual(view.firing, {
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
