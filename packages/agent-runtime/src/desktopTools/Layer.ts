import { ExecutionHost } from "@nodex/provider-core/server/ExecutionHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HostBridge } from "../nodex/HostBridge.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { RuntimeApprovals } from "../orchestration-v2/RuntimeApprovals.ts";
import { DesktopTools, makeDesktopTools } from "./DesktopTools.ts";

const make = (home: string) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const events = yield* EventSinkV2;
    const bridge = Option.getOrUndefined(yield* Effect.serviceOption(HostBridge));
    const approvals = yield* RuntimeApprovals;
    const host = yield* ExecutionHost;
    const run = Effect.runPromise;
    const service = makeDesktopTools(home, {
      admit: ({ threadId, providerInstanceId }) =>
        run(
          Effect.gen(function* () {
            if (!bridge || (yield* projections.isExecutionPaused(threadId))) return undefined;
            const state = yield* projections.getHostToolAuthorityContext(threadId);
            const current = state.runs[0];
            if (
              !current?.activeAttemptId ||
              current.providerInstanceId !== providerInstanceId ||
              current.providerThreadId !== state.thread.activeProviderThreadId ||
              state.thread.archivedAt !== null ||
              state.thread.deletedAt !== null ||
              state.providerTurns.some(({ status }) => status !== "pending" && status !== "running")
            )
              return undefined;
            const identity = yield* bridge.preparedRun(threadId, current.id);
            const native = state.providerThreads.find(
              (thread) => thread.id === current.providerThreadId,
            );
            if (
              identity?.attemptId !== current.activeAttemptId ||
              !native ||
              native.providerSessionId !== identity.providerSessionId ||
              native.providerInstanceId !== providerInstanceId ||
              !(yield* bridge.nativeSessionLive(identity))
            )
              return undefined;
            // A fresh provider thread can gain its native id after prepareTurn.
            return {
              identity: { ...identity, nativeThreadRef: native.nativeThreadRef },
              runtimeMode: state.thread.runtimeMode,
            };
          }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      observe: (input) => run(host.observeNativeTurn?.(input) ?? Effect.void),
      ask: (input) => run(approvals.ask(input)),
      isAllowedForChat: (threadId) =>
        run(approvals.isAllowedForChat({ threadId, grant: "desktop-tools-javascript" })),
    });
    yield* Effect.addFinalizer(() => Effect.promise(service.close));
    const cursor = yield* events.latestSequence();
    for (const eventType of [
      "thread.archived",
      "thread.deleted",
      "run.updated",
      "run.execution-retired",
      "run-attempt.updated",
      "provider-turn.updated",
    ] as const) {
      yield* events.stream({ eventType, afterSequence: cursor, capturedCursor: true }).pipe(
        Stream.runForEach(({ event }) =>
          Effect.sync(() => {
            switch (event.type) {
              case "thread.archived":
              case "thread.deleted":
                void service.closeThread(event.threadId);
                break;
              case "run.updated":
                if (
                  ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                    event.payload.status,
                  )
                ) {
                  service.retire(
                    event.threadId,
                    (identity) => identity.runId === event.payload.id,
                    event.payload.status,
                  );
                }
                break;
              case "run.execution-retired":
                service.retire(
                  event.threadId,
                  (identity) =>
                    identity.runId === event.payload.runId &&
                    (event.payload.attemptId === null ||
                      identity.attemptId === event.payload.attemptId),
                  "superseded",
                );
                break;
              case "run-attempt.updated":
                service.retire(
                  event.threadId,
                  (identity) => identity.attemptId === event.payload.id,
                  event.payload.status,
                );
                break;
              case "provider-turn.updated": {
                const turn = event.payload;
                service.retire(
                  event.threadId,
                  (identity) =>
                    identity.attemptId === turn.runAttemptId &&
                    identity.providerThreadId === turn.providerThreadId,
                  turn.status,
                );
                break;
              }
            }
          }),
        ),
        Effect.catch(() => Effect.logError("Desktop Tool lifecycle subscription ended")),
        Effect.forkScoped,
      );
    }
    return service;
  });

export const layer = (home: string) => Layer.effect(DesktopTools, make(home));
