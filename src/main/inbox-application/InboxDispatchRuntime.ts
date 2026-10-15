import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { InboxSettings } from "../../shared/inbox";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import {
  inboxDispatchActionFromCore,
  type CoreInboxDispatchWork,
} from "../core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication, InboxRuntimeError } from "./InboxApplication";
import { resolveInboxModel } from "./InboxRuntimeSelection";
import { composeInboxDispatchPrompt, describeInboxRuntimeFailure } from "./inbox-suggestions";

const OUTBOX_BATCH = 8;
const SAFETY_POLL = "30 seconds";

/** Confirmed proposals retain these identities across reconnects and lost acknowledgements. */
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

/** One serialized outbox pass; the Runtime owns command receipts and execution state. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const settings = yield* ApplicationSettings;
  const runtime = yield* AgentRuntimeApplication;
  const workspace = yield* ProjectWorkspace;
  const remoteTurns = yield* Effect.serviceOption(CodexTurnCommands);
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

  const deliver = Effect.fn("InboxDispatchRuntime.deliver")(function* (
    work: CoreInboxDispatchWork,
    current: InboxSettings,
  ) {
    const action = inboxDispatchActionFromCore(work.action);
    if (action.type !== "new_chat" && action.type !== "send_to_chat")
      return yield* new InboxRuntimeError({ message: "This suggestion is not a chat dispatch" });
    const sessionId = action.type === "send_to_chat" ? action.sessionId : work.session_id;
    const session = yield* workspace.getProjectSession(sessionId);
    if (!session || session.archived)
      return yield* new InboxRuntimeError({ message: "The target chat is unavailable" });

    if (action.type === "new_chat") {
      if (session.thread && !session.executionRef)
        return yield* new InboxRuntimeError({
          message: "The chat has a different execution owner",
        });
      const existing = session.executionRef ? yield* runtime.inspect({ sessionId }) : null;
      const modelSelection = existing
        ? existing.thread.modelSelection
        : yield* resolveInboxModel(runtime, current.chatAgent);
      const text = yield* promptFor(work, action.prompt);
      // Confirmation can outlive Core's operation window. Durable launch/message IDs stay fixed;
      // a fresh issuance is safe because launch first reconciles the exact Session binding.
      const started = yield* runtime.launch({
        launchId: inboxDispatchIdentity(work, "launch"),
        acceptedAt: yield* Clock.currentTimeMillis,
        sessionId,
        projectId: existing?.projectId ?? session.projectId,
        title: existing?.thread.title ?? session.displayTitle,
        modelSelection,
        interactionMode: existing?.thread.interactionMode ?? "default",
        runInTarget: "localProject",
        message: { messageId: inboxDispatchIdentity(work, "message"), text },
      });
      // Binding proves product identity, not message delivery. Every replay crosses launch.
      return yield* inbox.completeDispatch(work.proposal_id, started.threadId);
    }

    if (session.executionRef) {
      const target = yield* runtime.inspect({ sessionId });
      if (target.thread.activeRunId !== null) return;
      const text = yield* promptFor(work, action.prompt);
      // The engine queues if another Run starts after the idle metadata read.
      yield* runtime.queueMessage({
        sessionId,
        message: { messageId: inboxDispatchIdentity(work, "message"), text },
      });
      return yield* inbox.completeDispatch(work.proposal_id, target.threadId);
    }

    // Only an explicitly remote Codex Session retains the remote peer's native writer.
    const thread = session.thread;
    if (
      !thread ||
      thread.archived ||
      thread.executionHostId === CODEX_APP_LOCAL_HOST_ID ||
      thread.backendBinding.kind !== "codex" ||
      Option.isNone(remoteTurns)
    )
      return yield* new InboxRuntimeError({ message: "This chat's runtime is unavailable" });
    if (thread.statusType === "active") return;
    const text = yield* promptFor(work, action.prompt);
    const turn = yield* remoteTurns.value.start(thread.threadId, text, {
      clientUserMessageId: inboxDispatchIdentity(work, "message"),
    });
    if (!turn) return;
    yield* inbox.completeDispatch(work.proposal_id, thread.threadId);
  });

  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      const current = (yield* settings.snapshot()).inbox;
      const outbox = yield* inbox.outbox(OUTBOX_BATCH);
      for (const work of outbox) {
        yield* deliver(work, current).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (Schema.is(InboxRuntimeError)(error))
              return inbox
                .failDispatch(
                  work.proposal_id,
                  describeInboxRuntimeFailure(error.message, "dispatch"),
                )
                .pipe(Effect.ignore);
            // A launch, message, or Core completion may already have committed. Keep the same
            // outbox attempt so the next pass reconciles its durable command receipts.
            return Effect.sync(() =>
              logger.warn("Inbox delivery awaits retry", { proposalId: work.proposal_id, cause }),
            );
          }),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => logger.warn("Inbox dispatch pass failed", { cause })),
      ),
    ),
  );
  return { drain };
});

/** Restarts and metadata invalidations resume the durable confirmed outbox. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { drain } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
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
