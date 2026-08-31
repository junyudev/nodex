import { randomUUID } from "node:crypto";
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
import type {
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationIntent,
  AutomationReadSnapshot,
  CoreRequestOptions,
} from "../core-client/types";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules } from "../core-runtime/CoreModules";
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
  readonly scheduledFor: number;
  readonly attempt: number;
  readonly expiresAt: number;
  readonly definition: CodexScheduledAutomation;
}

export interface AutomationDueWork {
  readonly dueNow: boolean;
  readonly nextWakeAt: number | null;
  readonly workToken: string | null;
}

export interface AutomationRunMutationInput {
  readonly threadId: string;
  readonly automationId: string;
  readonly threadTitle?: string | null;
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

export interface AutomationDefinitions {
  readonly list: (
    requestClass?: AutomationReadClass,
  ) => AutomationEffect<readonly CodexScheduledAutomation[]>;
  readonly get: (automationId: string) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly create: (
    input: CodexScheduledAutomationCreateInput,
  ) => AutomationEffect<CodexScheduledAutomation>;
  readonly update: (
    input: CodexScheduledAutomationUpdateInput,
  ) => AutomationEffect<CodexScheduledAutomation | null>;
  readonly delete: (automationId: string) => AutomationEffect<AutomationDefinitionDeleteResult>;
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
  readonly get: (threadId: string) => AutomationEffect<CodexAutomationRun | null>;
  readonly begin: (input: AutomationRunMutationInput) => AutomationEffect<boolean>;
  readonly replacePendingThread: (input: {
    readonly pendingThreadId: string;
    readonly threadId: string;
  }) => AutomationEffect<boolean>;
  readonly setThreadTitle: (
    threadId: string,
    threadTitle: string | null,
  ) => AutomationEffect<boolean>;
  readonly completeForReview: (input: {
    readonly threadId: string;
    readonly inboxTitle?: string | null;
    readonly inboxSummary?: string | null;
  }) => AutomationEffect<boolean>;
  readonly setInboxItem: (input: {
    readonly threadId: string;
    readonly inboxTitle?: string | null;
    readonly inboxSummary?: string | null;
  }) => AutomationEffect<boolean>;
  readonly accept: (threadId: string) => AutomationEffect<boolean>;
  readonly archive: (input: CodexAutomationRunArchiveInput) => AutomationEffect<boolean>;
  readonly delete: (threadId: string) => AutomationEffect<boolean>;
  readonly unarchive: (threadId: string) => AutomationEffect<boolean>;
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

  const prepareCoreDefinitionInput = (
    operation: string,
    input: CodexScheduledAutomationCreateInput,
  ) => evaluate(operation, () => toCoreAutomationDefinitionInput(input));

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
      readonly threadIds?: readonly string[];
    } = {},
  ): void => {
    const definitionIds = removals.definitionIds ?? [];
    const threadIds = [...(removals.threadIds ?? []), ...committed.outcome.deleted_run_ids];
    if (
      definitionIds.length === 0 &&
      threadIds.length === 0 &&
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
        removeThreadIds: threadIds,
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
      readonly threadIds?: readonly string[];
    },
  ) {
    const committed = yield* core.automation
      .apply(input, options, projectId)
      .pipe(Effect.mapError((cause) => error(operation, cause, projectId)));
    commitRouting(committed, removals);
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
    threadId: string,
    options?: CoreRequestOptions,
  ) {
    const snapshot = yield* read("runs.get", { kind: "run", thread_id: threadId }, options);
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
    threadId: string,
  ): AutomationEffect<CoreAutomationRun> =>
    evaluate(operation, () => requireAutomationRun(committed, threadId));

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

  const listDefinitions = Effect.fn("AutomationApplication.definitions.list")(function* (
    readClass: AutomationReadClass = "interactive",
  ) {
    const snapshot = yield* read(
      "definitions.list",
      {
        kind: "definitions",
        include_deleted: false,
        window: { after: null, first: 200 },
      },
      requestOptions(readClass),
    );
    if (snapshot.value.kind !== "definitions") {
      return yield* error(
        "definitions.list",
        new Error("Core returned a non-Definitions Automation read"),
      );
    }
    if (snapshot.value.window.next_cursor) {
      return yield* error(
        "definitions.list",
        new Error("Active Scheduled Automation collection exceeded its fixed Core bound"),
      );
    }
    const definitions = snapshot.value.window.items;
    return yield* evaluate("definitions.list", () => definitions.map(projectAutomationDefinition));
  });

  const createDefinition = Effect.fn("AutomationApplication.definitions.create")(function* (
    input: CodexScheduledAutomationCreateInput,
  ) {
    const definition = yield* prepareCoreDefinitionInput("definitions.create", input);
    const automationId = yield* allocateDefinitionId(input.name);
    const committed = yield* apply("definitions.create", {
      operationId: operationId(`create:${automationId}`),
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
  ) {
    const current = yield* readDefinition(input.id);
    if (!current) return null;
    const projectedCurrent = yield* projectDefinition("definitions.update", current);
    const definition = yield* prepareCoreDefinitionInput("definitions.update", {
      ...input,
      backendBinding: input.backendBinding ?? projectedCurrent.backendBinding,
    });
    const committed = yield* apply(
      "definitions.update",
      {
        operationId: operationId(`update:${input.id}`),
        intent:
          input.status === "DELETED"
            ? {
                kind: "delete_definition",
                automation_id: input.id,
                expected_revision: current.definition_revision,
              }
            : {
                kind: "update_definition",
                automation_id: input.id,
                expected_revision: current.definition_revision,
                status: input.status,
                definition,
              },
      },
      undefined,
      undefined,
      input.status === "DELETED" ? { definitionIds: [input.id] } : undefined,
    );
    return yield* projectDefinition(
      "definitions.update",
      yield* requireDefinition("definitions.update", committed, input.id),
    );
  });

  const deleteDefinition = Effect.fn("AutomationApplication.definitions.delete")(function* (
    automationId: string,
  ) {
    const current = yield* readDefinition(automationId);
    if (!current) {
      return {
        item: null,
        success: true,
        status: "not_found" as const,
        deletedRunCount: 0,
      };
    }
    const projectedCurrent = yield* projectDefinition("definitions.delete", current);
    const committed = yield* apply(
      "definitions.delete",
      {
        operationId: operationId(`delete:${automationId}`),
        intent: {
          kind: "delete_definition",
          automation_id: automationId,
          expected_revision: current.definition_revision,
        },
      },
      undefined,
      undefined,
      { definitionIds: [automationId] },
    );
    return {
      item: projectedCurrent,
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
    threadId: string,
    intent: (run: CoreAutomationRun) => AutomationIntent,
    options?: CoreRequestOptions,
  ) {
    const current = yield* readRun(threadId, options);
    if (!current) return null;
    const requestedIntent = intent(current);
    const committed = yield* apply(
      operation,
      {
        operationId: operationId(`run:${threadId}`),
        intent: requestedIntent,
      },
      options,
    );
    return yield* requireRun(operation, committed, threadId);
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

  const replacePendingRunThread = Effect.fn("AutomationApplication.runs.replacePendingThread")(
    function* (input: { readonly pendingThreadId: string; readonly threadId: string }) {
      const pending = yield* readRun(input.pendingThreadId, BACKGROUND_CORE_REQUEST);
      if (!pending) return false;
      const committed = yield* apply(
        "runs.replacePendingThread",
        {
          operationId: operationId(`replace-run:${input.pendingThreadId}:${input.threadId}`),
          intent: {
            kind: "replace_pending_run_thread",
            pending_thread_id: input.pendingThreadId,
            thread_id: input.threadId,
            expected_revision: pending.run_revision,
          },
        },
        BACKGROUND_CORE_REQUEST,
        undefined,
        { threadIds: [input.pendingThreadId] },
      );
      return committed.outcome.runs.some((run) => run.thread_id === input.threadId);
    },
  );

  const deleteRun = Effect.fn("AutomationApplication.runs.delete")(function* (threadId: string) {
    const current = yield* readRun(threadId);
    if (!current) return false;
    const committed = yield* apply(
      "runs.delete",
      {
        operationId: operationId(`delete-run:${threadId}`),
        intent: {
          kind: "delete_run",
          thread_id: threadId,
          expected_revision: current.run_revision,
        },
      },
      undefined,
      undefined,
      { threadIds: [threadId] },
    );
    return committed.outcome.deleted_run_ids.includes(threadId);
  });

  const setInboxReadState = Effect.fn("AutomationApplication.inbox.setReadState")(function* (
    input: CodexAutomationRunReadStateInput,
  ) {
    const run = yield* applyRun("inbox.setReadState", input.threadId, (current) => ({
      kind: "set_run_read_state",
      thread_id: input.threadId,
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
    const item = snapshot.value.window.items.find(
      (candidate) => candidate.thread_id === input.threadId,
    );
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
      list: listDefinitions,
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
      get: (threadId) =>
        readRun(threadId).pipe(Effect.map((item) => (item ? projectAutomationRun(item) : null))),
      begin: (input) =>
        apply(
          "runs.begin",
          {
            operationId: operationId(`begin-run:${input.threadId}`),
            intent: {
              kind: "begin_run",
              thread_id: input.threadId,
              automation_id: input.automationId,
              thread_title: input.threadTitle ?? null,
              source_cwd: input.sourceCwd ?? null,
            },
          },
          BACKGROUND_CORE_REQUEST,
        ).pipe(
          Effect.map((committed) =>
            committed.outcome.runs.some((run) => run.thread_id === input.threadId),
          ),
        ),
      replacePendingThread: replacePendingRunThread,
      setThreadTitle: (threadId, threadTitle) =>
        applyRun("runs.setThreadTitle", threadId, (current) => ({
          kind: "set_run_thread_title",
          thread_id: threadId,
          expected_revision: current.run_revision,
          thread_title: threadTitle,
        })).pipe(Effect.map((run) => run !== null)),
      completeForReview: (input) =>
        applyRun(
          "runs.completeForReview",
          input.threadId,
          (current) => ({
            kind: "complete_run_for_review",
            thread_id: input.threadId,
            expected_revision: current.run_revision,
            inbox_title: input.inboxTitle ?? null,
            inbox_summary: input.inboxSummary ?? null,
          }),
          BACKGROUND_CORE_REQUEST,
        ).pipe(Effect.map((run) => run !== null)),
      setInboxItem: (input) =>
        applyRun("runs.setInboxItem", input.threadId, (current) => ({
          kind: "set_run_inbox_item",
          thread_id: input.threadId,
          expected_revision: current.run_revision,
          inbox_title: input.inboxTitle ?? null,
          inbox_summary: input.inboxSummary ?? null,
        })).pipe(Effect.map((run) => run !== null)),
      accept: (threadId) =>
        applyRun("runs.accept", threadId, (current) => ({
          kind: "accept_run",
          thread_id: threadId,
          expected_revision: current.run_revision,
        })).pipe(Effect.map((run) => run !== null)),
      archive: (input) =>
        applyRun("runs.archive", input.threadId, (current) => ({
          kind: "archive_run",
          thread_id: input.threadId,
          expected_revision: current.run_revision,
          archived_user_message: input.archivedUserMessage ?? null,
          archived_assistant_message: input.archivedAssistantMessage ?? null,
          archived_reason: input.archivedReason ?? null,
        })).pipe(Effect.map((run) => run !== null)),
      delete: deleteRun,
      unarchive: (threadId) =>
        applyRun("runs.unarchive", threadId, (current) => ({
          kind: "unarchive_run",
          thread_id: threadId,
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
                  threadId: item.threadId,
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
