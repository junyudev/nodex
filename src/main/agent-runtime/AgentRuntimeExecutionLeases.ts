import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import type { AgentRuntimeAuthorityIdentity } from "./AgentRuntimeAuthority";

type AdmissionWindow =
  components["schemas"]["CollectionWindow_ProjectWorkspaceAgentRuntimeAdmission"];
type Admission = AdmissionWindow["items"][number];
interface NativeSource {
  readonly providerSessionId: string;
  readonly nativeGeneration: number;
}
interface AdmissionAuthority {
  readonly revoke: (identity: AgentRuntimeAuthorityIdentity) => Effect.Effect<void, unknown>;
  readonly revokeNativeSource: (source: NativeSource) => Effect.Effect<void, unknown>;
  readonly readAdmissions: (after?: string) => Effect.Effect<AdmissionWindow, unknown>;
}
const isRevokedRun = (status: string) =>
  status === "cancelled" || status === "interrupted" || status === "rolled_back";

/** Core owns the admission roster. Normal operation retains no completed Run history in Main. */
export const make = Effect.fn("AgentRuntimeExecutionLeases.make")(function* (
  connection: AgentRuntimeProcessConnection,
  authority: AdmissionAuthority,
  failClosed: Effect.Effect<void>,
  presentation?: Pick<
    CodexTurnPresentation["Service"],
    "finishRuntimeSource" | "finishRuntimeLease" | "finish"
  >,
) {
  const deliveries = yield* connection.subscribeExecutionNotifications;
  const subscription = yield* connection.request("execution.observe", {
    afterSequence: connection.identity.lastSequence,
  });
  yield* Effect.addFinalizer(() =>
    connection
      .request("events.unobserve", { subscriptionId: subscription.subscriptionId })
      .pipe(Effect.ignore),
  );
  const verify = Effect.fn("AgentRuntimeExecutionLeases.verify")(function* (
    identity: AgentRuntimeAuthorityIdentity,
    source: NativeSource,
  ) {
    const proof =
      "run_id" in identity
        ? yield* connection.request("thread.authority", {
            threadId: identity.thread_id,
            runId: identity.run_id,
          })
        : yield* connection.request("native-session.authority", {
            threadId: identity.thread_id,
            providerSessionId: identity.provider_session_id,
            nativeGeneration: identity.native_generation,
            incarnationId: identity.incarnation_id,
          });
    if (
      proof &&
      proof.runtimeId === connection.identity.runtimeId &&
      proof.runtimeGeneration === connection.identity.runtimeGeneration &&
      proof.providerSessionId === source.providerSessionId &&
      proof.nativeGeneration === source.nativeGeneration &&
      (proof.status === null || !isRevokedRun(proof.status))
    )
      return;
    yield* authority.revoke(identity);
    if ("run_id" in identity) presentation?.finish(identity.thread_id, identity.run_id);
  });
  const repair = Effect.fn("AgentRuntimeExecutionLeases.repair")(function* () {
    let after: string | undefined;
    do {
      const page = yield* authority.readAdmissions(after);
      yield* Effect.forEach(
        page.items,
        (admission: Admission) => {
          const source = admission.kind === "run" ? admission.native_source : admission.identity;
          return verify(admission.identity, {
            providerSessionId: source.provider_session_id,
            nativeGeneration: source.native_generation,
          });
        },
        { concurrency: 2, discard: true },
      );
      after = page.next_cursor ?? undefined;
    } while (after);
  });
  let lastDelivery: number | null = null;
  yield* deliveries.pipe(
    Stream.runForEach((delivery) =>
      Effect.gen(function* () {
        if (lastDelivery !== null && delivery.delivery !== lastDelivery + 1) yield* repair();
        lastDelivery = delivery.delivery;
        const notification = delivery.notification;
        if (notification.type === "execution.native-session.closed") {
          if (
            notification.runtimeId !== connection.identity.runtimeId ||
            notification.runtimeGeneration !== connection.identity.runtimeGeneration
          )
            return;
          yield* authority.revokeNativeSource(notification);
          presentation?.finishRuntimeSource({
            runtimeId: connection.identity.runtimeId,
            runtimeGeneration: connection.identity.runtimeGeneration,
            providerSessionId: notification.providerSessionId,
            nativeGeneration: notification.nativeGeneration,
          });
          return;
        }
        if (
          notification.type === "event.error" &&
          notification.subscriptionId === subscription.subscriptionId
        )
          return yield* Effect.fail(new Error("Execution lifecycle stream failed"));
        if (
          notification.type !== "execution.lifecycle" ||
          notification.subscriptionId !== subscription.subscriptionId ||
          notification.runtimeGeneration !== connection.identity.runtimeGeneration
        )
          return;
        // Session deletion has already revoked its admissions atomically in Core.
        if (notification.eventType === "thread.deleted") return;
        if (!notification.runId || !notification.runStatus || !isRevokedRun(notification.runStatus))
          return;
        yield* authority.revoke({
          runtime_id: connection.identity.runtimeId,
          lease_id: connection.identity.runtimeGeneration,
          thread_id: notification.threadId,
          run_id: notification.runId,
        });
        presentation?.finish(notification.threadId, notification.runId);
      }),
    ),
    Effect.catchCause(() =>
      Effect.sync(() =>
        presentation?.finishRuntimeLease(
          connection.identity.runtimeId,
          connection.identity.runtimeGeneration,
        ),
      ).pipe(Effect.andThen(failClosed)),
    ),
    Effect.forkScoped,
  );
  return {
    // Cancellation or native close may race admission while Main awaits Core.
    track: (identity: AgentRuntimeAuthorityIdentity, source: NativeSource) =>
      verify(identity, source),
  };
});
