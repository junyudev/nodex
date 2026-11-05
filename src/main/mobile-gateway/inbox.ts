import type { AgentChoice, InboxMessage, InboxProposalAction } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { composeMessageText, messageImageBlock } from "../../shared/message-content";
import { encodeBoundedOperationId, isBoundedOperationId } from "../../shared/operation-identity";
import { isUuidV7 } from "../../shared/uuid-v7";
import {
  inboxNewChatAction,
  type InboxAgentChoice,
  type InboxItem,
  type InboxPreparedConfirmation,
  type InboxProposal,
} from "../../shared/inbox";
import { InboxSendInputSchema } from "../../shared/schemas/inbox";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import {
  InboxApplication,
  type InboxApplicationError,
} from "../inbox-application/InboxApplication";
import { MobileProfileFiles } from "../platform/node/MobileProfileFiles";
import { invalid, missing, rpcError, unavailable, type MobileHandlers } from "./rpc";
import type { makeMobileFiles } from "./files";

export const mobileAgentChoice = (choice: AgentChoice): InboxAgentChoice => ({
  instanceId: choice.providerInstanceId,
  model: choice.model,
  reasoningEffort: null,
  serviceTier: null,
});

const projectAction = (
  { action, targetProjectName, chat }: InboxProposal,
  item: InboxItem,
): InboxProposalAction => {
  switch (action.type) {
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return {
        type: action.type,
        projectId: action.projectId,
        projectName: targetProjectName,
        prompt: action.prompt,
      };
    case "send_to_chat":
      return {
        type: action.type,
        sessionId: action.sessionId,
        chatTitle: chat?.displayTitle ?? null,
        prompt: action.prompt,
      };
    case "move_to_project":
      return { type: action.type, projectId: action.projectId, projectName: targetProjectName };
    case "run_task":
      return {
        type: action.type,
        name: item.source.kind === "scheduled_task" ? item.source.label : null,
      };
  }
};

export const projectInboxMessage = (item: InboxItem): InboxMessage => ({
  pageId: item.pageId,
  pageKey: item.pageKey,
  title: item.title,
  body: item.body,
  bodyTruncated: item.bodyTruncated,
  submittedAt: item.submittedAt,
  source: { kind: item.source.kind, label: item.source.kind === "user" ? null : item.source.label },
  important: item.important,
  state: item.state,
  outcome: item.outcome,
  suggestion: { state: item.suggestionState, error: item.suggestionError },
  proposal: item.proposal
    ? {
        proposalId: item.proposal.proposalId,
        revision: item.proposal.revision,
        state: item.proposal.state,
        outdated: item.proposal.outdated,
        summary: item.proposal.summary,
        rationale: item.proposal.rationale,
        action: projectAction(item.proposal, item),
        failureMessage: item.proposal.failureMessage,
      }
    : null,
  chatSessionId: item.proposal?.chat?.sessionId ?? null,
  scope: item.scope,
  revision: item.revision,
});

const reject = (error: InboxApplicationError) => {
  const cause = Schema.is(CoreRuntimeError)(error.cause) ? error.cause.cause : error.cause;
  if (error.mayHaveCommitted)
    return unavailable("The change may already be saved. Retry to check it.");
  if (cause instanceof CoreModuleResponseError)
    return rpcError("rejected", cause.coreError.message, cause.coreError.retryable);
  if (error.operation === "request-suggestion" && error.cause === null)
    return rpcError("rejected", error.message);
  return unavailable("The Inbox is temporarily unavailable.");
};

/** A phone sees the mapped reason; anything unexpected also reaches the Host's log. */
const refused = <A, R>(task: Effect.Effect<A, InboxApplicationError, R>) =>
  task.pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`Mobile Inbox ${error.operation} failed: ${error.message}`),
    ),
    Effect.mapError(reject),
  );

const readFailure = (error: InboxApplicationError) => {
  const cause = Schema.is(CoreRuntimeError)(error.cause) ? error.cause.cause : error.cause;
  return cause instanceof CoreModuleResponseError && cause.coreError.code === "not_found"
    ? missing("This Inbox message is unavailable.")
    : reject(error);
};

export const inboxBody = (text: string, fileIds: readonly string[]) =>
  composeMessageText(text, fileIds.map(messageImageBlock));

export const mobileOperationId = (scope: string, id: string, issuedAt?: number): string | null => {
  if (isBoundedOperationId(id)) return id;
  if (!isUuidV7(id)) return null;
  const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  if (issuedAt !== undefined && (!Number.isSafeInteger(issuedAt) || issuedAt !== timestamp))
    return null;
  return encodeBoundedOperationId(scope, timestamp, id);
};

export const makeMobileInbox = Effect.fn("MobileInbox.make")(function* (
  files: Pick<Effect.Success<typeof makeMobileFiles>, "captureImages">,
) {
  const inbox = yield* InboxApplication;
  const authority = yield* CoreAuthority;
  const platform = yield* MobileProfileFiles;
  const lane = yield* Semaphore.make(1);
  const prepared = new Map<string, { fingerprint: string; input: InboxPreparedConfirmation }>();

  const submitPrepared = (prepared: InboxPreparedConfirmation) => {
    if (prepared.kind === "proposal") {
      const { kind: _kind, ...input } = prepared;
      return inbox.confirm(input);
    }
    const { kind: _kind, ...input } = prepared;
    return inbox.dispatch(input);
  };

  const capture: MobileHandlers["inbox.capture"] = (input) =>
    Effect.gen(function* () {
      const operationId = mobileOperationId(
        "mobile.inbox.capture",
        input.operationId,
        input.issuedAt,
      );
      if (!operationId) return yield* Effect.fail(invalid("The capture identity is invalid."));
      const ids = yield* files.captureImages(input.fileRefs);
      const scope =
        input.scope.kind === "library"
          ? { kind: "library" as const }
          : { kind: "project" as const, projectId: input.scope.projectId };
      const parsed = InboxSendInputSchema.safeParse({
        operationId,
        pageId: input.pageId,
        documentId: input.documentId,
        issuedAt: input.issuedAt,
        scope,
        storeEpoch: authority.identity.storeEpoch,
        body: inboxBody(input.text, ids),
      });
      if (!parsed.success)
        return yield* Effect.fail(invalid("The Inbox message is invalid or too long."));
      const result = yield* inbox.send(parsed.data).pipe(refused);
      if (result.value.state === "deleted")
        return yield* Effect.fail(missing("This Inbox message was deleted."));
      return { pageId: result.value.pageId };
    });

  const confirm = (input: Parameters<MobileHandlers["inbox.decide"]>[0], operationId: string) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const decision = input.decision;
        if (decision.type !== "accept" && decision.type !== "start_chat")
          return yield* Effect.fail(invalid("This decision cannot start a dispatch."));
        const fingerprint = platform.keyId(
          Buffer.from(
            JSON.stringify([
              input.pageId,
              decision.type === "accept"
                ? [decision.proposalId, decision.revision]
                : [
                    decision.projectId,
                    decision.prompt,
                    decision.agent?.providerInstanceId,
                    decision.agent?.model,
                  ],
            ]),
          ),
        );
        const saved = prepared.get(operationId);
        if (saved && saved.fingerprint !== fingerprint)
          return yield* Effect.fail(
            rpcError("conflict", "This decision identity has already been used."),
          );
        let frozen = saved?.input;
        if (!frozen) {
          const { item, storeEpoch } = yield* inbox
            .message(input.pageId)
            .pipe(Effect.mapError(readFailure));
          const sessionId = platform.stableId("mobile-inbox-session", operationId);
          if (decision.type === "accept") {
            const proposal = item.proposal;
            if (
              !proposal ||
              proposal.proposalId !== decision.proposalId ||
              proposal.revision !== decision.revision
            )
              return yield* Effect.fail(
                rpcError("rejected", "Review the current suggestion before accepting it."),
              );
            if (proposal.outdated)
              return yield* Effect.fail(
                rpcError(
                  "rejected",
                  "This message changed. Review the suggestion on your desktop.",
                ),
              );
            const draft = yield* inbox
              .prepareConfirmation({
                kind: "proposal",
                proposalId: proposal.proposalId,
                expectedRevision: decision.revision,
                storeEpoch,
                basis: proposal.basis,
              })
              .pipe(refused);
            frozen = { ...draft, operationId, sessionId };
          } else {
            const action = {
              ...inboxNewChatAction(decision.projectId, decision.prompt ?? item.body),
              agent: decision.agent ? mobileAgentChoice(decision.agent) : null,
            };
            const draft = yield* inbox
              .prepareConfirmation({
                kind: "direct",
                storeEpoch,
                pageIds: [item.pageId],
                basis: [item.basis],
                action,
              })
              .pipe(refused);
            if (draft.kind !== "direct")
              return yield* Effect.fail(unavailable("The decision could not be prepared."));
            frozen = {
              ...draft,
              operationId,
              sessionId,
              proposalId: platform.stableId("mobile-inbox-proposal", operationId),
            };
          }
          if (prepared.size >= 128) prepared.delete(prepared.keys().next().value!);
          prepared.set(operationId, { fingerprint, input: frozen });
        }
        const receipt = yield* submitPrepared(frozen).pipe(refused);
        const action = frozen.action;
        return {
          undoToken: receipt.value.undoToken,
          sessionId:
            action?.type === "new_chat"
              ? frozen.sessionId
              : action?.type === "send_to_chat"
                ? action.sessionId
                : null,
        };
      }),
    );

  const decide: MobileHandlers["inbox.decide"] = (input) =>
    Effect.gen(function* () {
      const { pageId, decision } = input;
      const operationId = mobileOperationId("mobile.inbox.decide", input.operationId);
      if (!operationId) return yield* Effect.fail(invalid("The decision identity is invalid."));
      const pageIds = [pageId];
      switch (decision.type) {
        case "accept":
        case "start_chat":
          return yield* confirm(input, operationId);
        case "keep":
          yield* inbox.keep({ pageIds }, operationId).pipe(refused);
          break;
        case "done":
        case "reopen":
          yield* inbox
            .setState({ pageIds, state: decision.type === "done" ? "done" : "open" }, operationId)
            .pipe(refused);
          break;
        case "delete":
          yield* inbox.delete({ pageIds }, operationId).pipe(refused);
          break;
        case "important":
          yield* inbox
            .setImportant({ pageId, important: decision.important }, operationId)
            .pipe(refused);
          break;
        case "retry":
          yield* inbox
            .retryDispatch({ proposalId: decision.proposalId }, operationId)
            .pipe(refused);
          break;
        case "request_suggestion": {
          const { item } = yield* inbox.message(pageId).pipe(Effect.mapError(readFailure));
          yield* inbox
            .requestSuggestion({
              requestId: input.operationId,
              mode: "auto",
              pageIds,
              basis: [item.basis],
            })
            .pipe(refused);
          break;
        }
      }
      return { undoToken: null, sessionId: null };
    });
  return {
    "inbox.window": ({ scope, filter, after, first }) =>
      inbox
        .window({
          scope:
            scope.kind === "library"
              ? { kind: "library" }
              : { kind: "project", projectId: scope.projectId },
          filter,
          after,
          first,
        })
        .pipe(
          Effect.mapError(reject),
          Effect.map((result) => ({
            items: result.items.map(projectInboxMessage),
            nextCursor: result.nextCursor,
          })),
        ),
    "inbox.message": ({ pageId }) =>
      inbox.message(pageId).pipe(
        Effect.mapError(readFailure),
        Effect.map(({ item }) => projectInboxMessage(item)),
      ),
    "inbox.capture": capture,
    "inbox.decide": decide,
    "inbox.undo": ({ operationId, undoToken }) => {
      const identity = mobileOperationId("mobile.inbox.undo", operationId);
      if (!identity) return Effect.fail(invalid("The undo identity is invalid."));
      return inbox
        .undo({ operationId: identity, undoToken })
        .pipe(Effect.mapError(reject), Effect.as({}));
    },
  } satisfies Pick<MobileHandlers, `inbox.${string}` & keyof MobileHandlers>;
});
