import { effectiveHolds } from "./execution-holds";
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { components } from "@nodex/core-protocol";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { deliverChatLaunch } from "./chat-launch-delivery";

type Launch = components["schemas"]["PageWorkLaunch"];
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const logger = getLogger({ component: "work-dispatch" });
  const lane = yield* Semaphore.make(1);
  const settle = Effect.fn("WorkDispatchRuntime.settle")(function* (
    launch: Launch,
    rejection: string | null,
  ) {
    yield* core.workspace.apply(
      {
        operationId: createOperationId("work.settle"),
        intent: {
          kind: "settle_page_work_launch",
          launch_id: launch.launch_id,
          accepted_at: rejection ? null : DateTime.formatIso(yield* DateTime.now),
          rejection,
        },
      },
      undefined,
      null,
    );
  });
  const reconcile = Effect.fn("WorkDispatchRuntime.reconcile")(function* (launch: Launch) {
    const receipt = yield* runtime.messageAdmission({
      sessionId: launch.session_id,
      launchId: launch.launch_id,
      messageId: launch.message_id,
    });
    if (!receipt) return false;
    yield* settle(
      launch,
      receipt.status === "accepted" ? null : receipt.error || "The chat rejected this launch",
    );
    return true;
  });
  const deliver = Effect.fn("WorkDispatchRuntime.deliver")(function* (launch: Launch) {
    if (yield* reconcile(launch)) return;
    if ((yield* effectiveHolds(core, { kind: "page", page_id: launch.page_id })).length) return;
    const session = yield* core.workspace.read(
      { kind: "session", session_id: launch.session_id },
      undefined,
      null,
    );
    if (
      session.value.kind !== "session" ||
      !session.value.session ||
      session.value.session.archived ||
      session.value.session.project_id !== launch.project_id
    ) {
      yield* settle(launch, "The work chat is unavailable or moved to another Project");
      return;
    }
    let target: components["schemas"]["Automation"] | null = null;
    if (launch.automation_decision_id) {
      const authority = yield* core.workspace.read(
        {
          kind: "automation_assessments",
          read: { kind: "launch_authority", decision_id: launch.automation_decision_id },
        },
        undefined,
        null,
      );
      if (
        authority.value.kind !== "automation_assessments" ||
        authority.value.value.kind !== "launch_authority" ||
        !authority.value.value.valid
      ) {
        yield* settle(launch, "The Automation's standing grant changed before work could start");
        return;
      }
      target = authority.value.value.target ?? null;
    }
    const modelSelection = yield* resolveInboxModel(runtime, {
      ...launch.selection,
      reasoningEffort: launch.selection.effort,
      serviceTier: target?.service_tier ?? null,
    });
    yield* deliverChatLaunch(runtime, {
      launchId: launch.launch_id,
      sessionId: launch.session_id,
      projectId: launch.project_id,
      acceptedAt: DateTime.toEpochMillis(DateTime.makeUnsafe(launch.created_at)),
      title: session.value.session.display_title,
      modelSelection,
      interactionMode: "default",
      ...(target
        ? {
            sourceRoot: target.cwds[0],
            runInTarget:
              target.execution_environment === "worktree"
                ? ("newWorktree" as const)
                : ("localProject" as const),
            runInEnvironmentPath: target.local_environment_config_path,
          }
        : {}),
      workPage: { pageId: launch.page_id },
      messageOrigin: "host",
      messageFingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            "page-work",
            launch.launch_id,
            launch.message_id,
            launch.brief,
            launch.selection,
          ]),
        )
        .digest("hex"),
      message: { messageId: launch.message_id, text: launch.brief, agentConfigs: [] },
    });
    yield* reconcile(launch);
  });
  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      const outbox = yield* core.workspace.read(
        { kind: "page_work_outbox", limit: 100 },
        undefined,
        null,
      );
      if (outbox.value.kind !== "page_work_outbox") return;
      for (const launch of outbox.value.launches)
        yield* deliver(launch).pipe(
          Effect.catchTag("AgentRuntimeApplicationError", (error) =>
            error.admissionRejected
              ? reconcile(launch).pipe(
                  Effect.flatMap((settled) =>
                    settled ? Effect.void : settle(launch, error.message),
                  ),
                )
              : Effect.fail(error),
          ),
          Effect.timeout("30 seconds"),
          Effect.catchCause(() =>
            reconcile(launch).pipe(
              Effect.timeout("30 seconds"),
              Effect.catchCause(() => Effect.succeed(false)),
              Effect.tap((settled) =>
                settled
                  ? Effect.void
                  : Effect.sync(() =>
                      logger.warn("Work launch awaits admission reconciliation", {
                        launchId: launch.launch_id,
                      }),
                    ),
              ),
              Effect.asVoid,
            ),
          ),
        );
    }).pipe(Effect.catchCause(() => Effect.sync(() => logger.warn("Work delivery pass failed")))),
  );
  return { drain };
});
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { drain } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => drain),
      Effect.forkScoped,
    );
    yield* drain.pipe(Effect.forkScoped);
  }),
);
