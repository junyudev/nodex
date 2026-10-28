import { createHash, randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexAutomationInboxItem,
  CodexAutomationRun,
  CodexAutomationRunArchiveInput,
  CodexAutomationRunReadStateInput,
  CodexAutomationRunsInboxResponse,
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationDeleteResponse,
  CodexScheduledAutomationUpdateInput,
  PageOccurrence,
  PageOccurrenceActionInput,
  PageOccurrenceCompleteInput,
  PageOccurrenceMutationResult,
  PageOccurrenceUpdateInput,
} from "../../shared/types";
import type { InboxChatAgent } from "../../shared/inbox";
import { inboxChatAgentFromCore } from "../core-client/inbox-adapter";
import { getLogger } from "../logging/logger";
import type {
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationIntent,
  AutomationReadSnapshot,
  CoreRequestOptions,
} from "../core-client/types";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { createDueWorkOperationId, createOperationId } from "../core-runtime/operation-identity";
import {
  finiteDateMilliseconds,
  projectAutomationDefinition,
  projectAutomationInboxItem,
  projectAutomationRun,
  projectPageOccurrence,
  requireAutomationDefinition,
  requireAutomationRun,
  slugifyAutomationName,
  toCoreAutomationDefinitionInput,
  toCoreOccurrenceSchedulePatch,
  type CoreAutomationDefinition,
  type CoreAutomationInboxItem,
  type CoreAutomationRun,
} from "./AutomationProjection";

const BACKGROUND_CORE_REQUEST = {
  class: "background",
} as const satisfies CoreRequestOptions;

export type AutomationReadClass = "interactive" | "background";

export interface AutomationDefinitionDeleteResult extends CodexScheduledAutomationDeleteResponse {
  readonly deletedRunCount: number;
}

export interface AutomationDefinitionClaim {
  readonly leaseId: string;
  readonly dispatchId: string;
  readonly purpose: "hold" | "run";
  readonly admission: AutomationFiringAdmission | null;
  readonly definitionRevision: number;
  readonly scheduledFor: number;
  readonly attempt: number;
  readonly expiresAt: number;
  readonly definition: CodexScheduledAutomation;
}

export interface AutomationFiringAdmission {
  readonly pageId: string;
  readonly prompt: string;
  readonly agent: InboxChatAgent | null;
  readonly admittedAt: number;
}

export interface AutomationDueWork {
  readonly dueNow: boolean;
  readonly nextWakeAt: number | null;
  readonly workToken: string | null;
}

export interface AutomationRunMutationInput {
  readonly runId: string;
  readonly automationId: string;
  readonly dispatchId?: string;
  readonly sessionTitle?: string | null;
  readonly sessionId?: string | null;
  readonly sourceCwd?: string | null;
}

export interface AutomationReminderClaim {
  readonly leaseId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly occurrenceStart: number;
  readonly reminderOffsetMinutes: number;
  readonly dueAt: number;
  readonly title: string;
  readonly attempt: number;
  readonly expiresAt: number;
}

export interface AutomationPageOccurrenceWindow {
  readonly items: readonly PageOccurrence[];
  readonly nextCursor: string | null;
}

export class AutomationApplicationError extends Schema.TaggedError<AutomationApplicationError>()(
  "AutomationApplicationError",
  {
    operation: Schema.String,
    projectId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

type AutomationEffect<A> = Effect.Effect<A, AutomationApplicationError>;

export interface AutomationDefinitionCommand {
  readonly operationId: string;
}

/** Explicit commands retain the observed revision and replace the complete definition. */
export interface AutomationDefinitionRevisionCommand extends AutomationDefinitionCommand {
  readonly expectedRevision: number;
}

export interface AutomationDefinitionWindowInput {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AutomationDefinitionWindow {
  readonly items: readonly CodexScheduledAutomation[];
  readonly nextCursor: string | null;
}

export interface AutomationDefinitions {
  readonly listWindow: (
    input?: AutomationDefinitionWindowInput,
    requestClass?: AutomationReadClass,
  ) => AutomationEffect<AutomationDefinitionWindow>;
  readonly list: (
    requestClass?: AutomationReadClass,
  ) => AutomationEffect<readonly CodexScheduledAutomation[]>;
  readonly get: (automationId: string) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly getForExecution: (
    automationId: string,
  ) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly create: (
    input: CodexScheduledAutomationCreateInput,
    command?: AutomationDefinitionCommand,
  ) => AutomationEffect<CodexScheduledAutomation>;
  readonly update: (
    input: CodexScheduledAutomationUpdateInput,
    command?: AutomationDefinitionRevisionCommand,
  ) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly delete: (
    automationId: string,
    command?: AutomationDefinitionRevisionCommand,
  ) => AutomationEffect<AutomationDefinitionDeleteResult>;
  readonly dispatchNow: (automationId: string) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly reschedule: (
    automationId: string,
    expectedRevision: number,
    policy: { readonly notBefore?: number; readonly retryWithinMs?: number },
  ) => AutomationEffect<CodexScheduledAutomation>;
  readonly planDue: AutomationEffect<AutomationDueWork>;
  readonly claimDue: (
    workToken: string,
    limit: number,
    leaseDurationMs: number,
  ) => AutomationEffect<readonly AutomationDefinitionClaim[]>;
  readonly completeLease: (leaseId: string) => AutomationEffect<void>;
  readonly failLease: (
    leaseId: string,
    retryDelayMs: number | null,
    reasonCode: string,
  ) => AutomationEffect<void>;
}

export interface AutomationRuns {
  readonly settleInterrupted: AutomationEffect<{
    readonly archivedPendingCount: number;
    readonly pendingReviewCount: number;
  }>;
  readonly get: (runId: string) => AutomationEffect<CodexAutomationRun | null>;
  readonly begin: (input: AutomationRunMutationInput) => AutomationEffect<boolean>;
  readonly bindSession: (input: {
    readonly runId: string;
    readonly sessionId: string;
  }) => AutomationEffect<boolean>;
  readonly setSessionTitle: (
    runId: string,
    sessionTitle: string | null,
  ) => AutomationEffect<boolean>;
  readonly completeForReview: (input: {
    readonly runId: string;
    readonly inboxTitle?: string | null;
    readonly inboxSummary?: string | null;
  }) => AutomationEffect<boolean>;
  readonly setInboxItem: (input: {
    readonly runId: string;
    readonly inboxTitle?: string | null;
    readonly inboxSummary?: string | null;
  }) => AutomationEffect<boolean>;
  readonly accept: (runId: string) => AutomationEffect<boolean>;
  readonly archive: (input: CodexAutomationRunArchiveInput) => AutomationEffect<boolean>;
  readonly delete: (runId: string) => AutomationEffect<boolean>;
  readonly unarchive: (runId: string) => AutomationEffect<boolean>;
}

export interface AutomationInbox {
  readonly read: (
    limit?: number,
    requestClass?: AutomationReadClass,
  ) => AutomationEffect<CodexAutomationRunsInboxResponse>;
  readonly setReadState: (
    input: CodexAutomationRunReadStateInput,
  ) => AutomationEffect<CodexAutomationInboxItem | null>;
  readonly markAllRead: AutomationEffect<number>;
}

export interface AutomationOccurrences {
  readonly list: (input: {
    readonly projectId: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly searchQuery?: string;
    readonly after?: string | null;
  }) => AutomationEffect<AutomationPageOccurrenceWindow>;
  readonly complete: (
    projectId: string,
    input: PageOccurrenceCompleteInput,
  ) => AutomationEffect<PageOccurrenceMutationResult>;
  readonly skip: (
    projectId: string,
    input: PageOccurrenceActionInput,
  ) => AutomationEffect<PageOccurrenceMutationResult>;
  readonly update: (
    projectId: string,
    input: PageOccurrenceUpdateInput,
  ) => AutomationEffect<PageOccurrenceMutationResult>;
}

export interface AutomationReminders {
  readonly snooze: (input: {
    readonly projectId: string;
    readonly pageId: string;
    readonly occurrenceStart: string;
    readonly snoozeMinutes: number;
  }) => AutomationEffect<void>;
  readonly planDue: AutomationEffect<AutomationDueWork>;
  readonly claimDue: (
    workToken: string,
    limit: number,
    leaseDurationMs: number,
  ) => AutomationEffect<readonly AutomationReminderClaim[]>;
  readonly completeLease: (leaseId: string) => AutomationEffect<void>;
  readonly failLease: (
    leaseId: string,
    retryDelayMs: number | null,
    reasonCode: string,
  ) => AutomationEffect<void>;
}

export class AutomationApplication extends Context.Service<
  AutomationApplication,
  {
    readonly definitions: AutomationDefinitions;
    readonly runs: AutomationRuns;
    readonly inbox: AutomationInbox;
    readonly occurrences: AutomationOccurrences;
    readonly reminders: AutomationReminders;
  }
>()("nodex/main/automation-application/AutomationApplication") {}

const requestOptions = (requestClass: AutomationReadClass): CoreRequestOptions | undefined =>
  requestClass === "background" ? BACKGROUND_CORE_REQUEST : undefined;

const operationId = (kind: string): string => createOperationId(`automation.${kind}`);

export const make: Effect.Effect<
  AutomationApplication["Service"],
  never,
  AutomationRoutingIndex | CoreModules
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const routing = yield* AutomationRoutingIndex;

  const error = (operation: string, cause: unknown, projectId?: string) =>
    new AutomationApplicationError({
      operation,
      ...(projectId ? { projectId } : {}),
      cause,
    });

  const evaluate = <A>(operation: string, evaluateValue: () => A, projectId?: string) =>
    Effect.try({
      try: evaluateValue,
      catch: (cause) => error(operation, cause, projectId),
    });

  const projectDefinition = (operation: string, definition: CoreAutomationDefinition) =>
    evaluate(operation, () => projectAutomationDefinition(definition));

  const requireDefinitionCommand = Effect.fn("AutomationApplication.requireDefinitionCommand")(
    function* (operation: string, command: AutomationDefinitionCommand | undefined) {
      if ((yield* CoreApplicationAgent) && !command) {
        return yield* error(
          operation,
          new Error("Agent Automation mutations require a stable command identity"),
        );
      }
    },
  );

  const prepareCoreDefinitionInput = Effect.fn("AutomationApplication.prepareDefinition")(
    function* (
      operation: string,
      input: CodexScheduledAutomationCreateInput,
      stableTarget = false,
    ) {
      if (stableTarget && input.kind === "heartbeat" && !input.targetSessionId) {
        return yield* error(
          operation,
          new Error("A stable Heartbeat command requires its target Session"),
        );
      }
      if (input.kind !== "heartbeat" || input.targetSessionId) {
        return yield* evaluate(operation, () => toCoreAutomationDefinitionInput(input));
      }
      return yield* error(operation, new Error("Choose a chat for this heartbeat."));
    },
  );

  const read = (
    operation: string,
    input: Parameters<typeof core.automation.read>[0],
    options?: CoreRequestOptions,
    projectId?: string,
  ): AutomationEffect<AutomationReadSnapshot> =>
    core.automation
      .read(input, options, projectId)
      .pipe(Effect.mapError((cause) => error(operation, cause, projectId)));

  const commitRouting = (
    committed: AutomationApplyResult,
    removals: {
      readonly definitionIds?: readonly string[];
      readonly runIds?: readonly string[];
    } = {},
  ): void => {
    const definitionIds = removals.definitionIds ?? [];
    const runIds = [...(removals.runIds ?? []), ...committed.outcome.deleted_run_ids];
    if (
      definitionIds.length === 0 &&
      runIds.length === 0 &&
      committed.outcome.definitions.length === 0 &&
      committed.outcome.runs.length === 0
    ) {
      return;
    }
    routing.commit({
      definitions: {
        removeIds: definitionIds,
        upsert: committed.outcome.definitions,
      },
      runs: {
        removeRunIds: runIds,
        upsert: committed.outcome.runs,
      },
    });
  };

  const apply = Effect.fn("AutomationApplication.apply")(function* (
    operation: string,
    input: AutomationApplyInput,
    options?: CoreRequestOptions,
    projectId?: string,
    removals?: {
      readonly definitionIds?: readonly string[];
      readonly runIds?: readonly string[];
    },
  ) {
    const committed = yield* core.automation
      .apply(input, options, projectId)
      .pipe(Effect.mapError((cause) => error(operation, cause, projectId)));
    // A replay returns historical evidence; current routing follows newer commits.
    if (!committed.receipt.duplicate) commitRouting(committed, removals);
    return committed;
  });

  const readDefinition = Effect.fn("AutomationApplication.readDefinition")(function* (
    automationId: string,
  ) {
    const snapshot = yield* read("definitions.get", {
      kind: "definition",
      automation_id: automationId,
    });
    if (snapshot.value.kind !== "definition") {
      return yield* error(
        "definitions.get",
        new Error("Core returned a non-Definition Automation read"),
      );
    }
    return snapshot.value.item ?? null;
  });

  const readDueWork = Effect.fn("AutomationApplication.readDueWork")(function* (
    lane: "definitions" | "reminders",
  ) {
    const snapshot = yield* read(
      `${lane}.planDue`,
      { kind: "due_work", lane },
      BACKGROUND_CORE_REQUEST,
    );
    if (snapshot.value.kind !== "due_work") {
      return yield* error(
        `${lane}.planDue`,
        new Error("Core returned a non-DueWork Automation read"),
      );
    }
    return {
      dueNow: snapshot.value.plan.due_now,
      nextWakeAt: snapshot.value.plan.next_wake_at_ms ?? null,
      workToken: snapshot.value.plan.work_token ?? null,
    };
  });

  const readRun = Effect.fn("AutomationApplication.readRun")(function* (
    runId: string,
    options?: CoreRequestOptions,
  ) {
    const snapshot = yield* read("runs.get", { kind: "run", run_id: runId }, options);
    if (snapshot.value.kind !== "run") {
      return yield* error("runs.get", new Error("Core returned a non-Run Automation read"));
    }
    return snapshot.value.item ?? null;
  });

  const requireDefinition = (
    operation: string,
    committed: AutomationApplyResult,
    automationId: string,
  ): AutomationEffect<CoreAutomationDefinition> =>
    evaluate(operation, () => requireAutomationDefinition(committed, automationId));

  const requireRun = (
    operation: string,
    committed: AutomationApplyResult,
    runId: string,
  ): AutomationEffect<CoreAutomationRun> =>
    evaluate(operation, () => requireAutomationRun(committed, runId));

  const allocateDefinitionId = Effect.fn("AutomationApplication.allocateDefinitionId")(function* (
    name: string,
  ) {
    const base = slugifyAutomationName(name) || "automation";
    for (let suffix = 1; suffix <= 20; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      if ((yield* readDefinition(candidate)) === null) return candidate;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `${base}-${randomUUID().slice(0, 8)}`;
      if ((yield* readDefinition(candidate)) === null) return candidate;
    }
    return yield* error(
      "definitions.create",
      new Error("Unable to allocate a unique Scheduled Automation id"),
    );
  });

  const listDefinitionWindow = Effect.fn("AutomationApplication.definitions.listWindow")(function* (
    input: AutomationDefinitionWindowInput = {},
    readClass: AutomationReadClass = "interactive",
  ) {
    const snapshot = yield* read(
      "definitions.list",
      {
        kind: "definitions",
        include_deleted: false,
        search_query: input.query ?? null,
        window: { after: input.cursor ?? null, first: input.limit ?? 20 },
      },
      requestOptions(readClass),
    );
    if (snapshot.value.kind !== "definitions") {
      return yield* error(
        "definitions.list",
        new Error("Core returned a non-Definitions Automation read"),
      );
    }
    const definitions = snapshot.value.window.items;
    return {
      items: yield* evaluate("definitions.list", () =>
        definitions.map(projectAutomationDefinition),
      ),
      nextCursor: snapshot.value.window.next_cursor ?? null,
    };
  });

  const listDefinitions = Effect.fn("AutomationApplication.definitions.list")(function* (
    readClass: AutomationReadClass = "interactive",
  ) {
    const window = yield* listDefinitionWindow({ limit: 200 }, readClass);
    if (window.nextCursor) {
      return yield* error(
        "definitions.list",
        new Error("Active Scheduled Automation collection exceeded its fixed Core bound"),
      );
    }
    return window.items;
  });

  const createDefinition = Effect.fn("AutomationApplication.definitions.create")(function* (
    input: CodexScheduledAutomationCreateInput,
    command?: AutomationDefinitionCommand,
  ) {
    yield* requireDefinitionCommand("definitions.create", command);
    const definition = yield* prepareCoreDefinitionInput(
      "definitions.create",
      input,
      command !== undefined,
    );
    const automationId = command
      ? `automation-${createHash("sha256").update(command.operationId).digest("hex")}`
      : yield* allocateDefinitionId(input.name);
    const committed = yield* apply("definitions.create", {
      operationId: command?.operationId ?? operationId(`create:${automationId}`),
      intent: {
        kind: "create_definition",
        automation_id: automationId,
        definition,
      },
    });
    return yield* projectDefinition(
      "definitions.create",
      yield* requireDefinition("definitions.create", committed, automationId),
    );
  });

  const updateDefinition = Effect.fn("AutomationApplication.definitions.update")(function* (
    input: CodexScheduledAutomationUpdateInput,
    command?: AutomationDefinitionRevisionCommand,
  ) {
    yield* requireDefinitionCommand("definitions.update", command);
    const current = command ? null : yield* readDefinition(input.id);
    const expectedRevision = command?.expectedRevision ?? current?.definition_revision;
    if (expectedRevision === undefined) return null;
    const projectedCurrent = current
      ? yield* projectDefinition("definitions.update", current)
      : null;
    const definition = yield* prepareCoreDefinitionInput(
      "definitions.update",
      {
        ...input,
        backendBinding: input.backendBinding ?? projectedCurrent?.backendBinding,
        projectId: input.projectId === undefined ? projectedCurrent?.projectId : input.projectId,
      },
      command !== undefined,
    );
    const committed = yield* apply(
      "definitions.update",
      {
        operationId: command?.operationId ?? operationId(`update:${input.id}`),
        intent:
          input.status === "DELETED"
            ? {
                kind: "delete_definition",
                automation_id: input.id,
                expected_revision: expectedRevision,
              }
            : {
                kind: "update_definition",
                automation_id: input.id,
                expected_revision: expectedRevision,
                status: input.status,
                definition,
              },
      },
      undefined,
      undefined,
      input.status === "DELETED" ? { definitionIds: [input.id] } : undefined,
    );
    const updated = yield* projectDefinition(
      "definitions.update",
      yield* requireDefinition("definitions.update", committed, input.id),
    );
    if (updated.launch === "ask" && updated.heldFiring) {
      // The admitted definition edit authorizes this Host-owned refresh, including Agent edits.
      yield* core.workspace
        .apply(
          {
            operationId: operationId(`refresh-firing:${updated.heldFiring.dispatchId}`),
            intent: {
              kind: "refresh_scheduled_firing",
              dispatch_id: updated.heldFiring.dispatchId,
            },
          },
          undefined,
          null,
        )
        .pipe(
          Effect.provideService(CoreApplicationAgent, null),
          Effect.catch((cause) =>
            Effect.sync(() => {
              getLogger({ component: "automation-application" }).warn(
                "Failed to refresh the scheduled task's waiting message",
                { automationId: updated.id, cause },
              );
            }),
          ),
        );
    }
    return updated;
  });

  const deleteDefinition = Effect.fn("AutomationApplication.definitions.delete")(function* (
    automationId: string,
    command?: AutomationDefinitionRevisionCommand,
  ) {
    yield* requireDefinitionCommand("definitions.delete", command);
    const current = command ? null : yield* readDefinition(automationId);
    const expectedRevision = command?.expectedRevision ?? current?.definition_revision;
    if (expectedRevision === undefined) {
      return {
        item: null,
        success: true,
        status: "not_found" as const,
        deletedRunCount: 0,
      };
    }
    const committed = yield* apply(
      "definitions.delete",
      {
        operationId: command?.operationId ?? operationId(`delete:${automationId}`),
        intent: {
          kind: "delete_definition",
          automation_id: automationId,
          expected_revision: expectedRevision,
        },
      },
      undefined,
      undefined,
      { definitionIds: [automationId] },
    );
    return {
      item: yield* projectDefinition(
        "definitions.delete",
        yield* requireDefinition("definitions.delete", committed, automationId),
      ),
      success: true,
      status: "deleted" as const,
      deletedRunCount: committed.outcome.deleted_run_ids.length,
    };
  });

  const dispatchDefinitionNow = Effect.fn("AutomationApplication.definitions.dispatchNow")(
    function* (automationId: string) {
      const current = yield* readDefinition(automationId);
      if (current === null) return null;
      yield* projectDefinition("definitions.dispatchNow", current);
      const committed = yield* apply("definitions.dispatchNow", {
        operationId: operationId(`dispatch-now:${automationId}`),
        intent: { kind: "dispatch_now", automation_id: automationId },
      });
      return yield* projectDefinition(
        "definitions.dispatchNow",
        yield* requireDefinition("definitions.dispatchNow", committed, automationId),
      );
    },
  );

  const rescheduleDefinition = Effect.fn("AutomationApplication.definitions.reschedule")(function* (
    automationId: string,
    expectedRevision: number,
    policy: { readonly notBefore?: number; readonly retryWithinMs?: number },
  ) {
    const committed = yield* apply(
      "definitions.reschedule",
      {
        operationId: operationId(`reschedule:${automationId}`),
        intent: {
          kind: "reschedule_definition",
          automation_id: automationId,
          expected_revision: expectedRevision,
          not_before_ms: policy.notBefore ?? null,
          retry_within_ms: policy.retryWithinMs ?? null,
        },
      },
      BACKGROUND_CORE_REQUEST,
    );
    return yield* projectDefinition(
      "definitions.reschedule",
      yield* requireDefinition("definitions.reschedule", committed, automationId),
    );
  });

  const claimDueDefinitions = Effect.fn("AutomationApplication.definitions.claimDue")(function* (
    workToken: string,
    limit: number,
    leaseDurationMs: number,
  ) {
    const committed = yield* apply(
      "definitions.claimDue",
      {
        operationId: createDueWorkOperationId("automation.claim-due", workToken, {
          limit,
          leaseDurationMs,
        }),
        intent: {
          kind: "claim_due",
          work_token: workToken,
          limit,
          lease_duration_ms: leaseDurationMs,
        },
      },
      BACKGROUND_CORE_REQUEST,
    );
    const definitions = new Map(
      committed.outcome.definitions.map((item) => [item.automation_id, item]),
    );
    return yield* Effect.forEach(committed.outcome.claimed_leases, (lease) => {
      const definition = definitions.get(lease.automation_id);
      if (!definition) {
        return Effect.fail(
          error("definitions.claimDue", new Error("Core Automation claim omitted its Definition")),
        );
      }
      return projectDefinition("definitions.claimDue", definition).pipe(
        Effect.map((projectedDefinition) => ({
          leaseId: lease.lease_id,
          dispatchId: lease.dispatch_id,
          purpose: lease.purpose ?? "run",
          admission: lease.admission
            ? {
                pageId: lease.admission.page_id,
                prompt: lease.admission.prompt,
                agent: lease.admission.agent ? inboxChatAgentFromCore(lease.admission.agent) : null,
                admittedAt: lease.admission.admitted_at_ms,
              }
            : null,
          definitionRevision: lease.definition_revision,
          scheduledFor: lease.scheduled_for_ms,
          attempt: lease.attempt,
          expiresAt: lease.expires_at_ms,
          definition: projectedDefinition,
        })),
      );
    });
  });

  const applyRun = Effect.fn("AutomationApplication.applyRun")(function* (
    operation: string,
    runId: string,
    intent: (run: CoreAutomationRun) => AutomationIntent,
    options?: CoreRequestOptions,
  ) {
    const current = yield* readRun(runId, options);
    if (!current) return null;
    const requestedIntent = intent(current);
    const committed = yield* apply(
      operation,
      {
        operationId: operationId(`run:${runId}`),
        intent: requestedIntent,
      },
      options,
    );
    return yield* requireRun(operation, committed, runId);
  });

  const readInboxItems = Effect.fn("AutomationApplication.inbox.readItems")(function* (
    limit: number | undefined,
    readClass: AutomationReadClass,
  ) {
    const requested = limit ?? 200;
    if (!Number.isInteger(requested) || requested < 1 || requested > 1_000) {
      return yield* error(
        "inbox.read",
        new Error("Automation inbox limit must be between 1 and 1000"),
      );
    }
    const items: CoreAutomationInboxItem[] = [];
    let after: string | null = null;
    let unreadTotal = 0;
    do {
      const snapshot: AutomationReadSnapshot = yield* read(
        "inbox.read",
        {
          kind: "inbox",
          window: { after, first: Math.min(200, requested - items.length) },
        },
        requestOptions(readClass),
      );
      if (snapshot.value.kind !== "inbox") {
        return yield* error("inbox.read", new Error("Core returned a non-Inbox Automation read"));
      }
      items.push(...snapshot.value.window.items);
      unreadTotal = snapshot.value.unread_counts.total;
      after = items.length < requested ? (snapshot.value.window.next_cursor ?? null) : null;
    } while (after !== null);
    return { items, unreadTotal };
  });

  const applyPageOccurrence = Effect.fn("AutomationApplication.occurrences.apply")(function* (
    operation: string,
    projectId: string,
    operationIdentity: string,
    intent: Extract<
      AutomationIntent,
      {
        readonly kind:
          | "complete_page_occurrence"
          | "skip_page_occurrence"
          | "update_page_occurrence";
      }
    >,
  ) {
    const committed = yield* apply(
      operation,
      { operationId: operationIdentity, intent },
      undefined,
      projectId,
    );
    const result = committed.outcome.page_occurrence_mutation;
    if (!result) {
      return yield* error(
        operation,
        new Error("Core Automation commit omitted its occurrence result"),
        projectId,
      );
    }
    if (!result.success) {
      return { success: false as const, error: result.error ?? "Occurrence update failed" };
    }
    const commitCursor =
      committed.status === "committed"
        ? {
            storeEpoch: committed.commit.store_epoch,
            commitSeq: committed.commit.commit_seq,
          }
        : {
            storeEpoch: committed.observed.store_epoch,
            commitSeq: committed.observed.commit_head,
          };
    return { success: true as const, commitCursor };
  });

  const bindRunSession = Effect.fn("AutomationApplication.runs.bindSession")(function* (input: {
    readonly runId: string;
    readonly sessionId: string;
  }) {
    const current = yield* readRun(input.runId, BACKGROUND_CORE_REQUEST);
    if (!current) return false;
    const committed = yield* apply(
      "runs.bindSession",
      {
        operationId: operationId(`bind-run:${input.runId}:${input.sessionId}`),
        intent: {
          kind: "bind_run_session",
          run_id: input.runId,
          session_id: input.sessionId,
          expected_revision: current.run_revision,
        },
      },
      BACKGROUND_CORE_REQUEST,
    );
    return committed.outcome.runs.some(
      (run) => run.run_id === input.runId && run.session_id === input.sessionId,
    );
  });

  const deleteRun = Effect.fn("AutomationApplication.runs.delete")(function* (runId: string) {
    const current = yield* readRun(runId);
    if (!current) return false;
    const committed = yield* apply(
      "runs.delete",
      {
        operationId: operationId(`delete-run:${runId}`),
        intent: {
          kind: "delete_run",
          run_id: runId,
          expected_revision: current.run_revision,
        },
      },
      undefined,
      undefined,
      { runIds: [runId] },
    );
    return committed.outcome.deleted_run_ids.includes(runId);
  });

  const setInboxReadState = Effect.fn("AutomationApplication.inbox.setReadState")(function* (
    input: CodexAutomationRunReadStateInput,
  ) {
    const run = yield* applyRun("inbox.setReadState", input.runId, (current) => ({
      kind: "set_run_read_state",
      run_id: input.runId,
      expected_revision: current.run_revision,
      read: input.readAt !== null,
    }));
    if (!run) return null;
    const snapshot = yield* read("inbox.setReadState.read", {
      kind: "inbox",
      window: { after: null, first: 200 },
    });
    if (snapshot.value.kind !== "inbox") {
      return yield* error(
        "inbox.setReadState.read",
        new Error("Core returned a non-Inbox Automation read"),
      );
    }
    const item = snapshot.value.window.items.find((candidate) => candidate.run_id === input.runId);
    return item ? projectAutomationInboxItem(item) : null;
  });

  const listOccurrences = Effect.fn("AutomationApplication.occurrences.list")(function* (input: {
    readonly projectId: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly searchQuery?: string;
    readonly after?: string | null;
  }) {
    const windowStartMs = yield* evaluate(
      "occurrences.list",
      () => finiteDateMilliseconds(input.windowStart, "window start"),
      input.projectId,
    );
    const windowEndMs = yield* evaluate(
      "occurrences.list",
      () => finiteDateMilliseconds(input.windowEnd, "window end"),
      input.projectId,
    );
    const snapshot = yield* read(
      "occurrences.list",
      {
        kind: "occurrences",
        window_start_ms: windowStartMs,
        window_end_ms: windowEndMs,
        search_query: input.searchQuery?.trim() || null,
        window: { after: input.after ?? null, first: 200 },
      },
      undefined,
      input.projectId,
    );
    if (snapshot.value.kind !== "occurrences") {
      return yield* error(
        "occurrences.list",
        new Error("Core returned a non-Occurrence Automation read"),
        input.projectId,
      );
    }
    const occurrenceWindow = snapshot.value.window;
    const items = yield* evaluate(
      "occurrences.list.project",
      () => occurrenceWindow.items.map(projectPageOccurrence),
      input.projectId,
    );
    return { items, nextCursor: occurrenceWindow.next_cursor ?? null };
  });

  const snoozeReminder = Effect.fn("AutomationApplication.reminders.snooze")(function* (input: {
    readonly projectId: string;
    readonly pageId: string;
    readonly occurrenceStart: string;
    readonly snoozeMinutes: number;
  }) {
    const occurrenceStartMs = new Date(input.occurrenceStart).getTime();
    if (!Number.isFinite(occurrenceStartMs)) {
      return yield* error(
        "reminders.snooze",
        new Error("Reminder occurrence start is invalid"),
        input.projectId,
      );
    }
    if (!Number.isSafeInteger(input.snoozeMinutes) || input.snoozeMinutes < 1) {
      return yield* error(
        "reminders.snooze",
        new Error("Reminder snooze duration is invalid"),
        input.projectId,
      );
    }
    yield* apply(
      "reminders.snooze",
      {
        operationId: operationId(`snooze-reminder:${input.pageId}`),
        intent: {
          kind: "snooze_reminder",
          page_id: input.pageId,
          occurrence_start_ms: occurrenceStartMs,
          snooze_minutes: input.snoozeMinutes,
        },
      },
      undefined,
      input.projectId,
    );
  });

  return AutomationApplication.of({
    definitions: {
      getForExecution: (automationId) =>
        Effect.gen(function* () {
          const snapshot = yield* read("definitions.getForExecution", {
            kind: "execution_definition",
            automation_id: automationId,
          });
          if (snapshot.value.kind !== "definition")
            return yield* error(
              "definitions.getForExecution",
              new Error("Expected an execution Definition"),
            );
          return snapshot.value.item
            ? yield* projectDefinition("definitions.getForExecution", snapshot.value.item)
            : null;
        }),
      list: listDefinitions,
      listWindow: listDefinitionWindow,
      get: (automationId) =>
        readDefinition(automationId).pipe(
          Effect.flatMap((item) =>
            item ? projectDefinition("definitions.get", item) : Effect.succeed(null),
          ),
        ),
      create: createDefinition,
      update: updateDefinition,
      delete: deleteDefinition,
      dispatchNow: dispatchDefinitionNow,
      reschedule: rescheduleDefinition,
      planDue: readDueWork("definitions"),
      claimDue: claimDueDefinitions,
      completeLease: (leaseId) =>
        apply(
          "definitions.completeLease",
          {
            operationId: operationId(`complete-lease:${leaseId}`),
            intent: { kind: "complete_lease", lease_id: leaseId },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.asVoid),
      failLease: (leaseId, retryDelayMs, reasonCode) =>
        apply(
          "definitions.failLease",
          {
            operationId: operationId(`fail-lease:${leaseId}`),
            intent: {
              kind: "fail_lease",
              lease_id: leaseId,
              retry_delay_ms: retryDelayMs,
              reason_code: reasonCode,
            },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.asVoid),
    },
    runs: {
      settleInterrupted: Effect.suspend(() =>
        apply(
          "runs.settleInterrupted",
          {
            operationId: operationId("settle-interrupted-runs"),
            intent: { kind: "settle_interrupted_runs" },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(
          Effect.map((committed) => ({
            archivedPendingCount: committed.outcome.run_bulk?.archived_pending_count ?? 0,
            pendingReviewCount: committed.outcome.run_bulk?.pending_review_count ?? 0,
          })),
        ),
      ),
      get: (runId) =>
        readRun(runId).pipe(Effect.map((item) => (item ? projectAutomationRun(item) : null))),
      begin: (input) =>
        apply(
          "runs.begin",
          {
            operationId: operationId(`begin-run:${input.runId}`),
            intent: {
              kind: "begin_run",
              run_id: input.runId,
              automation_id: input.automationId,
              dispatch_id: input.dispatchId ?? null,
              session_id: input.sessionId ?? null,
              session_title: input.sessionTitle ?? null,
              source_cwd: input.sourceCwd ?? null,
            },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(
          Effect.map((committed) =>
            committed.outcome.runs.some((run) => run.run_id === input.runId),
          ),
        ),
      bindSession: bindRunSession,
      setSessionTitle: (runId, sessionTitle) =>
        applyRun("runs.setSessionTitle", runId, (current) => ({
          kind: "set_run_session_title",
          run_id: runId,
          expected_revision: current.run_revision,
          session_title: sessionTitle,
        })).pipe(Effect.map((run) => run !== null)),
      completeForReview: (input) =>
        applyRun(
          "runs.completeForReview",
          input.runId,
          (current) => ({
            kind: "complete_run_for_review",
            run_id: input.runId,
            expected_revision: current.run_revision,
            inbox_title: input.inboxTitle ?? null,
            inbox_summary: input.inboxSummary ?? null,
          }),
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.map((run) => run !== null)),
      setInboxItem: (input) =>
        applyRun("runs.setInboxItem", input.runId, (current) => ({
          kind: "set_run_inbox_item",
          run_id: input.runId,
          expected_revision: current.run_revision,
          inbox_title: input.inboxTitle ?? null,
          inbox_summary: input.inboxSummary ?? null,
        })).pipe(Effect.map((run) => run !== null)),
      accept: (runId) =>
        applyRun("runs.accept", runId, (current) => ({
          kind: "accept_run",
          run_id: runId,
          expected_revision: current.run_revision,
        })).pipe(Effect.map((run) => run !== null)),
      archive: (input) =>
        applyRun("runs.archive", input.runId, (current) => ({
          kind: "archive_run",
          run_id: input.runId,
          expected_revision: current.run_revision,
          archived_user_message: input.archivedUserMessage ?? null,
          archived_assistant_message: input.archivedAssistantMessage ?? null,
          archived_reason: input.archivedReason ?? null,
        })).pipe(Effect.map((run) => run !== null)),
      delete: deleteRun,
      unarchive: (runId) =>
        applyRun("runs.unarchive", runId, (current) => ({
          kind: "unarchive_run",
          run_id: runId,
          expected_revision: current.run_revision,
        })).pipe(Effect.map((run) => run !== null)),
    },
    inbox: {
      read: (limit, readClass = "interactive") =>
        readInboxItems(limit, readClass).pipe(
          Effect.map(({ items, unreadTotal }) => {
            const mappedItems = items.map(projectAutomationInboxItem);
            const unreadItems = mappedItems.filter(
              (item) =>
                item.readAt === null &&
                (item.status === "PENDING_REVIEW" || item.status === "ACCEPTED"),
            );
            return {
              items: mappedItems,
              unreadRunCounts: {
                total: unreadTotal,
                automationIds: [...new Set(unreadItems.map((item) => item.automationId))],
                unreadRuns: unreadItems.map((item) => ({
                  automationId: item.automationId,
                  runId: item.runId,
                })),
              },
            };
          }),
        ),
      setReadState: setInboxReadState,
      markAllRead: Effect.suspend(() =>
        apply("inbox.markAllRead", {
          operationId: operationId("mark-all-read"),
          intent: { kind: "mark_all_runs_read" },
        }).pipe(Effect.map((committed) => committed.outcome.run_bulk?.changed_count ?? 0)),
      ),
    },
    occurrences: {
      list: listOccurrences,
      complete: (projectId, input) =>
        evaluate(
          "occurrences.complete.input",
          () => finiteDateMilliseconds(input.occurrenceStart, "occurrence start"),
          projectId,
        ).pipe(
          Effect.flatMap((occurrenceStart) =>
            applyPageOccurrence("occurrences.complete", projectId, input.operationId, {
              kind: "complete_page_occurrence",
              page_id: input.pageId,
              occurrence_start_ms: occurrenceStart,
              created_page_id: input.createdPageId,
            }),
          ),
        ),
      skip: (projectId, input) =>
        evaluate(
          "occurrences.skip.input",
          () => finiteDateMilliseconds(input.occurrenceStart, "occurrence start"),
          projectId,
        ).pipe(
          Effect.flatMap((occurrenceStart) =>
            applyPageOccurrence("occurrences.skip", projectId, input.operationId, {
              kind: "skip_page_occurrence",
              page_id: input.pageId,
              occurrence_start_ms: occurrenceStart,
            }),
          ),
        ),
      update: (projectId, input) =>
        Effect.all({
          occurrenceStart: evaluate(
            "occurrences.update.input",
            () => finiteDateMilliseconds(input.occurrenceStart, "occurrence start"),
            projectId,
          ),
          updates: evaluate(
            "occurrences.update.input",
            () => toCoreOccurrenceSchedulePatch(input.updates),
            projectId,
          ),
        }).pipe(
          Effect.flatMap(({ occurrenceStart, updates }) =>
            applyPageOccurrence("occurrences.update", projectId, input.operationId, {
              kind: "update_page_occurrence",
              page_id: input.pageId,
              occurrence_start_ms: occurrenceStart,
              scope: input.scope === "this-and-future" ? "this_and_future" : input.scope,
              created_page_id: input.scope === "all" ? null : input.createdPageId,
              updates,
            }),
          ),
        ),
    },
    reminders: {
      snooze: snoozeReminder,
      planDue: readDueWork("reminders"),
      claimDue: (workToken, limit, leaseDurationMs) =>
        apply(
          "reminders.claimDue",
          {
            operationId: createDueWorkOperationId("automation.claim-due-reminders", workToken, {
              limit,
              leaseDurationMs,
            }),
            intent: {
              kind: "claim_due_reminders",
              work_token: workToken,
              limit,
              lease_duration_ms: leaseDurationMs,
            },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(
          Effect.map((committed) =>
            committed.outcome.reminder_leases.map((lease) => ({
              leaseId: lease.lease_id,
              projectId: lease.project_id,
              pageId: lease.page_id,
              occurrenceStart: lease.occurrence_start_ms,
              reminderOffsetMinutes: lease.reminder_offset_minutes,
              dueAt: lease.due_at_ms,
              title: lease.title,
              attempt: lease.attempt,
              expiresAt: lease.expires_at_ms,
            })),
          ),
        ),
      completeLease: (leaseId) =>
        apply(
          "reminders.completeLease",
          {
            operationId: operationId(`complete-reminder:${leaseId}`),
            intent: { kind: "complete_reminder_lease", lease_id: leaseId },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.asVoid),
      failLease: (leaseId, retryDelayMs, reasonCode) =>
        apply(
          "reminders.failLease",
          {
            operationId: operationId(`fail-reminder:${leaseId}`),
            intent: {
              kind: "fail_reminder_lease",
              lease_id: leaseId,
              retry_delay_ms: retryDelayMs,
              reason_code: reasonCode,
            },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.asVoid),
    },
  });
});

export const live = Layer.effect(AutomationApplication, make);
