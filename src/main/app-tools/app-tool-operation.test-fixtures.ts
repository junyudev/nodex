import * as Effect from "effect/Effect";
import type { AppToolOperationIdentity, AppToolOperationRequest } from "../core-client/types";
import { CoreHttpError } from "../core-client/local-http";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";

/** A receipt owner for handler tests; Core tests cover transaction and restart durability. */
export const createAppToolAdmissionFixture = (acceptedAtMs = 1_000) => {
  const records = new Map<string, { identity: AppToolOperationIdentity; hash: string }>();
  const admitToolOperation = (request: AppToolOperationRequest) =>
    Effect.suspend(() => {
      if (!request.provenance) throw new Error("Test expects Agent provenance");
      const caller =
        request.provenance.authority.runtime?.session_id ??
        request.provenance.authority.root_thread_id;
      const key = JSON.stringify([caller, request.tool_name, request.idempotency_key]);
      const retained = records.get(key);
      if (retained && retained.hash !== request.request_hash)
        return Effect.fail(
          coreRuntimeError({
            operation: "workspace.admitToolOperation",
            reason: "request",
            retryable: false,
            cause: new CoreHttpError(
              409,
              "idempotencyKey is already bound to different arguments",
              undefined,
              {
                code: "idempotency_key_reused",
                message: "Different arguments",
                retryable: false,
                recovery: { kind: "use_new_idempotency_key" },
              },
            ),
          }),
        );
      if (retained) return Effect.succeed(retained.identity);
      const identity: AppToolOperationIdentity = {
        operation_id: createStableOperationId(`app.${request.tool_name}`, acceptedAtMs, key),
        accepted_at_ms: acceptedAtMs,
        expires_at_ms: acceptedAtMs + 7 * 24 * 60 * 60 * 1_000,
      };
      records.set(key, { identity, hash: request.request_hash });
      return Effect.succeed(identity);
    });
  return {
    admitToolOperation,
    records,
    core: { workspace: { admitToolOperation } } as CoreModules["Service"],
  };
};
