import { InboxSkillAvailabilityInputSchema } from "../../shared/schemas/inbox";
import { inboxSkillTokens, makeInboxSkills, type InboxSkillOffer } from "./inbox-skills";
import {
  inboxActionSkills,
  type InboxSkillAvailabilityInput,
  type InboxSkillAvailability,
} from "../../shared/inbox";
import type { ActivityWindowInput, ActivityWindow, RetryProblemInput } from "../../shared/inbox";
import { ActivityWindowInputSchema, RetryProblemInputSchema } from "../../shared/schemas/inbox";
import { effectiveHolds, scopeHeld, spaceHeld } from "../work-application/execution-holds";
import { inboxRoutingDeadline, inboxRoutingIdentity } from "./inbox-suggestions";
import { decideInboxReply, inboxReplyDestination, type ReplyDispatch } from "./inbox-replies";
import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";
import { HostInvocation } from "../HostInvocation";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { deriveSessionDispatchIdentity } from "../../main/app-tools/session-dispatch-identity";
import { createStableOperationId } from "../../main/core-runtime/operation-identity";
import { inboxPageBasisFromCore } from "../../main/core-client/inbox-adapter";
import type {
  InboxChatTargets,
  InboxChatTargetsInput,
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxPreparedConfirmation,
  InboxDecisionResult,
  InboxSuggestionRequestInput,
  InboxSuggestionStopInput,
  InboxUndoInput,
  InboxCounts,
  InboxDispatchAction,
  InboxDispatchInput,
  InboxEditInput,
  InboxEntryKind,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSendResult,
  InboxSetImportantInput,
  InboxSetKindInput,
  InboxSetLaterInput,
  InboxSummary,
  InboxSummaryInput,
  InboxWindow,
  InboxWindowInput,
} from "../../shared/inbox";
import {
  InboxChatTargetsInputSchema,
  InboxConfirmInputSchema,
  InboxConfirmationDraftSchema,
  InboxUndoInputSchema,
  InboxDispatchInputSchema,
  InboxEditInputSchema,
  InboxPageIdsInputSchema,
  InboxProposalInputSchema,
  InboxSendInputSchema,
  InboxSetImportantInputSchema,
  InboxSetKindInputSchema,
  InboxSetLaterInputSchema,
  InboxSuggestionRequestInputSchema,
  InboxSuggestionStopInputSchema,
  InboxSummaryInputSchema,
  InboxWindowInputSchema,
} from "../../shared/schemas/inbox";
import { writeInlineMarkdown } from "../../shared/nodex-markdown";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  inboxChatFromCore,
  inboxCountsFromCore,
  inboxDispatchActionFromCore,
  inboxPageBasisToCore,
  inboxExecutionSelectionToCore,
  inboxDispatchActionToCore,
  activityWindowFromCore,
  inboxItemFromCore,
  inboxScopeToCore,
  inboxStopSuggestionToCore,
  inboxSummaryFromCore,
  type CoreInboxDispatchContext,
  type CoreInboxDispatchWork,
  type CoreInboxPageBasis,
  type CoreInboxSuggestionInput,
  type CoreInboxSuggestionRequest,
} from "../../main/core-client/inbox-adapter";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  ProjectWorkspaceReadSnapshot,
} from "../../main/core-client/types";
import { CoreModuleResponseError } from "../../main/core-client/core-client";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { CoreRuntimeError } from "../../main/core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../../main/core-runtime/StoreAdministration";
import type { ProjectWorkspaceCommandResult } from "../../main/project-application/ProjectWorkspace";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { readRoutingConsent } from "./InboxRoutingConsent";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import { createOperationId } from "../../main/core-runtime/operation-identity";
import { automationDecisionCapture, automationDecisionTitle } from "./automation-decision";
import type { AutomationClaim } from "../automation-application/AutomationApplication";
import type { AutomationHeldDecision } from "../../shared/types";

export class InboxApplicationError extends Schema.TaggedError<InboxApplicationError>()(
  "InboxApplicationError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
    mayHaveCommitted: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

export { InboxRuntimeError } from "./InboxRuntimeError";

export interface InboxSuggestionProposal {
  readonly proposalId: string;
  readonly pageIds: readonly string[];
  readonly basis: readonly CoreInboxPageBasis[];
  readonly action: InboxDispatchAction;
  readonly kind: InboxEntryKind | null;
  readonly summary: string;
  readonly rationale: string | null;
  readonly producedBy: string | null;
}

export interface InboxEntryName {
  readonly basis: CoreInboxPageBasis;
  readonly title: string;
}

type InboxEffect<A> = Effect.Effect<A, InboxApplicationError>;
type InboxMutation<A = void> = InboxEffect<ProjectWorkspaceCommandResult<A>>;
export type InboxSuggestionSettlement = Omit<
  Extract<ProjectWorkspaceApplyInput["intent"], { kind: "settle_inbox_suggestion" }>,
  "kind"
>;
export type InboxDispatchFence = Pick<
  CoreInboxDispatchWork,
  "proposal_id" | "revision" | "message_id"
>;

export interface InboxRoutingStatus {
  readonly deadline: number;
  readonly failureMessage: string | null;
  readonly needsFollowup: boolean;
}

/** The Inbox's Core-backed application Interface for renderers, Agents, and host workers. */
export class InboxApplication extends Context.Service<
  InboxApplication,
  {
    readonly executionHeld: (input?: {
      readonly pageIds?: readonly string[];
      readonly sessionId?: string;
    }) => InboxEffect<boolean>;
    readonly holdAutomationDecision: (claim: AutomationClaim) => InboxEffect<void>;
    readonly confirmAutomationDecision: (
      automationDecision: AutomationHeldDecision,
    ) => InboxEffect<void>;
    readonly chatTargets: (input: InboxChatTargetsInput) => InboxEffect<InboxChatTargets>;
    readonly entry: (pageId: string) => InboxEffect<import("../../shared/inbox").InboxItem | null>;
    readonly summary: (input: InboxSummaryInput) => InboxEffect<InboxSummary>;
    /** Messages waiting in the Library Inbox and in each Project's Inbox. */
    readonly counts: InboxEffect<InboxCounts>;
    readonly window: (input: InboxWindowInput) => InboxEffect<InboxWindow>;
    readonly message: (
      pageId: string,
    ) => InboxEffect<{ readonly item: InboxWindow["items"][number]; readonly storeEpoch: string }>;
    readonly activity: (input: ActivityWindowInput) => InboxEffect<ActivityWindow>;
    readonly retryProblem: (input: RetryProblemInput) => InboxMutation;
    readonly replyDestination: (
      pageId: string,
      body: string,
    ) => InboxEffect<import("../../shared/inbox").InboxReplyDestination>;
    readonly send: (input: InboxSendInput) => InboxMutation<InboxSendResult>;
    readonly skillAvailability: (
      input: InboxSkillAvailabilityInput,
    ) => InboxEffect<readonly InboxSkillAvailability[]>;
    readonly prepareConfirmation: (
      input: InboxConfirmationDraft,
      identity?: { readonly operationId: string; readonly sessionId: string },
    ) => InboxEffect<InboxPreparedConfirmation>;
    readonly undo: (input: InboxUndoInput) => InboxMutation;
    /**
     * Saves a stream rewrite and queues automatic advice, keeping the previous proposal visible.
     */
    readonly edit: (input: InboxEditInput) => InboxMutation;
    readonly confirm: (
      input: InboxConfirmInput,
      confirmedBy?: "user" | "nodex",
    ) => InboxMutation<InboxDecisionResult>;
    readonly dispatch: (input: InboxDispatchInput) => InboxMutation<InboxDecisionResult>;
    readonly keep: (
      input: InboxPageIdsInput,
      operationId?: string,
    ) => InboxMutation<InboxDecisionResult>;
    readonly clearLater: (input: InboxPageIdsInput, operationId?: string) => InboxMutation;
    readonly setLater: (input: InboxSetLaterInput, operationId?: string) => InboxMutation;
    readonly markDone: (
      input: InboxPageIdsInput,
      operationId?: string,
    ) => InboxMutation<InboxDecisionResult>;
    readonly returnMessages: (input: InboxPageIdsInput, operationId?: string) => InboxMutation;
    readonly setKind: (input: InboxSetKindInput) => InboxMutation;
    readonly setImportant: (input: InboxSetImportantInput, operationId?: string) => InboxMutation;
    readonly requestSuggestion: (input: InboxSuggestionRequestInput) => InboxMutation;
    readonly stopSuggestion: (input: InboxSuggestionStopInput) => InboxMutation;
    readonly pendingSuggestionRequestIds: (
      requestIds: readonly string[],
    ) => InboxEffect<readonly string[]>;
    readonly cancelledRoutingDeliveries: (
      requestIds: readonly string[],
    ) => InboxEffect<readonly components["schemas"]["InboxRoutingCancellation"][]>;
    readonly prepareSuggestions: (limit: number, automatic: boolean) => InboxEffect<void>;
    readonly suggestionRequests: (
      limit: number,
    ) => InboxEffect<readonly CoreInboxSuggestionRequest[]>;
    readonly suggestionRequest: (
      requestId: string,
    ) => InboxEffect<CoreInboxSuggestionRequest | null>;
    readonly beginRouting: (
      request: CoreInboxSuggestionRequest,
      coordinatorSessionId: string,
      skillOffers?: readonly InboxSkillOffer[],
    ) => InboxEffect<void>;
    readonly recordRoutingRefusal: (
      request: CoreInboxSuggestionRequest,
      reason: string,
    ) => InboxEffect<void>;
    /** Observes both carrying Runs without extending Core's first retained deadline. */
    readonly routingStatus: (
      request: CoreInboxSuggestionRequest,
    ) => InboxEffect<InboxRoutingStatus>;
    readonly autoConfirm: InboxEffect<void>;
    readonly settleSuggestion: (
      input: InboxSuggestionSettlement,
      operationId?: string,
    ) => InboxEffect<void>;
    readonly retryDispatch: (input: InboxProposalInput, operationId?: string) => InboxMutation;
    /** Erases messages: the Inbox forgets them now and Store maintenance collects their Pages. */
    readonly delete: (input: InboxPageIdsInput, operationId?: string) => InboxMutation;
    readonly pendingSuggestions: (
      limit: number,
    ) => InboxEffect<readonly CoreInboxSuggestionInput[]>;
    readonly dispatchContext: (pageIds: readonly string[]) => InboxEffect<CoreInboxDispatchContext>;
    readonly propose: (proposal: InboxSuggestionProposal) => InboxEffect<void>;
    /**
     * Names a still-provisional message whose content matches what the Agent read.
     * Returns its unchanged content basis, or null when the content or provisional title changed.
     */
    readonly nameEntry: (input: InboxEntryName) => InboxEffect<CoreInboxPageBasis | null>;
    readonly recordSuggestionFailure: (
      pageIds: readonly string[],
      message: string,
    ) => InboxEffect<void>;
    readonly outbox: (limit: number) => InboxEffect<readonly CoreInboxDispatchWork[]>;
    readonly beginDispatch: (work: InboxDispatchFence) => InboxEffect<void>;
    readonly completeDispatch: (
      work: InboxDispatchFence,
      threadId: string | null,
      unavailableSkillNames?: readonly string[],
    ) => InboxEffect<void>;
    readonly failDispatch: (
      work: InboxDispatchFence,
      message: string,
      kind: "rejected" | "unavailable" | "unknown",
    ) => InboxEffect<void>;
  }
>()("nodex/main/inbox-application/InboxApplication") {}

// Core refusals may contain diagnostics; each workflow chooses its public failure reason.
const coreRefusal = (cause: unknown) => {
  const refusal = Schema.is(CoreRuntimeError)(cause) ? cause.cause : cause;
  return refusal instanceof CoreModuleResponseError ? refusal.coreError : null;
};

const isNotFound = (cause: unknown): boolean => coreRefusal(cause)?.code === "not_found";

const errorMessage = (cause: unknown): string => {
  const refusal = coreRefusal(cause);
  if (refusal) return refusal.message;
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "The Inbox operation failed";
};

type ApplyIntent = ProjectWorkspaceApplyInput["intent"];

const expectVariant = <Kind extends ProjectWorkspaceReadSnapshot["value"]["kind"]>(
  snapshot: ProjectWorkspaceReadSnapshot,
  kind: Kind,
): Extract<ProjectWorkspaceReadSnapshot["value"], { kind: Kind }> => {
  if (snapshot.value.kind === kind) {
    return snapshot.value as Extract<ProjectWorkspaceReadSnapshot["value"], { kind: Kind }>;
  }
  throw new Error(`Core returned ${snapshot.value.kind} for Inbox ${kind}`);
};

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const administration = yield* StoreAdministration;
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;

  const fail = (operation: string) => (cause: unknown) =>
    new InboxApplicationError({ operation, message: errorMessage(cause), cause });

  const executionHeld = Effect.fn("InboxApplication.executionHeld")(
    function* (input?: { readonly pageIds?: readonly string[]; readonly sessionId?: string }) {
      if (yield* spaceHeld(core)) return true;
      if (
        input?.sessionId &&
        (yield* effectiveHolds(core, { kind: "session", session_id: input.sessionId })).length
      )
        return true;
      for (const page of input?.pageIds ?? [])
        if ((yield* effectiveHolds(core, { kind: "page", page_id: page })).length) return true;
      return false;
    },
    Effect.mapError(fail("execution-hold")),
  );
  const parse = <A>(operation: string, run: () => A): InboxEffect<A> =>
    Effect.try({ try: run, catch: fail(operation) });

  // Inbox is Space-wide. A relayed person action retains Core's verified Member audience.
  const read = (operation: string, request: ProjectWorkspaceRead) =>
    Effect.flatMap(HostInvocation, (invocation) =>
      core.workspace.read(request, { hostInvocation: invocation ?? undefined }, null),
    ).pipe(Effect.mapError(fail(operation)));

  const apply = (
    operation: string,
    intent: ApplyIntent,
    operationId = createOperationId(`inbox.${operation}`),
  ) =>
    Effect.flatMap(HostInvocation, (invocation) =>
      core.workspace.apply(
        { operationId, intent },
        { hostInvocation: invocation ?? undefined },
        null,
      ),
    ).pipe(Effect.mapError(fail(operation)));
  const mutate = (operation: string, intent: ApplyIntent, operationId?: string): InboxMutation =>
    apply(operation, intent, operationId).pipe(
      Effect.map((apply) => ({ value: undefined, apply })),
    );
  const decision = (
    operation: string,
    intent: ApplyIntent,
    operationId?: string,
  ): InboxMutation<InboxDecisionResult> =>
    apply(operation, intent, operationId).pipe(
      Effect.map((apply) => ({
        value: {
          undoToken: apply.outcome.inbox_undo_token ?? null,
          createdPageIds: apply.outcome.inbox_created_page_ids ?? [],
        },
        apply,
      })),
    );

  const summary = Effect.fn("InboxApplication.summary")(function* (input: InboxSummaryInput) {
    const parsed = yield* parse("summary", () => InboxSummaryInputSchema.parse(input));
    const snapshot = yield* read("summary", {
      kind: "inbox_summary",
      scope: inboxScopeToCore(parsed.scope),
    });
    return yield* parse("summary", () =>
      inboxSummaryFromCore(expectVariant(snapshot, "inbox_summary").summary, snapshot.store_epoch),
    );
  });

  const counts = read("counts", { kind: "inbox_counts" }).pipe(
    Effect.flatMap((snapshot) =>
      parse("counts", () => inboxCountsFromCore(expectVariant(snapshot, "inbox_counts").counts)),
    ),
  );

  const activity = Effect.fn("InboxApplication.activity")(function* (input: ActivityWindowInput) {
    const parsed = yield* parse("activity", () => ActivityWindowInputSchema.parse(input));
    const snapshot = yield* read("activity", {
      kind: "activity_window",
      scope: inboxScopeToCore(parsed.scope),
      filter: parsed.filter,
      window: { after: parsed.after ?? null, first: parsed.first ?? 50 },
    });
    return yield* parse("activity", () =>
      activityWindowFromCore(expectVariant(snapshot, "activity_window").rows, snapshot.store_epoch),
    );
  });
  const retryProblem = Effect.fn("InboxApplication.retryProblem")(function* (
    input: RetryProblemInput,
  ) {
    const parsed = yield* parse("retry-problem", () => RetryProblemInputSchema.parse(input));
    return yield* mutate(
      "retry-problem",
      { kind: "source", command: { kind: "retry_problem", problem_id: parsed.problemId } },
      parsed.operationId,
    );
  });
  const window = Effect.fn("InboxApplication.window")(function* (input: InboxWindowInput) {
    const parsed = yield* parse("window", () => InboxWindowInputSchema.parse(input));
    const snapshot = yield* read("window", {
      kind: "inbox_window",
      scope: inboxScopeToCore(parsed.scope),
      filter: parsed.filter,
      window: { after: parsed.after ?? null, first: parsed.first ?? 50 },
    });
    return yield* parse("window", () => {
      const items = expectVariant(snapshot, "inbox_window").items;
      return {
        items: items.items.map(inboxItemFromCore),
        nextCursor: items.next_cursor ?? null,
        projectionRevision: items.authority.projection_revision,
        storeEpoch: snapshot.store_epoch,
      } satisfies InboxWindow;
    });
  });

  const message = Effect.fn("InboxApplication.message")(function* (pageId: string) {
    const snapshot = yield* read("message", { kind: "inbox_message", page_id: pageId });
    return yield* parse("message", () => ({
      item: inboxItemFromCore(expectVariant(snapshot, "inbox_message").item),
      storeEpoch: snapshot.store_epoch,
    }));
  });

  const chatTargets = Effect.fn("InboxApplication.chatTargets")(function* (
    input: InboxChatTargetsInput,
  ) {
    const parsed = yield* parse("chat-targets", () => InboxChatTargetsInputSchema.parse(input));
    const snapshot = yield* read("chat-targets", {
      kind: "inbox_chat_targets",
      scope: inboxScopeToCore(parsed.scope),
      query: parsed.query,
      window: { after: parsed.after ?? null, first: parsed.first ?? 50 },
    });
    return yield* parse("chat-targets", () => {
      const window = expectVariant(snapshot, "inbox_chat_targets").window;
      return { items: window.items.map(inboxChatFromCore), nextCursor: window.next_cursor ?? null };
    });
  });

  const entry = (pageId: string) =>
    read("entry", { kind: "inbox_entry", page_id: pageId }).pipe(
      Effect.map((snapshot) => {
        const item = expectVariant(snapshot, "inbox_entry").item;
        return item ? inboxItemFromCore(item) : null;
      }),
    );

  const resolveReply = Effect.fn("InboxApplication.resolveReply")(function* (
    pageId: string,
    body: string,
  ) {
    const row = yield* entry(pageId);
    const sessionId = row?.rowKind === "turn" ? row.turn?.active_chat?.session_id : null;
    if (!sessionId) return { chat: null, dispatch: null };
    const session = yield* read("reply-session", { kind: "session", session_id: sessionId }).pipe(
      Effect.map((snapshot) => expectVariant(snapshot, "session").session),
      Effect.catchIf(isNotFound, () => Effect.succeed(null)),
    );
    if (!session || session.archived) return { chat: null, dispatch: null };
    const chat = { sessionId, title: session.display_title || "chat" };
    if (!session.execution_ref && session.thread_id) {
      const thread = yield* read("reply-thread", {
        kind: "thread",
        thread_id: session.thread_id,
      }).pipe(
        Effect.map((snapshot) => expectVariant(snapshot, "thread").thread),
        Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      );
      const waiting = thread?.status.active_flags.some(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      );
      return {
        chat,
        dispatch: thread && !thread.archived && !waiting ? { type: "send" as const } : null,
      };
    }
    const control = yield* runtime.control({ sessionId, requireActive: true }).pipe(Effect.result);
    if (control._tag === "Failure") return { chat, dispatch: null };
    const metadata = yield* runtime
      .observeSessionMetadata({ sessionId })
      .pipe(Effect.orElseSucceed(() => null));
    const dispatch: ReplyDispatch | null = metadata
      ? decideInboxReply(
          row?.turn?.turn.reason === "question" ? "attention" : "result",
          body,
          control.success,
          metadata.details,
        )
      : null;
    return { chat, dispatch };
  });
  const replyDestination = (pageId: string, body: string) =>
    Effect.gen(function* () {
      const row = yield* entry(pageId);
      const { chat, dispatch } = yield* resolveReply(pageId, body);
      if (row?.rowKind === "turn" && !dispatch) return { kind: "unavailable" as const, chat };
      return inboxReplyDestination(chat, dispatch);
    });

  const send = Effect.fn("InboxApplication.send")(function* (input: InboxSendInput) {
    const parsed = yield* parse("send", () => InboxSendInputSchema.parse(input));
    const reply = parsed.replyToPageId
      ? yield* resolveReply(parsed.replyToPageId, parsed.body)
      : null;
    if (parsed.turnEpisode) {
      if (!parsed.replyToPageId)
        return yield* new InboxApplicationError({
          operation: "send",
          cause: null,
          message: "This reply cannot be delivered. Open the active chat to continue.",
        });
      const applied = yield* apply(
        "turn-reply",
        {
          kind: "reply_to_page_turn",
          page_id: parsed.replyToPageId,
          episode: parsed.turnEpisode,
          body: parsed.body,
          dispatch: reply?.dispatch ?? null,
        },
        parsed.operationId,
      );
      return { value: { pageId: parsed.pageId, state: "saved" as const }, apply: applied };
    }
    if (parsed.replyToPageId) {
      const target = yield* entry(parsed.replyToPageId);
      if (target?.rowKind === "turn")
        return yield* new InboxApplicationError({
          operation: "send",
          cause: null,
          message: "The Turn changed; refresh the Inbox before replying.",
        });
    }
    const replyTarget = parsed.replyToPageId ? yield* entry(parsed.replyToPageId) : null;
    const applied = yield* apply(
      "send",
      {
        kind: "send_inbox_message",
        page_id: parsed.pageId,
        document_id: parsed.documentId,
        body: parsed.body,
        reply_to_page_id: parsed.replyToPageId ?? null,
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        project_id:
          replyTarget?.scope.kind === "project"
            ? replyTarget.scope.projectId
            : parsed.scope.kind === "project"
              ? parsed.scope.projectId
              : null,
        expected_store_epoch: parsed.storeEpoch,
      },
      parsed.operationId,
    );
    // The operation receipt survives deletion. Only a current Page read can confirm visibility.
    const visibilityFailure = (cause: unknown) =>
      new InboxApplicationError({
        operation: "send",
        message: "The capture may already be saved. Retry to check it.",
        cause,
        mayHaveCommitted: true,
      });
    const visible = yield* core.library
      .read({ kind: "page_detail", page_id: parsed.pageId }, undefined, null)
      .pipe(
        Effect.flatMap((snapshot) =>
          snapshot.value.kind === "page_detail"
            ? Effect.succeed(snapshot)
            : Effect.fail(new Error("Core did not confirm the captured Page")),
        ),
        Effect.catchIf(isNotFound, () => Effect.succeed(null)),
        Effect.mapError(visibilityFailure),
      );
    if (visible && visible.store_epoch !== parsed.storeEpoch)
      return yield* visibilityFailure(
        new Error("The Store changed; check this capture before trying again"),
      );
    return {
      value: { pageId: parsed.pageId, state: visible ? ("saved" as const) : ("deleted" as const) },
      apply: applied,
    };
  });

  const edit = Effect.fn("InboxApplication.edit")(function* (input: InboxEditInput) {
    const parsed = yield* parse("edit", () => InboxEditInputSchema.parse(input));
    return yield* mutate("edit", {
      kind: "edit_inbox_message",
      page_id: parsed.pageId,
      basis: inboxPageBasisToCore(parsed.basis),
      original_body: parsed.originalBody,
      body: parsed.body,
    });
  });

  const skillInventory = yield* makeInboxSkills;
  const skillAvailability = Effect.fn("InboxApplication.skillAvailability")(function* (
    supplied: InboxSkillAvailabilityInput,
  ) {
    const input = yield* parse("skill-availability", () =>
      InboxSkillAvailabilityInputSchema.parse(supplied),
    );
    const { item } = yield* message(input.pageId);
    const proposal = item.proposal;
    const skills =
      proposal?.proposalId === input.proposalId && proposal.revision === input.expectedRevision
        ? inboxActionSkills(proposal.action)
        : [];
    if (!skills.length) return [];
    let instanceId = input.target.type === "new_chat" ? input.target.instanceId : null;
    if (input.target.type === "new_chat" && instanceId === null) {
      const current = (yield* settings.snapshot().pipe(Effect.mapError(fail("skill-availability"))))
        .inbox;
      const selection = yield* resolveInboxModel(runtime, current.chatAgent).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      instanceId = selection?.instanceId ?? null;
    }
    const resolved = yield* skillInventory.resolve(
      input.target,
      instanceId ?? undefined,
      skills.map(({ name }) => name),
    );
    return skills.map(({ name }) => ({
      name,
      available: resolved.some((skill) => skill.name === name),
    }));
  });

  const prepareConfirmation = Effect.fn("InboxApplication.prepareConfirmation")(function* (
    input: InboxConfirmationDraft,
    identity?: { readonly operationId: string; readonly sessionId: string },
  ): Effect.fn.Return<InboxPreparedConfirmation, InboxApplicationError> {
    const draft = yield* parse("prepare-confirmation", () =>
      InboxConfirmationDraftSchema.parse(input),
    );
    const context = yield* dispatchContext(draft.basis.map((basis) => basis.pageId));
    const proposal =
      draft.kind === "proposal"
        ? context.open_proposals.find((proposal) => proposal.proposal_id === draft.proposalId)
        : undefined;
    const storedAction = proposal ? inboxDispatchActionFromCore(proposal.action) : null;
    let action = draft.action ?? storedAction;
    if (!action)
      return yield* fail("prepare-confirmation")(
        new Error("Review this suggestion before deciding"),
      );
    if (action.type === "execute_decision" && action.agent)
      yield* resolveInboxModel(runtime, action.agent).pipe(
        Effect.mapError(fail("prepare-confirmation")),
      );
    if (action.type === "plan") {
      for (const step of action.steps) {
        if (!step.agent) continue;
        yield* resolveInboxModel(runtime, {
          instanceId: step.agent.instanceId,
          model: step.agent.model,
          reasoningEffort: step.agent.effort,
          serviceTier: null,
        }).pipe(Effect.mapError(fail("prepare-confirmation")));
      }
    }
    const needsDefault = action.type === "plan" && action.steps.some((step) => step.agent === null);
    // Freeze the Inbox defaults for null plan selections as well as new chats.
    const inbox = (yield* settings.snapshot().pipe(Effect.mapError(fail("prepare-confirmation"))))
      .inbox;
    const modelSelection =
      action.type === "new_chat" || needsDefault
        ? yield* resolveInboxModel(
            runtime,
            (action.type === "new_chat" ? action.agent : null) ?? inbox.chatAgent,
          ).pipe(Effect.mapError(fail("prepare-confirmation")))
        : null;
    // A decision's own choice of worktree wins; otherwise the Inbox's setting, frozen here.
    const executionSelection =
      (action.type === "new_chat" || action.type === "plan") && modelSelection
        ? {
            modelSelection,
            interactionMode: "default" as const,
            worktree:
              (action.type === "new_chat" ? action.worktree : null) ?? inbox.newChatsUseWorktrees,
          }
        : null;
    const proposedSkills = inboxActionSkills(storedAction);
    const droppedNames = new Set(draft.kind === "proposal" ? (draft.droppedSkillNames ?? []) : []);
    const proposedNames = new Set(proposedSkills.map(({ name }) => name));
    if (
      [...droppedNames].some((name) => !proposedNames.has(name)) ||
      inboxActionSkills(action).some(({ name }) => !proposedNames.has(name))
    )
      return yield* fail("prepare-confirmation")(
        new Error("A skill was not part of this suggestion"),
      );
    if (action.type === "new_chat" || action.type === "send_to_chat") {
      const required = new Set(inboxSkillTokens(action.prompt, "$"));
      action = {
        ...action,
        skills: proposedSkills.filter(({ name }) => !droppedNames.has(name) && !required.has(name)),
      };
    }
    const skillInvocations = yield* skillInventory.resolve(
      action,
      modelSelection?.instanceId,
      inboxActionSkills(action).map(({ name }) => name),
    );
    const prepared = {
      ...draft,
      ...(draft.kind === "proposal" && skillInvocations.length ? { skillInvocations } : {}),
      action,
      executionSelection,
      operationId: identity?.operationId ?? createOperationId("inbox.confirm"),
      sessionId: identity?.sessionId ?? createUuidV7(),
    };
    return draft.kind === "proposal"
      ? {
          ...prepared,
          kind: "proposal",
          proposalId: draft.proposalId,
          expectedRevision: draft.expectedRevision,
        }
      : { ...prepared, kind: "direct", pageIds: draft.pageIds, proposalId: createUuidV7() };
  });

  const confirm = Effect.fn("InboxApplication.confirm")(function* (
    input: InboxConfirmInput,
    confirmedBy: "user" | "nodex" = "user",
  ) {
    const parsed = yield* parse("confirm", () => InboxConfirmInputSchema.parse(input));
    // Core replays committed confirmations before checking whether the Page still waits.
    const action = parsed.action;
    if (action?.type === "execute_decision" && action.agent)
      yield* resolveInboxModel(runtime, action.agent).pipe(Effect.mapError(fail("confirm")));
    return yield* decision(
      "confirm",
      {
        kind: "confirm_inbox_dispatch",
        skill_invocations: [...(parsed.skillInvocations ?? [])],
        confirmed_by: confirmedBy,
        expected_store_epoch: parsed.storeEpoch,
        proposal_id: parsed.proposalId,
        expected_revision: parsed.expectedRevision,
        basis: parsed.basis.map(inboxPageBasisToCore),
        execution_selection: inboxExecutionSelectionToCore(parsed.executionSelection),
        action: parsed.action ? inboxDispatchActionToCore(parsed.action) : null,
        session_id: parsed.sessionId,
      },
      parsed.operationId,
    );
  });

  const dispatch = Effect.fn("InboxApplication.dispatch")(function* (input: InboxDispatchInput) {
    const parsed = yield* parse("dispatch", () => InboxDispatchInputSchema.parse(input));
    if (parsed.action.type === "execute_decision" && parsed.action.agent)
      yield* resolveInboxModel(runtime, parsed.action.agent).pipe(
        Effect.mapError(fail("dispatch")),
      );
    return yield* decision(
      "dispatch",
      {
        kind: "dispatch_inbox_entries",
        expected_store_epoch: parsed.storeEpoch,
        proposal_id: parsed.proposalId,
        page_ids: [...parsed.pageIds],
        basis: parsed.basis.map(inboxPageBasisToCore),
        execution_selection: inboxExecutionSelectionToCore(parsed.executionSelection),
        action: inboxDispatchActionToCore(parsed.action),
        session_id: parsed.sessionId,
      },
      parsed.operationId,
    );
  });
  const undo = Effect.fn("InboxApplication.undo")(function* (input: InboxUndoInput) {
    const parsed = yield* parse("undo", () => InboxUndoInputSchema.parse(input));
    return yield* mutate(
      "undo",
      { kind: "undo_inbox_decision", undo_token: parsed.undoToken },
      parsed.operationId,
    );
  });

  const keep = Effect.fn("InboxApplication.keep")(function* (
    input: InboxPageIdsInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("keep", () => InboxPageIdsInputSchema.parse(input));
    return yield* decision(
      "keep",
      { kind: "keep_inbox_entries", page_ids: [...parsed.pageIds] },
      operationId,
    );
  });

  const clearLater = Effect.fn("InboxApplication.clearLater")(function* (
    input: InboxPageIdsInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("clear-later", () => InboxPageIdsInputSchema.parse(input));
    return yield* mutate(
      "clear-later",
      { kind: "clear_inbox_later", page_ids: [...parsed.pageIds] },
      operationId,
    );
  });

  const setLater = Effect.fn("InboxApplication.setLater")(function* (
    input: InboxSetLaterInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("later", () => InboxSetLaterInputSchema.parse(input));
    return yield* mutate(
      "later",
      { kind: "set_inbox_later", page_ids: [...parsed.pageIds], until: parsed.until },
      operationId,
    );
  });

  const markDone = Effect.fn("InboxApplication.markDone")(function* (
    input: InboxPageIdsInput,
    operationId?: string,
  ) {
    const { pageIds } = yield* parse("mark-done", () => InboxPageIdsInputSchema.parse(input));
    return yield* decision(
      "mark-done",
      { kind: "mark_inbox_messages_done", page_ids: pageIds },
      operationId,
    );
  });

  const returnMessages = Effect.fn("InboxApplication.returnMessages")(function* (
    input: InboxPageIdsInput,
    operationId?: string,
  ) {
    const { pageIds } = yield* parse("return", () => InboxPageIdsInputSchema.parse(input));
    return yield* mutate(
      "return",
      { kind: "return_inbox_messages", page_ids: pageIds },
      operationId,
    );
  });

  const setKind = Effect.fn("InboxApplication.setKind")(function* (input: InboxSetKindInput) {
    const parsed = yield* parse("set-kind", () => InboxSetKindInputSchema.parse(input));
    return yield* mutate("set-kind", {
      kind: "set_inbox_entry_kind",
      page_id: parsed.pageId,
      entry_kind: parsed.kind,
    });
  });

  const setImportant = Effect.fn("InboxApplication.setImportant")(function* (
    input: InboxSetImportantInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("set-important", () => InboxSetImportantInputSchema.parse(input));
    return yield* mutate(
      "set-important",
      {
        kind: "set_inbox_entry_important",
        page_id: parsed.pageId,
        important: parsed.important,
      },
      operationId,
    );
  });

  const requestSuggestion = Effect.fn("InboxApplication.requestSuggestion")(function* (
    input: InboxSuggestionRequestInput,
  ) {
    const snapshot = yield* settings.snapshot().pipe(Effect.mapError(fail("request-suggestion")));
    if (snapshot.inbox.suggestions === "off")
      return yield* new InboxApplicationError({
        operation: "request-suggestion",
        message: "Inbox suggestions are off",
        cause: null,
      });
    const parsed = yield* parse("request-suggestion", () =>
      InboxSuggestionRequestInputSchema.parse(input),
    );
    return yield* mutate(
      "request-suggestion",
      {
        kind: "request_inbox_suggestion",
        request_id: parsed.requestId,
        mode: parsed.mode,
        page_ids: [...parsed.pageIds],
        basis: parsed.basis.map(inboxPageBasisToCore),
        proposal_id: parsed.proposalId ?? null,
        expected_revision: parsed.expectedRevision ?? null,
        correction: parsed.correction ?? null,
      },
      `inbox.request:${parsed.requestId}`,
    );
  });
  const stopSuggestion = Effect.fn("InboxApplication.stopSuggestion")(function* (
    input: InboxSuggestionStopInput,
  ) {
    const parsed = yield* parse("stop-suggestion", () =>
      InboxSuggestionStopInputSchema.parse(input),
    );
    return yield* mutate("stop-suggestion", inboxStopSuggestionToCore(parsed));
  });
  const suggestionLifetimes = (requestIds: readonly string[]) =>
    read("pending-suggestion-request-ids", {
      kind: "inbox_pending_suggestion_request_ids",
      request_ids: requestIds,
    }).pipe(
      Effect.flatMap((snapshot) =>
        parse("pending-suggestion-request-ids", () =>
          expectVariant(snapshot, "inbox_pending_suggestion_request_ids"),
        ),
      ),
    );
  const pendingSuggestionRequestIds = (requestIds: readonly string[]) =>
    suggestionLifetimes(requestIds).pipe(Effect.map((result) => result.request_ids));
  const prepareSuggestions = (limit: number, automatic: boolean) =>
    apply("prepare-suggestions", {
      kind: "prepare_inbox_suggestions",
      automatic,
      request_id: createUuidV7(),
      limit,
    }).pipe(Effect.asVoid);
  const suggestionRequests = (limit: number) =>
    read("suggestion-requests", { kind: "inbox_suggestion_requests", limit }).pipe(
      Effect.flatMap((snapshot) =>
        parse(
          "suggestion-requests",
          () => expectVariant(snapshot, "inbox_suggestion_requests").requests,
        ),
      ),
    );
  const suggestionRequest = (requestId: string) =>
    read("suggestion-request", { kind: "inbox_suggestion_request", request_id: requestId }).pipe(
      Effect.map((snapshot) => expectVariant(snapshot, "inbox_suggestion_request").request ?? null),
    );
  const beginRouting = (
    request: CoreInboxSuggestionRequest,
    coordinatorSessionId: string,
    skillOffers: readonly InboxSkillOffer[] = [],
  ) =>
    apply(
      "begin-routing",
      {
        kind: "begin_inbox_routing",
        skill_offers: [...skillOffers],
        request_id: request.request_id,
        generation: request.generation,
        coordinator_session_id: coordinatorSessionId,
      },
      `inbox.routing:${request.request_id}:${request.generation}`,
    ).pipe(Effect.asVoid);
  const startRoutingRun = Effect.fn("InboxApplication.startRoutingRun")(function* (
    request: CoreInboxSuggestionRequest,
    startedAt: number,
  ) {
    yield* apply("start-routing-run", {
      kind: "start_inbox_routing_run",
      request_id: request.request_id,
      generation: request.generation,
      coordinator_session_id: request.delivery!.coordinator_session_id,
      run_started_at_ms: startedAt,
    });
    const current = yield* suggestionRequest(request.request_id);
    return current?.delivery?.run_started_at_ms ?? startedAt;
  });
  // Routing workers and tool submissions share this observation boundary. A callback can
  // arrive before the worker's next poll; both must fence it against the same retained start.
  const routingStatus = Effect.fn("InboxApplication.routingStatus")(function* (
    request: CoreInboxSuggestionRequest,
  ): Effect.fn.Return<InboxRoutingStatus, InboxApplicationError> {
    let delivery = request.delivery;
    if (!delivery)
      return yield* fail("routing-status")(
        new Error("This routing request has not been delivered"),
      );
    const outcome = yield* runtime
      .runOutcome({
        sessionId: delivery.coordinator_session_id,
        messageId: inboxRoutingIdentity(request).messageId,
        carryingRun: true,
      })
      .pipe(Effect.result);
    const run = outcome._tag === "Success" ? outcome.success : null;
    if (delivery.run_started_at_ms == null && run?.startedAt) {
      const startedAt = Date.parse(run.startedAt);
      if (Number.isFinite(startedAt)) {
        const persisted = yield* startRoutingRun(request, startedAt);
        delivery = { ...delivery, run_started_at_ms: persisted };
      }
    }
    const status = {
      deadline: inboxRoutingDeadline(delivery),
      failureMessage: null as string | null,
      needsFollowup: false,
    };
    if (run?.status === "failed")
      return { ...status, failureMessage: run.failureMessage ?? "The suggestion failed" };
    if (run?.status === "cancelled")
      return { ...status, failureMessage: "Nodex stopped before answering this routing request" };
    if (run?.status !== "completed") return status;
    const followup = yield* runtime
      .runOutcome({
        sessionId: delivery.coordinator_session_id,
        messageId: inboxRoutingIdentity(request, true).messageId,
        carryingRun: true,
      })
      .pipe(Effect.result);
    const next = followup._tag === "Success" ? followup.success : null;
    if (next?.status === "failed")
      return { ...status, failureMessage: next.failureMessage ?? "The suggestion failed" };
    if (next?.status === "completed" || next?.status === "cancelled")
      return {
        ...status,
        failureMessage:
          "Nodex ended its follow-up without answering this routing request. Retry to ask again.",
      };
    return { ...status, needsFollowup: true };
  });
  const recordRoutingRefusal = (request: CoreInboxSuggestionRequest, reason: string) =>
    mutate("routing-refusal", {
      kind: "record_inbox_routing_refusal",
      request_id: request.request_id,
      generation: request.generation,
      coordinator_session_id: request.delivery!.coordinator_session_id,
      reason: reason.slice(0, 2048),
    }).pipe(Effect.asVoid);

  const writeSettlement = (input: InboxSuggestionSettlement, operationId?: string) =>
    apply("settle-suggestion", { kind: "settle_inbox_suggestion", ...input }, operationId).pipe(
      Effect.asVoid,
    );
  const settlementRefusalReason = (failure: InboxApplicationError) => {
    const refusal = coreRefusal(failure.cause);
    switch (refusal?.code) {
      case "invalid_input":
        return "The Agent returned a suggestion Nodex couldn’t save. Try again.";
      case "not_found":
        return "The message or suggestion destination is no longer available.";
      case "conflict":
      case "revision_conflict":
        return "The message or suggestion destination changed. Suggest again.";
      default:
        return null;
    }
  };
  const settleSuggestion = Effect.fn("InboxApplication.settleSuggestion")(function* (
    input: InboxSuggestionSettlement,
    operationId?: string,
  ) {
    // A tool submission can correct invalid advice within the same routing deadline.
    if (operationId !== undefined) return yield* writeSettlement(input, operationId);
    const result = yield* writeSettlement(input).pipe(Effect.result);
    if (result._tag === "Success") return;
    const reason = settlementRefusalReason(result.failure);
    if (!reason) return yield* result.failure;

    // A lost target can reject advice even when its request is still current.
    const ids = [input.request_id];
    if (!(yield* pendingSuggestionRequestIds(ids)).length) return;
    if (input.error !== null) return yield* result.failure;
    yield* writeSettlement({
      request_id: input.request_id,
      generation: input.generation,
      titles: [],
      suggestions: [],
      produced_by: null,
      error: reason,
      automatic_dispatch: false,
    }).pipe(
      Effect.catch((failure) => {
        if (!settlementRefusalReason(failure)) return Effect.fail(failure);
        // Stop or replacement can win between the pending check and this write.
        return pendingSuggestionRequestIds(ids).pipe(
          Effect.flatMap((pending) => (pending.length ? Effect.fail(failure) : Effect.void)),
        );
      }),
    );
  });

  const autoLane = yield* Semaphore.make(1);
  const autoConfirm = autoLane.withPermits(1)(
    Effect.gen(function* () {
      yield* readRoutingConsent(
        core,
        (yield* settings.snapshot().pipe(Effect.mapError(fail("automatic-dispatch")))).inbox,
      ).pipe(Effect.mapError(fail("automatic-dispatch")));
      if (yield* spaceHeld(core).pipe(Effect.mapError(fail("automatic-dispatch")))) return;
      const snapshot = yield* read("automatic-dispatches", {
        kind: "inbox_automatic_dispatches",
        limit: 100,
      });
      const { proposals } = expectVariant(snapshot, "inbox_automatic_dispatches");
      for (const proposal of proposals) {
        const action = inboxDispatchActionFromCore(proposal.action);
        if (
          proposal.outdated ||
          !proposal.explicit_request ||
          (action.type !== "new_chat" && action.type !== "send_to_chat")
        )
          continue;
        let held = false;
        for (const basis of proposal.basis)
          if (
            (yield* effectiveHolds(core, { kind: "page", page_id: basis.page_id }).pipe(
              Effect.mapError(fail("automatic-dispatch")),
            )).length
          )
            held = true;
        if (
          action.type === "send_to_chat" &&
          (yield* effectiveHolds(core, { kind: "session", session_id: action.sessionId }).pipe(
            Effect.mapError(fail("automatic-dispatch")),
          )).length
        )
          held = true;
        if (
          action.type === "new_chat" &&
          action.projectId &&
          (yield* scopeHeld(core, { kind: "project", project_id: action.projectId }).pipe(
            Effect.mapError(fail("automatic-dispatch")),
          ))
        )
          held = true;
        if (held) continue;
        const at = Date.parse(proposal.created_at);
        const operationId = createStableOperationId("inbox.auto-confirm", at, [
          proposal.proposal_id,
          proposal.revision,
        ]);
        const prepared = yield* prepareConfirmation(
          {
            kind: "proposal",
            storeEpoch: snapshot.store_epoch,
            proposalId: proposal.proposal_id,
            expectedRevision: proposal.revision,
            basis: proposal.basis.map(inboxPageBasisFromCore),
            action: { ...action, additions: [], skills: [] },
            droppedSkillNames: inboxActionSkills(action).map(({ name }) => name),
          },
          {
            operationId,
            sessionId: deriveSessionDispatchIdentity(operationId, "inbox-auto-session", at),
          },
        ).pipe(Effect.result);
        if (prepared._tag === "Failure" || prepared.success.kind !== "proposal") continue;
        // Core rechecks written content, all-user membership and the exact unchanged action atomically.
        const { kind: _kind, ...confirmation } = prepared.success;
        yield* confirm(confirmation, "nodex").pipe(Effect.catch(() => Effect.void));
      }
    }),
  );

  const retryDispatch = Effect.fn("InboxApplication.retryDispatch")(function* (
    input: InboxProposalInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("retry-dispatch", () => InboxProposalInputSchema.parse(input));
    return yield* mutate(
      "retry-dispatch",
      {
        kind: "retry_inbox_dispatch",
        proposal_id: parsed.proposalId,
      },
      operationId,
    );
  });

  const deleteMessages = Effect.fn("InboxApplication.delete")(function* (
    input: InboxPageIdsInput,
    operationId?: string,
  ) {
    const parsed = yield* parse("delete", () => InboxPageIdsInputSchema.parse(input));
    const result = yield* mutate(
      "delete",
      {
        kind: "delete_inbox_messages",
        page_ids: parsed.pageIds,
      },
      operationId,
    );
    yield* administration.requestErasure;
    return result;
  });

  const pendingSuggestions = (limit: number) =>
    read("pending-suggestions", { kind: "inbox_pending_suggestions", limit }).pipe(
      Effect.flatMap((snapshot) =>
        parse(
          "pending-suggestions",
          () => expectVariant(snapshot, "inbox_pending_suggestions").entries,
        ),
      ),
      Effect.map((entries) => entries.filter((entry) => entry.source.kind !== "automation")),
    );

  const dispatchContext = (pageIds: readonly string[]) =>
    read("dispatch-context", { kind: "inbox_dispatch_context", page_ids: [...pageIds] }).pipe(
      Effect.flatMap((snapshot) =>
        parse("dispatch-context", () => expectVariant(snapshot, "inbox_dispatch_context").context),
      ),
    );

  const propose = (proposal: InboxSuggestionProposal) =>
    apply("propose", {
      kind: "propose_inbox_dispatch",
      proposal_id: proposal.proposalId,
      page_ids: [...proposal.pageIds],
      basis: [...proposal.basis],
      action: inboxDispatchActionToCore(proposal.action),
      entry_kind: proposal.kind,
      summary: proposal.summary,
      rationale: proposal.rationale,
      produced_by: proposal.producedBy,
    }).pipe(Effect.asVoid);

  const nameEntry = Effect.fn("InboxApplication.nameEntry")(function* (input: InboxEntryName) {
    const { basis } = input;
    const snapshot = yield* core.library
      .read(
        { kind: "page_projection_file", page_id: basis.page_id, file_kind: "meta_yaml" },
        undefined,
        null,
      )
      .pipe(Effect.mapError(fail("name")));
    if (snapshot.value.kind !== "page_projection_file") return null;
    const page = snapshot.value.value;
    const titleEtag = page.validators.title_etag;
    if (!titleEtag) return null;
    const current = (yield* dispatchContext([basis.page_id])).entries[0];
    if (!current?.title_provisional || current.basis.content_hash !== basis.content_hash)
      return null;
    // The earlier Document head fences any change before or after the content check.
    yield* core.document
      .apply(
        {
          operationId: createOperationId("inbox.name"),
          clientSessionId: "inbox-naming",
          intent: {
            kind: "apply_semantic_mutation",
            document_id: page.document_id,
            generation: page.document_generation,
            expected_head_seq: page.document_head_seq,
            commands: [
              {
                kind: "set_title",
                inline_markdown: writeInlineMarkdown([
                  { type: "text", text: input.title, styles: {} },
                ]),
                expected_etag: titleEtag,
              },
            ],
          },
        },
        undefined,
        null,
      )
      .pipe(Effect.mapError(fail("name")));
    return basis;
  });

  const recordSuggestionFailure = (pageIds: readonly string[], message: string) =>
    apply("suggestion-failure", {
      kind: "record_inbox_suggestion_failure",
      page_ids: [...pageIds],
      message,
    }).pipe(Effect.asVoid);

  const holdAutomationDecision = Effect.fn("InboxApplication.holdAutomationDecision")(function* (
    claim: AutomationClaim,
  ) {
    const capture = automationDecisionCapture(claim.dispatchId);
    yield* apply(
      "hold-automation-decision",
      {
        kind: "hold_automation_decision",
        lease_id: claim.leaseId,
        page_id: capture.pageId,
        document_id: capture.documentId,
        title: automationDecisionTitle(claim.definition.name, claim.scheduledFor),
      },
      capture.operationId,
    );
  });

  const confirmAutomationDecision = Effect.fn("InboxApplication.confirmAutomationDecision")(
    function* (automationDecision: AutomationHeldDecision) {
      const scope = automationDecision.inboxProjectId
        ? { kind: "project" as const, projectId: automationDecision.inboxProjectId }
        : { kind: "library" as const };
      let after: string | null = null;
      do {
        const snapshot: InboxWindow = yield* window({ scope, filter: "inbox", first: 200, after });
        const item = snapshot.items.find((item) => item.pageId === automationDecision.pageId);
        const proposal = item?.proposal;
        if (
          item &&
          proposal?.origin === "automation" &&
          proposal.action.type === "execute_decision" &&
          proposal.action.decisionId === automationDecision.dispatchId
        ) {
          if (proposal.state === "failed" && item.automationDecision?.status === "failed") {
            return yield* retryDispatch({ proposalId: proposal.proposalId }).pipe(Effect.asVoid);
          }
          if (proposal.state !== "open") break;
          const prepared = yield* prepareConfirmation({
            kind: "proposal",
            storeEpoch: snapshot.storeEpoch,
            proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
            basis: [item.basis],
          });
          if (prepared.kind === "proposal") {
            const { kind: _kind, ...input } = prepared;
            return yield* confirm(input).pipe(Effect.asVoid);
          }
        }
        after = snapshot.nextCursor;
      } while (after !== null);
      return yield* fail("confirm-automation-decision")(
        new Error("This Automation's waiting run changed. Review it in the Inbox."),
      );
    },
  );

  const outbox = (limit: number) =>
    read("outbox", { kind: "inbox_dispatch_outbox", limit }).pipe(
      Effect.flatMap((snapshot) =>
        parse("outbox", () => expectVariant(snapshot, "inbox_dispatch_outbox").dispatches),
      ),
    );

  const dispatchFence = (work: InboxDispatchFence) => ({
    proposal_id: work.proposal_id,
    expected_revision: work.revision,
    message_id: work.message_id,
  });
  const beginDispatch = (work: InboxDispatchFence) =>
    apply("begin-dispatch", { kind: "begin_inbox_dispatch", ...dispatchFence(work) }).pipe(
      Effect.asVoid,
    );
  const completeDispatch = (
    work: InboxDispatchFence,
    threadId: string | null,
    unavailableSkillNames: readonly string[] = [],
  ) =>
    apply("complete-dispatch", {
      kind: "complete_inbox_dispatch",
      ...dispatchFence(work),
      dispatched_thread_id: threadId,
      unavailable_skill_names: [...unavailableSkillNames],
    }).pipe(Effect.asVoid);
  const failDispatch = (
    work: InboxDispatchFence,
    message: string,
    kind: "rejected" | "unavailable" | "unknown",
  ) =>
    apply("fail-dispatch", {
      kind: "fail_inbox_dispatch",
      ...dispatchFence(work),
      message,
      failure_kind: kind,
    }).pipe(Effect.asVoid);

  return InboxApplication.of({
    activity,
    retryProblem,
    holdAutomationDecision,
    confirmAutomationDecision,
    summary,
    chatTargets,
    counts,
    window,
    message,
    send,
    replyDestination,
    edit,
    prepareConfirmation,
    skillAvailability,
    confirm,
    undo,
    dispatch,
    keep,
    setLater,
    clearLater,
    markDone,
    returnMessages,
    setKind,
    setImportant,
    requestSuggestion,
    stopSuggestion,
    pendingSuggestionRequestIds,
    cancelledRoutingDeliveries: (requestIds) =>
      suggestionLifetimes(requestIds).pipe(Effect.map((result) => result.cancelled_deliveries)),
    prepareSuggestions,
    suggestionRequests,
    entry,
    settleSuggestion,
    suggestionRequest,
    beginRouting,
    routingStatus,
    recordRoutingRefusal,
    executionHeld,
    autoConfirm,
    retryDispatch,
    delete: deleteMessages,
    pendingSuggestions,
    dispatchContext,
    propose,
    nameEntry,
    recordSuggestionFailure,
    outbox,
    beginDispatch,
    completeDispatch,
    failDispatch,
  });
});

export const live: Layer.Layer<
  InboxApplication,
  never,
  CoreModules | StoreAdministration | AgentRuntimeApplication | ApplicationSettings
> = Layer.effect(InboxApplication, make);
