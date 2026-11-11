import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { OPERATION_IDENTITY_WINDOW_MS } from "../../shared/operation-identity";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreHttpError } from "../core-client/local-http";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  return Effect.fn("AppToolOperation.admit")(function* (
    input: AppToolInvocation,
    authority: NodexAgentTurnContext,
    profileId: string,
    args: Record<string, unknown>,
  ) {
    const { idempotencyKey, ...argumentsWithoutKey } = args;
    if (typeof idempotencyKey !== "string")
      return {
        success: true as const,
        operationId: createStableOperationId(`app.${input.name}`, authority.admittedAtMs, [
          profileId,
          input.caller.threadId,
          input.caller.turnId,
          input.caller.callId,
        ]),
        acceptedAtMs: authority.admittedAtMs,
        expiresAtMs: authority.admittedAtMs + OPERATION_IDENTITY_WINDOW_MS,
      };
    const admitted = yield* core.workspace
      .admitToolOperation({
        provenance: toCoreAgentTurnProvenance(profileId, authority),
        tool_name: input.name,
        idempotency_key: idempotencyKey,
        request_hash: createHash("sha256")
          .update(stableStringifyBlockPropertyJson(JSON.parse(JSON.stringify(argumentsWithoutKey))))
          .digest("hex"),
      })
      .pipe(
        Effect.map((identity) => ({
          success: true as const,
          operationId: identity.operation_id,
          acceptedAtMs: identity.accepted_at_ms,
          expiresAtMs: identity.expires_at_ms,
        })),
        Effect.catch((error) => {
          const coreError =
            error.cause instanceof CoreHttpError ? error.cause.coreError : undefined;
          return Effect.succeed({
            success: false as const,
            result: coreError
              ? toolFailure(coreError.code, coreError.message, {
                  retryable: coreError.retryable,
                  recovery: coreError.recovery,
                })
              : toolFailure(
                  "operation_admission_failed",
                  "The host could not admit this call. Retry with the same idempotencyKey and identical arguments.",
                ),
          });
        }),
      );
    return admitted;
  });
});
