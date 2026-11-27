import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { components } from "@nodex/core-protocol";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { getMainIntl as getIntl } from "../main/i18n/main-intl";
import type { LibraryReadSnapshot } from "../main/core-client/types";
import { CoreModuleResponseError } from "../main/core-client/core-client";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { CoreRequestClass } from "../main/core-runtime/CoreRequestClass";
import { DatabaseNotifierRuntime } from "../main/host-runtime/DatabaseNotifierRuntime";
import { selectPageTextRewriteModel } from "../main/page-text-rewrite/rewrite-model";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import type { AgentRuntimeMessage } from "../shared/agent-runtime-api";
import { PAGE_REFERENCE_CONTEXT_KIND, pageReferencePayload } from "../shared/page-reference";
import {
  PAGE_ASK_MESSAGE_PREFIX,
  pageAskAgentConfig,
  pageAskProviderInstanceId,
  type PageAskAgent,
} from "../shared/page-ask";
import { createUuidV7 } from "../shared/uuid-v7";
import { pageAskContext, pageAskMessages, pageAskTitle } from "./page-ask-message";
import { pageAskConversationTitle } from "../shared/page-ask";

type Schemas = components["schemas"];
type QueuedAsk = Schemas["QueuedAsk"];
type AskCommand = Schemas["DiscussionCommand"];
type Cursor = Schemas["QueuedAskCursor"];

function coreRefusal(error: { readonly cause?: unknown }, code: string) {
  return error.cause instanceof CoreModuleResponseError && error.cause.coreError.code === code;
}

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const apply = Effect.fn("PageAskDispatcher.apply")(function* (command: AskCommand) {
    const result = yield* core.library.apply({
      operationId: createUuidV7(),
      intent: { kind: "discussion", command },
    });
    const receipt = result.outcome.discussion;
    return receipt?.kind === "comment" ? receipt.value : undefined;
  });
  const reserve = Effect.fn("PageAskDispatcher.reserve")(function* (
    comment: Schemas["DiscussionComment"],
  ) {
    const explicit = comment.ask?.agent;
    const inherited =
      explicit?.providerInstanceId && explicit.model
        ? null
        : selectPageTextRewriteModel(yield* runtime.catalog(), (yield* settings.snapshot()).inbox);
    const providerInstanceId = explicit?.providerInstanceId || inherited?.instanceId;
    const model = explicit?.model || inherited?.model;
    const options = explicit?.options;
    const agent: PageAskAgent | null =
      providerInstanceId && model
        ? {
            providerInstanceId,
            model,
            options: {
              ...Object.fromEntries((inherited?.options ?? []).map(({ id, value }) => [id, value])),
              ...(options && typeof options === "object" ? options : {}),
            },
          }
        : null;
    return yield* apply({
      kind: "reserve_ask",
      commentId: comment.id,
      messageId: `${PAGE_ASK_MESSAGE_PREFIX}${createUuidV7()}`,
      newSessionId: createUuidV7(),
      agent,
    });
  });

  const advance = Effect.fn("PageAskDispatcher.advance")(function* (item: QueuedAsk) {
    const comment =
      item.comment.ask?.state === "queued" ? yield* reserve(item.comment) : item.comment;
    const ask = comment?.ask;
    if (!comment || !ask?.sessionId || !ask.dispatch) return;
    const { sessionId, dispatch } = ask;
    const { messageId } = dispatch;
    const delivery = {
      sessionId,
      messageId,
      ...(dispatch.launchId && { launchId: dispatch.launchId }),
    };
    const settle = (state: "failed" | "stopped", runId: string | null, hasChat: boolean) =>
      Effect.gen(function* () {
        const intl = getIntl();
        const body = intl.formatMessage(
          state === "stopped" ? pageAskMessages.stopped : pageAskMessages.failed,
        );
        const link = intl.formatMessage(pageAskMessages.conversation);
        yield* apply({
          kind: "settle_ask",
          commentId: comment.id,
          messageId,
          runId,
          state,
          fallback: hasChat ? `${body} [${link}](<nodex://sessions/${sessionId}>)` : body,
        });
      });

    const refuse = (reason: string, hasChat: boolean) =>
      Effect.logWarning("Page Ask could not start").pipe(
        Effect.annotateLogs({ commentId: comment.id, reason }),
        Effect.andThen(settle("failed", null, hasChat)),
      );
    const receipt = yield* runtime.messageAdmission(delivery);
    if (dispatch.stopRequested) {
      if (receipt?.status === "accepted") yield* runtime.stopHostInput(delivery);
      const [turn] =
        receipt?.status === "accepted"
          ? yield* runtime.promptTurns({ sessionId, messageIds: [messageId] })
          : [];
      yield* settle(
        "stopped",
        turn?.runId ?? ask.runId ?? null,
        receipt?.status === "accepted" || !dispatch.launchId,
      );
      return;
    }
    if (receipt?.status === "rejected") {
      yield* refuse("delivery_refused", !dispatch.launchId);
      return;
    }
    if (receipt?.status === "accepted") {
      const [turn] = yield* runtime.promptTurns({ sessionId, messageIds: [messageId] });
      if (!turn?.runId) return;
      if (turn.phase === "done" || turn.phase === "failed" || turn.phase === "interrupted") {
        yield* settle(turn.phase === "interrupted" ? "stopped" : "failed", turn.runId, true);
        return;
      }
      const waiting = turn.phase === "waiting";
      if (ask.runId !== turn.runId || (ask.state === "needs_you") !== waiting)
        yield* apply({
          kind: "observe_ask",
          commentId: comment.id,
          messageId,
          runId: turn.runId,
          waiting,
        });
      return;
    }

    const agent = dispatch.agent;
    if (!agent) {
      yield* refuse("agent_unavailable", !dispatch.launchId);
      return;
    }
    const snapshot = yield* core.library.read({
      kind: "discussion_ask_context",
      comment_id: comment.id,
    });
    if (snapshot.value.kind !== "discussion_ask_context") return;
    const context = snapshot.value.value;
    const current = context.detail.comments.find((entry) => entry.id === comment.id);
    if (current?.ask?.dispatch?.messageId !== messageId || current.ask.dispatch.stopRequested)
      return;
    if (!context.canDispatch || (ask.kind === "in_place" && !context.pendingBlockId)) {
      yield* refuse(
        context.canDispatch ? "pending_block_missing" : "authority_unavailable",
        !dispatch.launchId,
      );
      return;
    }
    const intl = getIntl();
    const title = intl.formatMessage(pageAskTitle, {
      title:
        context.title
          .replace(/[«»\r\n]+/gu, " ")
          .trim()
          .slice(0, 160) || intl.formatMessage(pageAskMessages.untitled),
    });
    const config = ask.agent ? pageAskAgentConfig(ask.agent) : null;
    const modelSelection = {
      instanceId: pageAskProviderInstanceId(agent.providerInstanceId),
      model: agent.model,
      options: Object.entries(agent.options ?? {}).flatMap(([id, value]) => {
        if (config && (id === "mode" || id === "reasoning" || id === "speed")) return [];
        return typeof value === "string" || typeof value === "boolean" ? [{ id, value }] : [];
      }),
    };
    const anchor = context.detail.anchor;
    const reference = pageReferencePayload({
      pageId: item.pageId,
      titleSnapshot: context.title,
      selectedBlockIds:
        anchor.kind === "page"
          ? []
          : anchor.kind === "blocks"
            ? anchor.blockIds.slice(0, 20)
            : [anchor.blockId],
    });
    const message: AgentRuntimeMessage = {
      messageId,
      text: `${title}\n\n${comment.body}`,
      modelSelection,
      agentConfigs: config ? [config] : [],
      context: {
        version: 1,
        records: [
          { kind: PAGE_REFERENCE_CONTEXT_KIND, label: title.slice(0, 180), payload: reference },
          {
            kind: "nodex-page-ask",
            label: title.slice(0, 180),
            payload: pageAskContext(context, comment),
          },
        ],
      },
    };
    const acceptedAt = Number.isFinite(Date.parse(item.queuedAt))
      ? Date.parse(item.queuedAt)
      : yield* Clock.currentTimeMillis;
    const messageFingerprint = createHash("sha256").update(messageId).digest("hex");
    // The Page reference belongs to the message. Launch grants no Page work.
    const sent = yield* (
      dispatch.launchId
        ? runtime
            .launch({
              launchId: dispatch.launchId,
              acceptedAt,
              sessionId,
              projectId: context.projectId ?? null,
              // A conversation serves one Discussion; its request names it in the sidebar.
              title: pageAskConversationTitle(comment.body, title),
              modelSelection,
              interactionMode: "default",
              messageOrigin: "host",
              messageFingerprint,
              message,
            })
            .pipe(Effect.asVoid)
        : runtime
            .sendMessage({
              sessionId,
              origin: "host",
              mode: "queue",
              messageFingerprint,
              message,
            })
            .pipe(Effect.asVoid)
    ).pipe(Effect.result);
    if (sent._tag === "Failure" && sent.failure.admissionRejected)
      yield* refuse(sent.failure.operation, !dispatch.launchId);
  });

  return Effect.gen(function* () {
    let cursor: Cursor | null = null;
    let hasWork = false;
    do {
      const snapshot: LibraryReadSnapshot = yield* core.library.read({
        kind: "queued_discussion_asks",
        cursor,
        limit: 32,
      });
      if (snapshot.value.kind !== "queued_discussion_asks") return false;
      for (const item of snapshot.value.value.items) {
        hasWork = true;
        yield* advance(item).pipe(
          Effect.catch((error) =>
            coreRefusal(error, "revision_conflict") || coreRefusal(error, "not_found")
              ? Effect.void
              : Effect.logWarning("Page Ask could not advance").pipe(
                  Effect.annotateLogs({ commentId: item.comment.id }),
                ),
          ),
        );
      }
      cursor = snapshot.value.value.next ?? null;
    } while (cursor);
    return hasWork;
  }).pipe(Effect.provideService(CoreRequestClass, "background"));
});

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const scan = yield* make;
    const { discussionAskInvalidations } = yield* DatabaseNotifierRuntime;
    const wake = yield* Queue.sliding<void>(1);
    yield* discussionAskInvalidations.pipe(
      Stream.runForEach(() => Queue.offer(wake, undefined)),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      while (true) {
        const active = yield* scan.pipe(
          Effect.catch(() =>
            Effect.logWarning("Page Ask queue is unavailable").pipe(Effect.as(false)),
          ),
        );
        yield* Queue.take(wake).pipe(Effect.timeoutOption(active ? "2 seconds" : "1 minute"));
      }
    }).pipe(Effect.forkScoped);
  }),
);
