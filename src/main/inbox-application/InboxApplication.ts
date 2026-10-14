import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  InboxConfirmInput,
  InboxCounts,
  InboxDispatchAction,
  InboxDispatchInput,
  InboxEntryKind,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSendResult,
  InboxSetKindInput,
  InboxSetStateInput,
  InboxSummary,
  InboxSummaryInput,
  InboxWindow,
  InboxWindowInput,
} from "../../shared/inbox";
import {
  InboxConfirmInputSchema,
  InboxDispatchInputSchema,
  InboxPageIdsInputSchema,
  InboxProposalInputSchema,
  InboxSendInputSchema,
  InboxSetKindInputSchema,
  InboxSetStateInputSchema,
  InboxSuggestionRequestInputSchema,
  InboxSummaryInputSchema,
  InboxWindowInputSchema,
} from "../../shared/schemas/inbox";
import { serializeInlineContent } from "../../shared/nfm/serializer-inline";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  inboxCountsFromCore,
  inboxDispatchActionToCore,
  inboxItemFromCore,
  inboxScopeToCore,
  inboxSummaryFromCore,
  type CoreInboxDispatchContext,
  type CoreInboxDispatchWork,
  type CoreInboxPageBasis,
  type CoreInboxSuggestionInput,
} from "../core-client/inbox-adapter";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { StoreAdministration } from "../core-runtime/StoreAdministration";
import { createOperationId } from "../core-runtime/operation-identity";

export class InboxApplicationError extends Schema.TaggedError<InboxApplicationError>()(
  "InboxApplicationError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** A suggestion or delivery step failed with a user-presentable reason. */
export class InboxRuntimeError extends Schema.TaggedError<InboxRuntimeError>()(
  "InboxRuntimeError",
  { message: Schema.String },
) {}

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

/** The Inbox's Core-backed application Interface for renderers, Agents, and host workers. */
export class InboxApplication extends Context.Service<
  InboxApplication,
  {
    readonly summary: (input: InboxSummaryInput) => InboxEffect<InboxSummary>;
    /** Messages waiting in the Library Inbox and in each Project's Inbox. */
    readonly counts: InboxEffect<InboxCounts>;
    readonly window: (input: InboxWindowInput) => InboxEffect<InboxWindow>;
    readonly send: (input: InboxSendInput) => InboxEffect<InboxSendResult>;
    readonly confirm: (input: InboxConfirmInput) => InboxEffect<void>;
    readonly dispatch: (input: InboxDispatchInput) => InboxEffect<void>;
    readonly keep: (input: InboxPageIdsInput) => InboxEffect<void>;
    readonly setState: (input: InboxSetStateInput) => InboxEffect<void>;
    readonly setKind: (input: InboxSetKindInput) => InboxEffect<void>;
    readonly requestSuggestion: (input: InboxPageIdsInput) => InboxEffect<void>;
    readonly retryDispatch: (input: InboxProposalInput) => InboxEffect<void>;
    /** Erases messages: the Inbox forgets them now and Store maintenance collects their Pages. */
    readonly delete: (input: InboxPageIdsInput) => InboxEffect<void>;
    readonly pendingSuggestions: (
      limit: number,
    ) => InboxEffect<readonly CoreInboxSuggestionInput[]>;
    readonly dispatchContext: (pageIds: readonly string[]) => InboxEffect<CoreInboxDispatchContext>;
    readonly propose: (proposal: InboxSuggestionProposal) => InboxEffect<void>;
    /**
     * Replaces Core's provisional title with a name, only if the message Page is still exactly
     * as the Agent read it. Returns the Page's new basis, or null when it changed meanwhile.
     */
    readonly nameEntry: (input: InboxEntryName) => InboxEffect<CoreInboxPageBasis | null>;
    readonly recordSuggestionFailure: (
      pageIds: readonly string[],
      message: string,
    ) => InboxEffect<void>;
    readonly outbox: (limit: number) => InboxEffect<readonly CoreInboxDispatchWork[]>;
    readonly completeDispatch: (proposalId: string, threadId: string | null) => InboxEffect<void>;
    readonly failDispatch: (proposalId: string, message: string) => InboxEffect<void>;
  }
>()("nodex/main/inbox-application/InboxApplication") {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : "The Inbox operation failed";

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

  const fail = (operation: string) => (cause: unknown) =>
    new InboxApplicationError({ operation, message: errorMessage(cause), cause });

  const parse = <A>(operation: string, run: () => A): InboxEffect<A> =>
    Effect.try({ try: run, catch: fail(operation) });

  // Inbox authority is trusted local Library authority: never bind a Project.
  const read = (operation: string, request: ProjectWorkspaceRead) =>
    core.workspace.read(request, undefined, null).pipe(Effect.mapError(fail(operation)));

  const apply = (operation: string, intent: ApplyIntent): InboxEffect<void> =>
    core.workspace
      .apply({ operationId: createOperationId(`inbox.${operation}`), intent }, undefined, null)
      .pipe(Effect.asVoid, Effect.mapError(fail(operation)));

  const summary = Effect.fn("InboxApplication.summary")(function* (input: InboxSummaryInput) {
    const parsed = yield* parse("summary", () => InboxSummaryInputSchema.parse(input));
    const snapshot = yield* read("summary", {
      kind: "inbox_summary",
      scope: inboxScopeToCore(parsed.scope),
    });
    return yield* parse("summary", () =>
      inboxSummaryFromCore(expectVariant(snapshot, "inbox_summary").summary),
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
      } satisfies InboxWindow;
    });
  });

  const send = Effect.fn("InboxApplication.send")(function* (input: InboxSendInput) {
    const parsed = yield* parse("send", () => InboxSendInputSchema.parse(input));
    const pageId = createUuidV7();
    yield* apply("send", {
      kind: "send_inbox_message",
      page_id: pageId,
      document_id: createUuidV7(),
      text: parsed.text,
      project_id: parsed.scope.kind === "project" ? parsed.scope.projectId : null,
    });
    return { pageId } satisfies InboxSendResult;
  });

  // Core consumes the preallocated Session identity only when the confirmed action starts a chat.
  const confirm = Effect.fn("InboxApplication.confirm")(function* (input: InboxConfirmInput) {
    const parsed = yield* parse("confirm", () => InboxConfirmInputSchema.parse(input));
    yield* apply("confirm", {
      kind: "confirm_inbox_dispatch",
      proposal_id: parsed.proposalId,
      expected_revision: parsed.expectedRevision,
      action: parsed.action ? inboxDispatchActionToCore(parsed.action) : null,
      session_id: createUuidV7(),
    });
  });

  const dispatch = Effect.fn("InboxApplication.dispatch")(function* (input: InboxDispatchInput) {
    const parsed = yield* parse("dispatch", () => InboxDispatchInputSchema.parse(input));
    yield* apply("dispatch", {
      kind: "dispatch_inbox_entries",
      proposal_id: createUuidV7(),
      page_ids: [...parsed.pageIds],
      action: inboxDispatchActionToCore(parsed.action),
      session_id: createUuidV7(),
    });
  });

  const keep = Effect.fn("InboxApplication.keep")(function* (input: InboxPageIdsInput) {
    const parsed = yield* parse("keep", () => InboxPageIdsInputSchema.parse(input));
    yield* apply("keep", { kind: "keep_inbox_entries", page_ids: [...parsed.pageIds] });
  });

  const setState = Effect.fn("InboxApplication.setState")(function* (input: InboxSetStateInput) {
    const parsed = yield* parse("set-state", () => InboxSetStateInputSchema.parse(input));
    yield* apply("set-state", {
      kind: "set_inbox_entry_state",
      page_ids: [...parsed.pageIds],
      state: parsed.state,
    });
  });

  const setKind = Effect.fn("InboxApplication.setKind")(function* (input: InboxSetKindInput) {
    const parsed = yield* parse("set-kind", () => InboxSetKindInputSchema.parse(input));
    yield* apply("set-kind", {
      kind: "set_inbox_entry_kind",
      page_id: parsed.pageId,
      entry_kind: parsed.kind,
    });
  });

  const requestSuggestion = Effect.fn("InboxApplication.requestSuggestion")(function* (
    input: InboxPageIdsInput,
  ) {
    const parsed = yield* parse("request-suggestion", () =>
      InboxSuggestionRequestInputSchema.parse(input),
    );
    yield* apply("request-suggestion", {
      kind: "request_inbox_suggestion",
      page_ids: [...parsed.pageIds],
    });
  });

  const retryDispatch = Effect.fn("InboxApplication.retryDispatch")(function* (
    input: InboxProposalInput,
  ) {
    const parsed = yield* parse("retry-dispatch", () => InboxProposalInputSchema.parse(input));
    yield* apply("retry-dispatch", {
      kind: "retry_inbox_dispatch",
      proposal_id: parsed.proposalId,
    });
  });

  const deleteMessages = Effect.fn("InboxApplication.delete")(function* (input: InboxPageIdsInput) {
    const parsed = yield* parse("delete", () => InboxPageIdsInputSchema.parse(input));
    yield* apply("delete", { kind: "delete_inbox_messages", page_ids: parsed.pageIds });
    yield* administration.requestErasure;
  });

  const pendingSuggestions = (limit: number) =>
    read("pending-suggestions", { kind: "inbox_pending_suggestions", limit }).pipe(
      Effect.flatMap((snapshot) =>
        parse(
          "pending-suggestions",
          () => expectVariant(snapshot, "inbox_pending_suggestions").entries,
        ),
      ),
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
    });

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
    if (
      !titleEtag ||
      page.document_generation !== basis.generation ||
      page.document_head_seq !== basis.head_seq
    )
      return null;
    // The head fence covers the whole Page, so any edit since the Agent read it wins.
    const applied = yield* core.document
      .apply(
        {
          operationId: createOperationId("inbox.name"),
          clientSessionId: "inbox-naming",
          intent: {
            kind: "apply_semantic_mutation",
            document_id: page.document_id,
            generation: basis.generation,
            expected_head_seq: basis.head_seq,
            commands: [
              {
                kind: "set_title",
                inline_markdown: serializeInlineContent([
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
    return {
      page_id: basis.page_id,
      generation: applied.outcome.generation,
      head_seq: applied.outcome.head_seq,
    } satisfies CoreInboxPageBasis;
  });

  const recordSuggestionFailure = (pageIds: readonly string[], message: string) =>
    apply("suggestion-failure", {
      kind: "record_inbox_suggestion_failure",
      page_ids: [...pageIds],
      message,
    });

  const outbox = (limit: number) =>
    read("outbox", { kind: "inbox_dispatch_outbox", limit }).pipe(
      Effect.flatMap((snapshot) =>
        parse("outbox", () => expectVariant(snapshot, "inbox_dispatch_outbox").dispatches),
      ),
    );

  const completeDispatch = (proposalId: string, threadId: string | null) =>
    apply("complete-dispatch", {
      kind: "complete_inbox_dispatch",
      proposal_id: proposalId,
      dispatched_thread_id: threadId,
    });

  const failDispatch = (proposalId: string, message: string) =>
    apply("fail-dispatch", {
      kind: "fail_inbox_dispatch",
      proposal_id: proposalId,
      message,
    });

  return InboxApplication.of({
    summary,
    counts,
    window,
    send,
    confirm,
    dispatch,
    keep,
    setState,
    setKind,
    requestSuggestion,
    retryDispatch,
    delete: deleteMessages,
    pendingSuggestions,
    dispatchContext,
    propose,
    nameEntry,
    recordSuggestionFailure,
    outbox,
    completeDispatch,
    failDispatch,
  });
});

export const live: Layer.Layer<InboxApplication, never, CoreModules | StoreAdministration> =
  Layer.effect(InboxApplication, make);
