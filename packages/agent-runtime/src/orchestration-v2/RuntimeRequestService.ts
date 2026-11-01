import {
  EventId,
  TurnItemId,
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as EventSink from "./EventSink.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class RuntimeRequestResponseExecutionError extends Schema.TaggedError<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    reason: Schema.Literals([
      "request-missing",
      "request-not-ready",
      "request-not-resumable",
      "provider-session-not-active",
      "unexpected-failure",
    ]),
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "request-missing":
        return `Runtime request ${this.requestId} no longer exists on thread ${this.threadId}.`;
      case "request-not-ready":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not ready for response execution.`;
      case "request-not-resumable":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not resumable on provider session ${this.providerSessionId}.`;
      case "provider-session-not-active":
        return `Provider session ${this.providerSessionId} is not active for runtime request ${this.requestId} on thread ${this.threadId}.`;
      case "unexpected-failure":
        return `Failed to respond to runtime request ${this.requestId} on thread ${this.threadId} via provider session ${this.providerSessionId}.`;
    }
  }
}

const isRuntimeRequestResponseExecutionError = Schema.is(RuntimeRequestResponseExecutionError);

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly optionId?: string;
    readonly feedback?: string;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<void, RuntimeRequestResponseExecutionError>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | EventSink.EventSinkV2
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const eventSink = yield* EventSink.EventSinkV2;

    return RuntimeRequestServiceV2.of({
      respond: (input) =>
        Effect.gen(function* () {
          const request = yield* projections.getRuntimeRequest(input.threadId, input.requestId);
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-missing",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          // Dispatch validates the request while it is pending, then persists the
          // resolved projection before this effect is executed.
          if (request.status !== "resolved") {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-ready",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (
            (request.kind !== "user_input" && !Schema.is(ProviderRequestKind)(request.kind)) ||
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-resumable",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (
            (Schema.is(ProviderRequestKind)(request.kind) && input.decision === undefined) ||
            (input.feedback !== undefined &&
              (request.kind === "user_input" ||
                input.decision !== "decline" ||
                request.responseCapability.supportsFeedback !== true ||
                input.feedback.trim().length === 0))
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-ready",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          yield* session.value
            .respondToRuntimeRequest({
              requestId: input.requestId,
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
              ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimeRequestResponseExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerSessionId: input.providerSessionId,
                    requestId: input.requestId,
                    retryable: request.kind === "user_input",
                    cause,
                  }),
              ),
              Effect.onError(() =>
                Effect.gen(function* () {
                  if (!Schema.is(ProviderRequestKind)(request.kind)) return;
                  const context = yield* projections.getRuntimeResponseContext(
                    input.threadId,
                    input.requestId,
                  );
                  if (context.item === undefined) return;
                  const now = yield* DateTime.now;
                  yield* eventSink.write({
                    events: [
                      {
                        id: EventId.make(`runtime-request-delivery-failed:${input.requestId}`),
                        type: "turn-item.updated",
                        threadId: input.threadId,
                        nodeId: request.nodeId,
                        occurredAt: now,
                        payload: {
                          threadId: input.threadId,
                          runId: context.item.runId,
                          nodeId: request.nodeId,
                          providerThreadId: context.item.providerThreadId ?? null,
                          providerTurnId: context.item.providerTurnId ?? null,
                          nativeItemRef: null,
                          parentItemId: null,
                          ordinal: context.item.ordinal,
                          startedAt: now,
                          id: TurnItemId.make(`runtime-request-delivery-failed:${input.requestId}`),
                          type: "error",
                          title: "Approval response not delivered",
                          status: "failed",
                          completedAt: now,
                          updatedAt: now,
                          failure: makeProviderFailure({
                            message:
                              "Your approval response was recorded, but could not be delivered to the provider.",
                            code: "approval_response_delivery_failed",
                          }),
                        },
                      },
                    ],
                  });
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to record approval delivery failure", {
                      requestId: input.requestId,
                      cause,
                    }),
                  ),
                ),
              ),
            );
        }).pipe(
          Effect.mapError((cause) =>
            isRuntimeRequestResponseExecutionError(cause)
              ? cause
              : new RuntimeRequestResponseExecutionError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  requestId: input.requestId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
