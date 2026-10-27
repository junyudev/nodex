import * as Schema from "effect/Schema";
import { CoreCodecError } from "../core-client/codec";
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  CoreEventCompatibilityError,
  CoreHttpError,
  isDefinitiveCoreGenerationLoss,
} from "../core-client/uds-http";

export const CoreRuntimeFailureReason = Schema.Literals([
  "launch",
  "health",
  "transport-loss",
  "stream-ended",
  "delivery",
  "resync",
  "authority-drift",
  "protocol",
  "request",
  "closed",
  "operation",
]);

export type CoreRuntimeFailureReason = typeof CoreRuntimeFailureReason.Type;

/** Policy classification with the exact cause retained for diagnostics. */
export class CoreRuntimeError extends Schema.TaggedError<CoreRuntimeError>()("CoreRuntimeError", {
  message: Schema.String,
  operation: Schema.String,
  reason: CoreRuntimeFailureReason,
  retryable: Schema.Boolean,
  generation: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const coreRuntimeError = (input: {
  readonly operation: string;
  readonly reason: CoreRuntimeFailureReason;
  readonly retryable: boolean;
  readonly generation?: string;
  readonly cause?: unknown;
  readonly message?: string;
}): CoreRuntimeError =>
  new CoreRuntimeError({
    message: input.message ?? `Native Core ${input.operation} failed`,
    operation: input.operation,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

export const isRecoverableCoreTransportFailure = (cause: unknown): boolean =>
  isDefinitiveCoreGenerationLoss(cause) ||
  (cause instanceof CoreHttpError &&
    cause.status === 503 &&
    (!cause.coreError || cause.coreError.code === "core_unavailable"));

export const classifyCoreOperationFailure = (
  operation: string,
  cause: unknown,
  generation?: string,
): CoreRuntimeError => {
  if (Schema.is(CoreRuntimeError)(cause)) return cause;
  if (
    (cause instanceof CoreModuleResponseError && cause.coreError.code === "invalid_input") ||
    (cause instanceof CoreHttpError &&
      (cause.coreError?.code === "invalid_input" ||
        (!cause.coreError && [400, 405, 413, 415, 422].includes(cause.status))))
  ) {
    return coreRuntimeError({
      operation,
      reason: "request",
      retryable: false,
      generation,
      cause,
      message: cause.message,
    });
  }
  if (cause instanceof CoreEventCompatibilityError || cause instanceof CoreCodecError) {
    return coreRuntimeError({ operation, reason: "protocol", retryable: false, generation, cause });
  }
  if (isRecoverableCoreTransportFailure(cause)) {
    return coreRuntimeError({
      operation,
      reason: "transport-loss",
      retryable: true,
      generation,
      cause,
    });
  }
  return coreRuntimeError({ operation, reason: "operation", retryable: false, generation, cause });
};
