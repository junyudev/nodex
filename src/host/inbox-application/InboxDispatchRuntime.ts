import { makeInboxSkills } from "./inbox-skills";
import { deliverChatLaunch } from "../work-application/chat-launch-delivery";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { NativeConversationDelivery } from "../NativeConversationDelivery";
import { CODEX_APP_LOCAL_HOST_ID } from "../../main/codex/codex-app-meta-thread-tools";
import {
  inboxDispatchActionFromCore,
  inboxExecutionSelectionFromCore,
  type CoreInboxDispatchWork,
} from "../../main/core-client/inbox-adapter";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../../main/logging/logger";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import { InboxApplication } from "./InboxApplication";
import { inboxPromptImages, makeInboxImageLoader } from "./inbox-images";

const OUTBOX_BATCH = 200;
const SAFETY_POLL = "30 seconds";
const ADMISSION_TIMEOUT = "30 seconds";

/** Historical dispatches predate frozen payloads; only look up their existing receipt. */
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

/** Runtime retains the first prepared message against the immutable confirmed intent. */
export const inboxDispatchFingerprint = (
  work: Pick<CoreInboxDispatchWork, "message_id" | "final_text" | "images" | "skill_invocations">,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "nodex-inbox-dispatch",
        1,
        work.message_id,
        work.final_text,
        work.images.map((image) => [image.file_id, image.content_hash]),
        ...(work.skill_invocations?.length
          ? [
              work.skill_invocations.map((skill) => [
                skill.name,
                skill.path,
                skill.instanceId,
                skill.cwd,
              ]),
            ]
          : []),
      ]),
    )
    .digest("hex");

/** Core owns confirmed intent; the Runtime is the sole owner of local queued execution. */
export const make = Effect.gen(function* () {
  const inbox = yield* InboxApplication;
  const runtime = yield* AgentRuntimeApplication;
  const workspace = yield* ProjectWorkspace;
  const skillInventory = yield* makeInboxSkills;
  const loadImages = yield* makeInboxImageLoader;
  const remoteTurns = yield* Effect.serviceOption(NativeConversationDelivery);
  const logger = getLogger({ component: "inbox-dispatch-runtime" });
  const lane = yield* Semaphore.make(1);

  const prepareMessage = Effect.fn("InboxDispatchRuntime.prepareMessage")(function* (
    work: CoreInboxDispatchWork,
    text: string,
  ) {
    const loaded = yield* loadImages(work.images);
    const attached = new Set(loaded.attachedMarkers);
    const unavailable = work.images
      .map((_, index) => index + 1)
      .filter((marker) => !attached.has(marker));
    if (unavailable.length > 0)
      logger.warn("Inbox handoff leaves images on their Pages", {
        proposalId: work.proposal_id,
        imageCount: work.images.length,
        attachedImageCount: loaded.images.length,
      });
    // Stable marker order and fixed wording keep the availability note deterministic on replay.
    const note = unavailable.map((marker) => `[Image #${marker}]`).join(", ");
    return {
      messageId: work.message_id,
      text: note ? `${text}\n\n${note} could not be attached.` : text,
      agentConfigs: [],
      ...(work.skill_invocations?.length ? { skillInvocations: work.skill_invocations } : {}),
      images: inboxPromptImages(loaded),
    };
  });

  const reconcile = Effect.fn("InboxDispatchRuntime.reconcile")(function* (
    work: CoreInboxDispatchWork,
  ) {
    if (work.question_response) {
      const receipt = yield* runtime.responseAdmission({
        sessionId: work.session_id,
        ...(work.target_execution_ref ? { threadId: work.target_execution_ref.thread_id } : {}),
        requestId: work.question_response.request_id,
        submissionId: work.message_id,
      });
      if (!receipt) return false;
      if (receipt.status === "accepted")
        yield* inbox.completeDispatch(
          work,
          work.target_execution_ref?.thread_id ?? work.thread_id ?? null,
        );
      else
        yield* inbox.failDispatch(
          work,
          receipt.error || "The question could not be answered",
          "rejected",
        );
      return true;
    }
    const receipt = yield* runtime.messageAdmission({
      sessionId: work.session_id,
      ...(work.action.type === "new_chat"
        ? {
            launchId:
              work.final_text == null ? inboxDispatchIdentity(work, "launch") : work.launch_id,
          }
        : {}),
      messageId: work.final_text == null ? inboxDispatchIdentity(work, "message") : work.message_id,
      ...(work.target_execution_ref
        ? {
            expectedExecutionRef: {
              runtimeId: work.target_execution_ref.runtime_id,
              threadId: work.target_execution_ref.thread_id,
            },
          }
        : {}),
    });
    if (!receipt) return false;
    if (receipt.status === "accepted") yield* inbox.completeDispatch(work, receipt.threadId);
    else
      yield* inbox.failDispatch(
        work,
        receipt.error || "The chat rejected this message",
        "rejected",
      );
    return true;
  });

  const deliver = Effect.fn("InboxDispatchRuntime.deliver")(function* (
    work: CoreInboxDispatchWork,
  ) {
    if (yield* inbox.executionHeld({ pageIds: work.page_ids, sessionId: work.session_id })) return;
    const action = inboxDispatchActionFromCore(work.action);
    if (action.type !== "new_chat" && action.type !== "send_to_chat")
      return yield* inbox.failDispatch(
        work,
        "This decision does not send a chat message",
        "rejected",
      );
    if (work.question_response) {
      if (yield* reconcile(work)) return;
      const response = work.question_response;
      yield* runtime.respond({
        sessionId: work.session_id,
        ...(work.target_execution_ref ? { threadId: work.target_execution_ref.thread_id } : {}),
        requestId: response.request_id,
        runId: response.run_id ?? null,
        submissionId: work.message_id,
        responseFingerprint: inboxDispatchFingerprint(work),
        requirePending: true,
        answers: { [response.question_id]: response.answer },
      });
      return yield* inbox.completeDispatch(
        work,
        work.target_execution_ref?.thread_id ?? work.thread_id ?? null,
      );
    }
    // A recorded acceptance wins over later archive, model changes or an execution failure.
    if (yield* reconcile(work)) return;
    if (!work.final_text)
      return yield* inbox.failDispatch(
        work,
        "Review this decision before sending again; its confirmed text is unavailable",
        "unknown",
      );
    const session = yield* workspace.getProjectSession(work.session_id);
    if (!session || session.archived)
      return yield* inbox.failDispatch(work, "The target chat is unavailable", "unavailable");
    // The execution owner says where this host runs the chat, as for every launch; a refusal shows
    // on the Inbox message before anything is submitted.
    if (action.type === "new_chat" || session.executionRef) {
      const location = yield* runtime.executionWorkspace(
        session.projectId,
        action.type === "new_chat" ? "new" : "existing",
      );
      if (!location.available)
        return yield* inbox.failDispatch(work, location.reason, "unavailable");
    }
    const frozenSkills = work.skill_invocations ?? [];
    const currentSkills = yield* skillInventory.resolve(
      action,
      work.execution_selection?.model_selection.instanceId,
      frozenSkills.map(({ name }) => name),
    );
    const skills = frozenSkills.filter((skill) =>
      currentSkills.some(
        (candidate) =>
          candidate.name === skill.name &&
          candidate.path === skill.path &&
          candidate.cwd === skill.cwd &&
          candidate.instanceId === skill.instanceId,
      ),
    );
    const unavailableSkills = frozenSkills
      .filter((skill) => !skills.includes(skill))
      .map(({ name }) => name);
    const message = yield* prepareMessage({ ...work, skill_invocations: skills }, work.final_text);
    if (action.type === "new_chat") {
      if (session.projectId !== action.projectId)
        return yield* inbox.failDispatch(
          work,
          "The chat moved to another Project; review this decision",
          "rejected",
        );
      if (!work.execution_selection)
        return yield* inbox.failDispatch(
          work,
          "Review the Agent selection before sending",
          "rejected",
        );
      if (session.thread && !session.executionRef)
        return yield* inbox.failDispatch(
          work,
          "The chat has a different execution owner",
          "rejected",
        );
      const selection = inboxExecutionSelectionFromCore(work.execution_selection);
      const threadId = yield* deliverChatLaunch(runtime, {
        launchId: work.launch_id,
        messageFingerprint: inboxDispatchFingerprint(work),
        acceptedAt: Date.parse(work.confirmed_at),
        sessionId: work.session_id,
        projectId: action.projectId,
        title: session.displayTitle,
        modelSelection: selection.modelSelection,
        interactionMode: selection.interactionMode,
        workPage: work.page_ids[0] ? { pageId: work.page_ids[0] } : undefined,
        message,
      });
      return yield* inbox.completeDispatch(work, threadId, unavailableSkills);
    }
    if (session.executionRef) {
      if (
        work.target_execution_ref &&
        (session.executionRef.runtimeId !== work.target_execution_ref.runtime_id ||
          session.executionRef.threadId !== work.target_execution_ref.thread_id)
      )
        return yield* inbox.failDispatch(
          work,
          "The chat's execution owner changed; review this decision",
          "rejected",
        );
      yield* runtime.sendMessage({
        sessionId: work.session_id,
        threadId: session.executionRef.threadId,
        mode: "queue",
        messageFingerprint: inboxDispatchFingerprint(work),
        message,
      });
      return yield* inbox.completeDispatch(work, session.executionRef.threadId, unavailableSkills);
    }
    const thread = session.thread;
    if (
      !thread ||
      thread.archived ||
      thread.executionHostId === CODEX_APP_LOCAL_HOST_ID ||
      thread.backendBinding.kind !== "codex" ||
      Option.isNone(remoteTurns)
    )
      return yield* inbox.failDispatch(work, "This chat's runtime is unavailable", "unavailable");
    if (work.thread_id !== thread.threadId)
      return yield* inbox.failDispatch(
        work,
        "The remote chat target changed; review this decision",
        "rejected",
      );
    if (thread.statusType === "active")
      return yield* inbox.failDispatch(
        work,
        "The remote chat is busy; retry when it is idle",
        "unavailable",
      );
    // Persist uncertainty before the external call. Restart must never repeat a possibly sent native request.
    yield* inbox.beginDispatch(work);
    const startedWork = { ...work, revision: work.revision + 1 };
    const result = yield* remoteTurns.value
      .start(thread.threadId, message.text, {
        clientUserMessageId: work.message_id,
        promptInput: { text: message.text, agentConfigs: [], images: message.images },
      })
      .pipe(Effect.result);
    if (result._tag === "Failure" || !result.success) return;
    yield* inbox.failDispatch(
      startedWork,
      "Submitted to remote chat; open it to verify",
      "unknown",
    );
  });

  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      const outbox = yield* inbox.outbox(OUTBOX_BATCH);
      for (const work of outbox) {
        yield* deliver(work).pipe(
          Effect.catchTag("AgentRuntimeApplicationError", (error) =>
            error.admissionRejected
              ? reconcile(work).pipe(
                  Effect.flatMap((settled) =>
                    settled ? Effect.void : inbox.failDispatch(work, error.message, "rejected"),
                  ),
                )
              : work.question_response && error.questionReason
                ? inbox.failDispatch(work, error.message, "rejected")
                : Effect.fail(error),
          ),
          Effect.timeout(ADMISSION_TIMEOUT),
          Effect.catchCause(() =>
            // A timeout or lost reply is not a rejection. A later pass asks the durable receipt first.
            reconcile(work).pipe(
              Effect.timeout(ADMISSION_TIMEOUT),
              Effect.catchCause(() => Effect.succeed(false)),
              Effect.tap((settled) =>
                settled
                  ? Effect.void
                  : Effect.sync(() =>
                      logger.warn("Inbox handoff awaits reconciliation", {
                        proposalId: work.proposal_id,
                        messageId: work.message_id,
                      }),
                    ),
              ),
              Effect.asVoid,
            ),
          ),
        );
      }
    }).pipe(Effect.catchCause(() => Effect.sync(() => logger.warn("Inbox handoff pass failed")))),
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
