import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
import type { ConversationFirstSubmissionIdentity } from "../../shared/types";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { AgentBackendApplication } from "../agent-backend/AgentBackendApplication";
import { NativeConversationExtension } from "../app-tools/NativeConversationExtension";
import { CodexSessionThreadLaunch } from "../codex-application/CodexSessionThreadLaunch";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import {
  inboxDispatchActionFromCore,
  type CoreInboxDispatchWork,
} from "../core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication, InboxRuntimeError } from "./InboxApplication";
import { composeInboxDispatchPrompt, describeInboxRuntimeFailure } from "./inbox-suggestions";

const OUTBOX_BATCH = 8;
const SAFETY_POLL = "30 seconds";

/** Stable launch identities make a retried delivery reuse the same first submission. */
export const inboxDispatchIdentity = (
  work: Pick<CoreInboxDispatchWork, "proposal_id" | "attempt" | "confirmed_at">,
  purpose: string,
): string => {
  const bytes = createHash("sha256")
    .update(`${purpose}:${work.proposal_id}:${work.attempt}`)
    .digest();
  const issuedAt = Date.parse(work.confirmed_at);
  return createUuidV7FromTimestamp(
    Number.isFinite(issuedAt) ? issuedAt : 0,
    bytes.readUInt32BE(0),
    bytes,
  );
};

const firstSubmission = (work: CoreInboxDispatchWork): ConversationFirstSubmissionIdentity => ({
  launchId: inboxDispatchIdentity(work, "launch"),
  clientUserMessageId: inboxDispatchIdentity(work, "message"),
});

const failureMessage = (cause: unknown): string =>
  describeInboxRuntimeFailure(
    cause instanceof Error && cause.message.trim()
      ? cause.message
      : "The chat could not be started",
    "dispatch",
  );

/**
 * Delivers confirmed Inbox dispatches through the same Desktop Host launch and message
 * capabilities that ordinary chats use. Core's `dispatching` proposals are a durable outbox:
 * the runtime re-reads it on startup and whenever Inbox or chat state changes.
 */
export const live: Layer.Layer<
  never,
  never,
  | AgentBackendApplication
  | ApplicationSettings
  | CodexSessionThreadLaunch
  | CodexTurnCommands
  | DatabaseNotifierRuntime
  | InboxApplication
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbox = yield* InboxApplication;
    const settings = yield* ApplicationSettings;
    const launches = yield* CodexSessionThreadLaunch;
    const turns = yield* CodexTurnCommands;
    const agents = yield* AgentBackendApplication;
    const native = yield* Effect.serviceOption(NativeConversationExtension);
    const notifier = yield* DatabaseNotifierRuntime;
    const logger = getLogger({ component: "inbox-dispatch-runtime" });
    const lane = yield* Semaphore.make(1);

    const promptFor = Effect.fn("InboxDispatchRuntime.promptFor")(function* (
      work: CoreInboxDispatchWork,
      prompt: string,
    ) {
      const context = yield* inbox.dispatchContext(work.page_ids);
      return composeInboxDispatchPrompt({
        prompt,
        messages: context.entries.map((entry) => ({
          pageKey: entry.page_key ?? null,
          text: entry.body,
        })),
      });
    });

    const startChat = Effect.fn("InboxDispatchRuntime.startChat")(function* (
      work: CoreInboxDispatchWork,
      projectId: string | null,
      prompt: string,
      chatAgent: InboxSettings["chatAgent"],
    ) {
      const text = yield* promptFor(work, prompt);
      if (chatAgent.kind === "claude") {
        const started = yield* agents.startAgentThread({
          sessionId: work.session_id,
          instanceConfigId: chatAgent.instanceConfigId,
          backendKind: "claude",
          prompt: text,
          firstSubmission: firstSubmission(work),
        });
        return started.thread.threadId;
      }
      const projectlessWorkspace =
        projectId === null
          ? yield* Effect.tryPromise(() =>
              createCodexProjectlessWorkspace({ createSplitDirectories: true, prompt: text }),
            )
          : undefined;
      const launched = yield* launches.start(
        {
          sessionId: work.session_id,
          projectId,
          executionHostId: CODEX_APP_LOCAL_HOST_ID,
          prompt: text,
          firstSubmission: firstSubmission(work),
          runInTarget: "localProject",
          threadSource: "user",
          ...(projectlessWorkspace ? { projectlessWorkspace } : {}),
        },
        { browserViewScopeId: "nodex-inbox", ownerClientId: null },
      );
      return launched.kind === "started" ? launched.detail.threadId : null;
    });

    const sendToChat = Effect.fn("InboxDispatchRuntime.sendToChat")(function* (
      work: CoreInboxDispatchWork,
      threadId: string,
      prompt: string,
    ) {
      const text = yield* promptFor(work, prompt);
      const backend = work.thread_backend_kind ?? "codex";
      if (backend === "codex") {
        const turn = yield* turns.start(threadId, text, {
          clientUserMessageId: inboxDispatchIdentity(work, "message"),
        });
        return turn ? threadId : null;
      }
      if (Option.isNone(native)) {
        return yield* new InboxRuntimeError({ message: "This chat's runtime is unavailable" });
      }
      const state = yield* native.value.read(threadId);
      if (!state || state.archived) {
        return yield* new InboxRuntimeError({ message: "The target chat is unavailable" });
      }
      // A native runtime accepts one Turn at a time; deliver after the current one ends.
      if (state.busy) return "busy" as const;
      yield* native.value.submit({
        threadId,
        prompt: text,
        operationId: inboxDispatchIdentity(work, "message"),
      });
      return threadId;
    });

    const deliver = Effect.fn("InboxDispatchRuntime.deliver")(function* (
      work: CoreInboxDispatchWork,
      current: InboxSettings,
    ) {
      const action = inboxDispatchActionFromCore(work.action);
      if (action.type === "new_chat") {
        // A previous attempt may have launched before its completion was recorded.
        if (work.thread_id) return yield* inbox.completeDispatch(work.proposal_id, work.thread_id);
        const threadId = yield* startChat(work, action.projectId, action.prompt, current.chatAgent);
        yield* inbox.completeDispatch(work.proposal_id, threadId);
        return;
      }
      if (action.type !== "send_to_chat") {
        return yield* inbox.failDispatch(
          work.proposal_id,
          "This suggestion is not a chat dispatch",
        );
      }
      if (!work.thread_id) {
        return yield* inbox.failDispatch(work.proposal_id, "The target chat has no conversation");
      }
      // Waiting for idle is the queue: delivery resumes on the next chat state change.
      if (work.thread_status?.status_type === "active") return;
      const delivered = yield* sendToChat(work, work.thread_id, action.prompt);
      if (delivered === "busy") return;
      yield* inbox.completeDispatch(work.proposal_id, delivered);
    });

    const drain = lane.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* settings.snapshot()).inbox;
        const outbox = yield* inbox.outbox(OUTBOX_BATCH);
        for (const work of outbox) {
          yield* deliver(work, current).pipe(
            Effect.catchCause((cause) =>
              inbox
                .failDispatch(work.proposal_id, failureMessage(Cause.squash(cause)))
                .pipe(Effect.ignore),
            ),
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => logger.warn("Inbox dispatch pass failed", { cause })),
        ),
      ),
    );

    const triggers = Stream.mergeAll(
      [
        notifier.inboxInvalidations.pipe(Stream.map(() => undefined)),
        notifier.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced(SAFETY_POLL)).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    );
    yield* triggers.pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => drain),
      Effect.forkScoped,
    );
    yield* drain.pipe(Effect.forkScoped);
  }),
);
