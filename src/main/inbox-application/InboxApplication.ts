import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  InboxChatTargets,
  InboxChatTargetsInput,
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxPreparedConfirmation,
  InboxDecisionResult,
  InboxSuggestionRequestInput,
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
  InboxSetStateInput,
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
  InboxSetStateInputSchema,
  InboxSuggestionRequestInputSchema,
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
  inboxItemFromCore,
  inboxScopeToCore,
  inboxSummaryFromCore,
  type CoreInboxDispatchContext,
  type CoreInboxDispatchWork,
  type CoreInboxPageBasis,
  type CoreInboxSuggestionInput,
  type CoreInboxSuggestionRequest,
} from "../core-client/inbox-adapter";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../core-runtime/StoreAdministration";
import type { ProjectWorkspaceCommandResult } from "../project-application/ProjectWorkspace";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import { renderInboxOrchestration } from "./inbox-orchestration";
import { createOperationId } from "../core-runtime/operation-identity";
import { scheduledFiringCapture, scheduledFiringTitle } from "./scheduled-firing";
import type { AutomationDefinitionClaim } from "../automation-application/AutomationApplication";
import type { CodexScheduledAutomationHeldFiring } from "../../shared/types";

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

/** The Inbox's Core-backed application Interface for renderers, Agents, and host workers. */
export class InboxApplication extends Context.Service<
  InboxApplication,
  {
    readonly holdScheduledFiring: (claim: AutomationDefinitionClaim) => InboxEffect<void>;
    readonly confirmScheduledFiring: (
      firing: CodexScheduledAutomationHeldFiring,
    ) => InboxEffect<void>;
    readonly chatTargets: (input: InboxChatTargetsInput) => InboxEffect<InboxChatTargets>;
    readonly summary: (input: InboxSummaryInput) => InboxEffect<InboxSummary>;
    /** Messages waiting in the Library Inbox and in each Project's Inbox. */
    readonly counts: InboxEffect<InboxCounts>;
    readonly window: (input: InboxWindowInput) => InboxEffect<InboxWindow>;
    readonly send: (input: InboxSendInput) => InboxMutation<InboxSendResult>;
    readonly prepareConfirmation: (
      input: InboxConfirmationDraft,
    ) => InboxEffect<InboxPreparedConfirmation>;
    readonly undo: (input: InboxUndoInput) => InboxMutation;
    /**
     * Saves a stream rewrite and queues automatic advice, keeping the previous proposal visible.
     */
    readonly edit: (input: InboxEditInput) => InboxMutation;
    readonly confirm: (input: InboxConfirmInput) => InboxMutation<InboxDecisionResult>;
    readonly dispatch: (input: InboxDispatchInput) => InboxMutation<InboxDecisionResult>;
    readonly keep: (input: InboxPageIdsInput) => InboxMutation;
    readonly setState: (input: InboxSetStateInput) => InboxMutation;
    readonly setKind: (input: InboxSetKindInput) => InboxMutation;
    readonly setImportant: (input: InboxSetImportantInput) => InboxMutation;
    readonly requestSuggestion: (input: InboxSuggestionRequestInput) => InboxMutation;
    readonly prepareSuggestions: (limit: number, automatic: boolean) => InboxEffect<void>;
    readonly suggestionRequests: (
      limit: number,
    ) => InboxEffect<readonly CoreInboxSuggestionRequest[]>;
    readonly settleSuggestion: (input: InboxSuggestionSettlement) => InboxEffect<void>;
    readonly retryDispatch: (input: InboxProposalInput) => InboxMutation;
    /** Erases messages: the Inbox forgets them now and Store maintenance collects their Pages. */
    readonly delete: (input: InboxPageIdsInput) => InboxMutation;
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
    ) => InboxEffect<void>;
    readonly failDispatch: (
      work: InboxDispatchFence,
      message: string,
      kind: "rejected" | "unavailable" | "unknown",
    ) => InboxEffect<void>;
  }
>()("nodex/main/inbox-application/InboxApplication") {}

// A Core refusal is written for the user, so it explains itself; a runtime or transport failure
// keeps its safe message.
const isNotFound = (cause: unknown): boolean => {
  const refusal = Schema.is(CoreRuntimeError)(cause) ? cause.cause : cause;
  return refusal instanceof CoreModuleResponseError && refusal.coreError.code === "not_found";
};

const errorMessage = (cause: unknown): string => {
  const refusal = Schema.is(CoreRuntimeError)(cause) ? cause.cause : cause;
  if (refusal instanceof CoreModuleResponseError) return refusal.coreError.message;
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

  const parse = <A>(operation: string, run: () => A): InboxEffect<A> =>
    Effect.try({ try: run, catch: fail(operation) });

  // Inbox authority is trusted local Library authority: never bind a Project.
  const read = (operation: string, request: ProjectWorkspaceRead) =>
    core.workspace.read(request, undefined, null).pipe(Effect.mapError(fail(operation)));

  const apply = (
    operation: string,
    intent: ApplyIntent,
    operationId = createOperationId(`inbox.${operation}`),
  ) =>
    core.workspace
      .apply({ operationId, intent }, undefined, null)
      .pipe(Effect.mapError(fail(operation)));
  const mutate = (operation: string, intent: ApplyIntent, operationId?: string): InboxMutation =>
    apply(operation, intent, operationId).pipe(
      Effect.map((apply) => ({ value: undefined, apply })),
    );
  const decision = (
    operation: string,
    intent: ApplyIntent,
    operationId: string,
  ): InboxMutation<InboxDecisionResult> =>
    apply(operation, intent, operationId).pipe(
      Effect.map((apply) => ({
        value: { undoToken: apply.outcome.inbox_undo_token ?? null },
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

  const send = Effect.fn("InboxApplication.send")(function* (input: InboxSendInput) {
    const parsed = yield* parse("send", () => InboxSendInputSchema.parse(input));
    const applied = yield* apply(
      "send",
      {
        kind: "send_inbox_message",
        page_id: parsed.pageId,
        document_id: parsed.documentId,
        body: parsed.body,
        project_id: parsed.scope.kind === "project" ? parsed.scope.projectId : null,
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
      .read(
        { kind: "page_projection_file", page_id: parsed.pageId, file_kind: "meta_yaml" },
        undefined,
        null,
      )
      .pipe(
        Effect.flatMap((snapshot) =>
          snapshot.value.kind === "page_projection_file"
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

  const prepareConfirmation = Effect.fn("InboxApplication.prepareConfirmation")(function* (
    input: InboxConfirmationDraft,
  ): Effect.fn.Return<InboxPreparedConfirmation, InboxApplicationError> {
    const draft = yield* parse("prepare-confirmation", () =>
      InboxConfirmationDraftSchema.parse(input),
    );
    const context = yield* dispatchContext(draft.basis.map((basis) => basis.pageId));
    const proposal =
      draft.kind === "proposal"
        ? context.open_proposals.find((proposal) => proposal.proposal_id === draft.proposalId)
        : undefined;
    const action = draft.action ?? (proposal ? inboxDispatchActionFromCore(proposal.action) : null);
    if (!action)
      return yield* fail("prepare-confirmation")(
        new Error("Review this suggestion before deciding"),
      );
    if (action.type === "run_task" && action.agent)
      yield* resolveInboxModel(runtime, action.agent).pipe(
        Effect.mapError(fail("prepare-confirmation")),
      );
    // A new chat runs on the Agent its decision chose, or else the Inbox's own. Its delegation
    // instructions are written now, against the catalog that resolved it, and frozen with it.
    const modelSelection =
      action.type === "new_chat"
        ? yield* resolveInboxModel(
            runtime,
            action.agent ??
              (yield* settings.snapshot().pipe(Effect.mapError(fail("prepare-confirmation")))).inbox
                .chatAgent,
          ).pipe(Effect.mapError(fail("prepare-confirmation")))
        : null;
    const executionSelection =
      action.type === "new_chat" && modelSelection
        ? {
            modelSelection,
            interactionMode: "default" as const,
            orchestration:
              action.delegates.length > 0 || action.plan
                ? renderInboxOrchestration(
                    yield* runtime.catalog().pipe(Effect.mapError(fail("prepare-confirmation"))),
                    action,
                    modelSelection.instanceId,
                  )
                : null,
          }
        : null;
    const prepared = {
      ...draft,
      action,
      executionSelection,
      operationId: createOperationId("inbox.confirm"),
      sessionId: createUuidV7(),
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

  const confirm = Effect.fn("InboxApplication.confirm")(function* (input: InboxConfirmInput) {
    const parsed = yield* parse("confirm", () => InboxConfirmInputSchema.parse(input));
    const context = yield* dispatchContext(parsed.basis.map((basis) => basis.pageId));
    const proposal = context.open_proposals.find(
      (proposal) => proposal.proposal_id === parsed.proposalId,
    );
    const action =
      parsed.action ?? (proposal ? inboxDispatchActionFromCore(proposal.action) : null);
    if (action?.type === "run_task" && action.agent)
      yield* resolveInboxModel(runtime, action.agent).pipe(Effect.mapError(fail("confirm")));
    return yield* decision(
      "confirm",
      {
        kind: "confirm_inbox_dispatch",
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
    if (parsed.action.type === "run_task" && parsed.action.agent)
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

  const keep = Effect.fn("InboxApplication.keep")(function* (input: InboxPageIdsInput) {
    const parsed = yield* parse("keep", () => InboxPageIdsInputSchema.parse(input));
    return yield* mutate("keep", { kind: "keep_inbox_entries", page_ids: [...parsed.pageIds] });
  });

  const setState = Effect.fn("InboxApplication.setState")(function* (input: InboxSetStateInput) {
    const parsed = yield* parse("set-state", () => InboxSetStateInputSchema.parse(input));
    return yield* mutate("set-state", {
      kind: "set_inbox_entry_state",
      page_ids: [...parsed.pageIds],
      state: parsed.state,
    });
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
  ) {
    const parsed = yield* parse("set-important", () => InboxSetImportantInputSchema.parse(input));
    return yield* mutate("set-important", {
      kind: "set_inbox_entry_important",
      page_id: parsed.pageId,
      important: parsed.important,
    });
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
  const settleSuggestion = (input: InboxSuggestionSettlement) =>
    apply("settle-suggestion", { kind: "settle_inbox_suggestion", ...input }).pipe(Effect.asVoid);

  const retryDispatch = Effect.fn("InboxApplication.retryDispatch")(function* (
    input: InboxProposalInput,
  ) {
    const parsed = yield* parse("retry-dispatch", () => InboxProposalInputSchema.parse(input));
    return yield* mutate("retry-dispatch", {
      kind: "retry_inbox_dispatch",
      proposal_id: parsed.proposalId,
    });
  });

  const deleteMessages = Effect.fn("InboxApplication.delete")(function* (input: InboxPageIdsInput) {
    const parsed = yield* parse("delete", () => InboxPageIdsInputSchema.parse(input));
    const result = yield* mutate("delete", {
      kind: "delete_inbox_messages",
      page_ids: parsed.pageIds,
    });
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
      Effect.map((entries) => entries.filter((entry) => entry.source.kind !== "scheduled_task")),
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

  const holdScheduledFiring = Effect.fn("InboxApplication.holdScheduledFiring")(function* (
    claim: AutomationDefinitionClaim,
  ) {
    const capture = scheduledFiringCapture(claim.dispatchId);
    yield* apply(
      "hold-scheduled-firing",
      {
        kind: "hold_scheduled_firing",
        lease_id: claim.leaseId,
        page_id: capture.pageId,
        document_id: capture.documentId,
        title: scheduledFiringTitle(claim.definition.name, claim.scheduledFor),
      },
      capture.operationId,
    );
  });

  const confirmScheduledFiring = Effect.fn("InboxApplication.confirmScheduledFiring")(function* (
    firing: CodexScheduledAutomationHeldFiring,
  ) {
    const scope = firing.inboxProjectId
      ? { kind: "project" as const, projectId: firing.inboxProjectId }
      : { kind: "library" as const };
    let after: string | null = null;
    do {
      const snapshot: InboxWindow = yield* window({ scope, filter: "inbox", first: 200, after });
      const item = snapshot.items.find((item) => item.pageId === firing.pageId);
      const proposal = item?.proposal;
      if (
        item &&
        proposal?.origin === "schedule" &&
        proposal.action.type === "run_task" &&
        proposal.action.dispatchId === firing.dispatchId
      ) {
        if (proposal.state === "failed" && item.firing?.status === "failed") {
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
    return yield* fail("confirm-scheduled-firing")(
      new Error("This scheduled task's waiting run changed. Review it in the Inbox."),
    );
  });

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
  const completeDispatch = (work: InboxDispatchFence, threadId: string | null) =>
    apply("complete-dispatch", {
      kind: "complete_inbox_dispatch",
      ...dispatchFence(work),
      dispatched_thread_id: threadId,
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
    holdScheduledFiring,
    confirmScheduledFiring,
    summary,
    chatTargets,
    counts,
    window,
    send,
    edit,
    prepareConfirmation,
    confirm,
    undo,
    dispatch,
    keep,
    setState,
    setKind,
    setImportant,
    requestSuggestion,
    prepareSuggestions,
    suggestionRequests,
    settleSuggestion,
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
