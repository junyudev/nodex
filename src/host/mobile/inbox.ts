import { inboxActionSkills } from "../../shared/inbox";
import type { AgentChoice, InboxEntry, InboxProposalAction } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { composeMessageText, messageImageBlock } from "../../shared/message-content";
import { encodeBoundedOperationId, isBoundedOperationId } from "../../shared/operation-identity";
import { isUuidV7 } from "../../shared/uuid-v7";
import {
  inboxDispatchRetryable,
  inboxNewChatAction,
  type InboxAgentChoice,
  type InboxItem,
  type InboxPreparedConfirmation,
  type InboxProposal,
} from "../../shared/inbox";
import { InboxSendInputSchema } from "../../shared/schemas/inbox";
import { CoreAuthority } from "../../main/core-runtime/CoreAuthority";
import { CoreModuleResponseError } from "../../main/core-client/core-client";
import { CoreRuntimeError } from "../../main/core-runtime/CoreRuntimeError";
import {
  InboxApplication,
  type InboxApplicationError,
} from "../inbox-application/InboxApplication";
import { WorkApplication } from "../work-application/WorkApplication";
import { PhoneFiles } from "../../main/platform/node/PhoneFiles";
import {
  capabilityUnavailable,
  invalid,
  missing,
  rpcError,
  unavailable,
  type MobileHandlers,
} from "./rpc";
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
    case "later":
      return { type: "later", remindAt: action.remindAt };
    case "keep":
      return { type: "keep" };
    case "save_to_notes":
      return { type: "save_to_notes", parentPageId: action.parentPageId };
    case "new_chat":
      return {
        type: action.type,
        projectId: action.projectId,
        projectName: targetProjectName,
        prompt: action.prompt,
        additions: [...action.additions],
        skills: [...(action.skills ?? [])],
        agent: action.agent?.model
          ? { providerInstanceId: action.agent.instanceId, model: action.agent.model }
          : null,
      };
    case "send_to_chat":
      return {
        type: action.type,
        sessionId: action.sessionId,
        chatTitle: chat?.displayTitle ?? null,
        prompt: action.prompt,
        additions: [...action.additions],
        skills: [...(action.skills ?? [])],
      };
    case "move_to_project":
      return { type: action.type, projectId: action.projectId, projectName: targetProjectName };
    case "plan":
      return {
        type: "plan",
        summary: action.summary,
        steps: action.steps.map(({ key, title, body, projectId, blockedBy }) => ({
          key,
          title,
          body,
          projectId,
          blockedBy: [...blockedBy],
        })),
      };
    case "execute_decision":
      return {
        type: action.type,
        decisionId: action.decisionId,
        name: item.source.kind === "automation" ? item.source.label : null,
      };
  }
};

/** Connected native chats retain their desktop execution owner. */
export const projectTurnReplyCapability = (
  chat: NonNullable<InboxItem["turn"]>["active_chat"],
): Extract<InboxEntry, { rowKind: "turn" }>["turn"]["replyCapability"] =>
  chat?.thread_id && !chat.execution_ref
    ? { kind: "unavailable", reason: "Continue this chat on its desktop." }
    : { kind: "available" };

export const projectInboxEntry = (item: InboxItem): InboxEntry => {
  const source = {
    ...item.source,
    label:
      item.source.kind === "user"
        ? null
        : item.source.kind === "nodex"
          ? "Nodex"
          : item.source.kind === "github"
            ? item.source.repository
            : item.source.label,
  };
  const base = {
    id: item.pageId,
    pageId: item.pageId,
    pageKey: item.pageKey,
    title: item.title,
    body: item.body,
    bodyTruncated: item.bodyTruncated,
    submittedAt: item.submittedAt,
    source,
    scope: item.scope,
    revision: item.revision,
  };
  if (item.rowKind === "problem") {
    const problem = item.problem;
    if (!problem) throw new Error("Problem row is missing its Problem");
    return {
      ...base,
      id: problem.id,
      pageId: problem.page_id ?? null,
      rowKind: "problem",
      problem: {
        id: problem.id,
        fix: problem.fix,
        sourceId: problem.source_id ?? null,
        capability:
          problem.fix === "retry"
            ? { kind: "available" }
            : {
                kind: "unavailable",
                reason:
                  problem.fix === "reconnect"
                    ? "Reconnect this Source in desktop Settings."
                    : "Open this Page on your desktop.",
              },
      },
    };
  }
  if (item.rowKind === "turn") {
    if (!item.turn) throw new Error("Turn row is missing its episode");
    const turn = item.turn;
    return {
      ...base,
      rowKind: "turn",
      later: item.later ? { ...item.later } : null,
      turn: {
        episode: turn.turn.episode,
        reason: turn.turn.reason ?? null,
        since: turn.turn.since,
        options: [...turn.options],
        replyCapability: projectTurnReplyCapability(turn.active_chat),
        chatSessionId: turn.active_chat?.session_id ?? null,
        pullRequestUrl: turn.pull_request_url ?? null,
        deliveryError: turn.delivery_error ?? null,
      },
    };
  }
  if (item.rowKind === "answer")
    return {
      ...base,
      rowKind: "answer",
      chatSessionId: item.source.kind === "nodex" ? item.source.subjectSessionId : null,
    };
  return {
    ...base,
    rowKind: "intake",
    later: item.later ? { ...item.later } : null,
    important: item.important,
    waiting: item.waiting,
    kind: item.kind ?? item.proposal?.kind ?? null,
    status: item.pageStatus?.id ?? null,
    suggestion: { state: item.suggestionState, error: item.suggestionError },
    proposal: item.proposal
      ? {
          proposalId: item.proposal.proposalId,
          revision: item.proposal.revision,
          state: item.proposal.state,
          outdated: item.proposal.outdated,
          summary: item.proposal.summary,
          rationale: item.proposal.rationale,
          origin: item.proposal.origin,
          producedBy: item.proposal.producedBy,
          action: projectAction(item.proposal, item),
          failureMessage: item.proposal.failureMessage,
          failureKind: item.proposal.failureKind,
          retryable: item.proposal.state === "failed" && inboxDispatchRetryable(item.proposal),
        }
      : null,
    chatSessionId: item.proposal?.chat?.sessionId ?? null,
  };
};

const reject = (error: InboxApplicationError) => {
  const cause = Schema.is(CoreRuntimeError)(error.cause) ? error.cause.cause : error.cause;
  if (error.mayHaveCommitted)
    return unavailable("The change may already be saved. Retry to check it.");
  if (cause instanceof CoreModuleResponseError) {
    const code =
      cause.coreError.recovery.kind === "inbox_remind_at_passed"
        ? "inbox_remind_at_passed"
        : "rejected";
    return rpcError(code, cause.coreError.message, cause.coreError.retryable);
  }
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

/** Of the Pages a phone asks about, the ones whose Turn is still its Member's. */
export const memberTurns =
  (inbox: Pick<InboxApplication["Service"], "entry">): MobileHandlers["inbox.turns"] =>
  ({ pageIds }) =>
    Effect.forEach(
      [...new Set(pageIds)],
      // Core shows a Page's Turn only to the Member whose move it is, and only while it is current.
      (pageId) =>
        inbox.entry(pageId).pipe(Effect.map((item) => (item?.rowKind === "turn" ? [pageId] : []))),
      { concurrency: 4 },
    ).pipe(
      Effect.map((turns) => ({ pageIds: turns.flat() })),
      Effect.mapError(reject),
    );

export const makeMobileInbox = Effect.fn("MobileInbox.make")(function* (
  files: Pick<Effect.Success<typeof makeMobileFiles>, "captureImages">,
) {
  const inbox = yield* InboxApplication;
  const authority = yield* CoreAuthority;
  const work = yield* WorkApplication;
  const platform = yield* PhoneFiles;
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
        input.scope.kind !== "project"
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
        const fingerprint = platform.contentFingerprint(
          Buffer.from(
            JSON.stringify([
              input.entryId,
              decision.type === "accept"
                ? [
                    decision.proposalId,
                    decision.revision,
                    decision.keptSkillNames?.toSorted(),
                    decision.remindAt,
                  ]
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
            .message(input.entryId)
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
            if (decision.remindAt && proposal.action.type !== "later")
              return yield* Effect.fail(invalid("Only a Later suggestion has a return time."));
            const proposedSkills = inboxActionSkills(proposal.action);
            const kept = decision.keptSkillNames;
            if (
              (proposedSkills.length && !kept) ||
              kept?.some((name) => !proposedSkills.some((skill) => skill.name === name))
            )
              return yield* Effect.fail(
                rpcError("rejected", "Review the suggested skills before accepting."),
              );
            const draft = yield* inbox
              .prepareConfirmation({
                kind: "proposal",
                proposalId: proposal.proposalId,
                expectedRevision: decision.revision,
                storeEpoch,
                basis: proposal.basis,
                ...(decision.remindAt
                  ? { action: { type: "later", remindAt: decision.remindAt } }
                  : {}),
                ...(kept
                  ? {
                      droppedSkillNames: proposedSkills
                        .filter(({ name }) => !kept.includes(name))
                        .map(({ name }) => name),
                    }
                  : {}),
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
      const { entryId: pageId, decision } = input;
      const operationId = mobileOperationId("mobile.inbox.decide", input.operationId);
      if (!operationId) return yield* Effect.fail(invalid("The decision identity is invalid."));
      // Core remains the authority for episode admission and receipt replay. Intake commands
      // cannot be used to dismiss a Turn or to treat a Problem id as a Page id.
      if (decision.type === "turn_accept") {
        yield* work
          .acceptWork({ operationId, pageId, turnEpisode: decision.episode })
          .pipe(
            Effect.mapError(() => rpcError("rejected", "This Turn changed. Refresh the Inbox.")),
          );
        return { undoToken: null, sessionId: null };
      }
      if (decision.type === "turn_start") {
        const result = yield* work
          .startWork({ operationId, pageId, turnEpisode: decision.episode })
          .pipe(
            Effect.mapError(() =>
              rpcError("rejected", "This Turn cannot start. Refresh the Inbox."),
            ),
          );
        return { undoToken: null, sessionId: result.value.sessionId };
      }
      if (decision.type === "turn_reply") {
        const row = yield* inbox.entry(pageId).pipe(Effect.mapError(readFailure));
        const capability = row?.turn ? projectTurnReplyCapability(row.turn.active_chat) : null;
        if (capability?.kind === "unavailable")
          return yield* Effect.fail(capabilityUnavailable(capability.reason));
        yield* inbox
          .send({
            operationId,
            pageId: platform.stableId("mobile-turn-reply", operationId),
            documentId: platform.stableId("mobile-turn-document", operationId),
            issuedAt: Date.now(),
            storeEpoch: authority.identity.storeEpoch,
            scope: { kind: "library" },
            body: decision.text,
            replyToPageId: pageId,
            turnEpisode: decision.episode,
          })
          .pipe(refused);
        return { undoToken: null, sessionId: null };
      }
      const row = yield* inbox.entry(pageId).pipe(Effect.mapError(readFailure));
      if (decision.type === "problem_fix") {
        if (
          row?.rowKind !== "problem" ||
          row.problem?.id !== decision.problemId ||
          row.problem.fix !== decision.fix
        )
          return yield* Effect.fail(
            rpcError("conflict", "This Problem changed. Refresh the Inbox."),
          );
        if (decision.fix !== "retry")
          return yield* Effect.fail(rpcError("rejected", "This fix needs your desktop."));
        yield* inbox.retryProblem({ operationId, problemId: decision.problemId }).pipe(refused);
        return { undoToken: null, sessionId: null };
      }
      const later = decision.type === "later" || decision.type === "clear_later";
      if (
        row?.rowKind !== "intake" &&
        !(row?.rowKind === "turn" && later) &&
        !(row === null && decision.type === "delete")
      )
        return yield* Effect.fail(
          rpcError("rejected", "This decision is only available for intake."),
        );
      const pageIds = [pageId];
      switch (decision.type) {
        case "accept":
        case "start_chat":
          return yield* confirm(input, operationId);
        case "later":
          yield* inbox.setLater({ pageIds, until: decision.until }, operationId).pipe(refused);
          break;
        case "clear_later":
          yield* inbox.clearLater({ pageIds }, operationId).pipe(refused);
          break;
        case "save_to_notes": {
          if (!row) return yield* Effect.fail(missing("The message is unavailable."));
          const result = yield* inbox
            .dispatch({
              storeEpoch: authority.identity.storeEpoch,
              operationId,
              proposalId: platform.stableId("mobile-notes-proposal", operationId),
              sessionId: platform.stableId("mobile-notes-session", operationId),
              pageIds,
              basis: [row.basis],
              action: { type: "save_to_notes", parentPageId: null },
            })
            .pipe(refused);
          return { undoToken: result.value.undoToken, sessionId: null };
        }
        case "keep": {
          const result = yield* inbox.keep({ pageIds }, operationId).pipe(refused);
          return { undoToken: result.value.undoToken, sessionId: null };
        }
        case "done": {
          const result = yield* inbox.markDone({ pageIds }, operationId).pipe(refused);
          return { undoToken: result.value.undoToken, sessionId: null };
        }
        case "return":
          yield* inbox.returnMessages({ pageIds }, operationId).pipe(refused);
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
      Effect.all([inbox.window({ scope, filter, after, first }), inbox.summary({ scope })], {
        concurrency: 2,
      }).pipe(
        Effect.mapError(reject),
        Effect.map(([result, summary]) => ({
          items: result.items.map(projectInboxEntry),
          nextCursor: result.nextCursor,
          laterCount: summary.laterCount,
        })),
      ),
    "inbox.message": ({ entryId: pageId }) =>
      inbox.message(pageId).pipe(
        Effect.mapError(readFailure),
        Effect.map(({ item }) => projectInboxEntry(item)),
      ),
    "inbox.turns": memberTurns(inbox),
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
