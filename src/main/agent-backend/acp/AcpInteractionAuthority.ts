import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AcpRuntimeError } from "./AcpRuntimeError";

/** Product policy owner for ACP interactions that require a human or authorization decision. */
export class AcpInteractionAuthority extends Context.Service<
  AcpInteractionAuthority,
  {
    readonly requestPermission: (
      request: RequestPermissionRequest,
    ) => Effect.Effect<RequestPermissionResponse, AcpRuntimeError>;
    readonly createElicitation: (
      request: CreateElicitationRequest,
    ) => Effect.Effect<CreateElicitationResponse, AcpRuntimeError>;
    readonly completeElicitation: (
      notification: CompleteElicitationNotification,
    ) => Effect.Effect<void, AcpRuntimeError>;
  }
>()("nodex/main/agent-backend/acp/AcpInteractionAuthority") {}

/** The safe default advertises no elicitation capability and rejects every permission request. */
export const denyAll: Layer.Layer<AcpInteractionAuthority> = Layer.succeed(
  AcpInteractionAuthority,
  AcpInteractionAuthority.of({
    requestPermission: () => Effect.succeed({ outcome: { outcome: "cancelled" } }),
    createElicitation: () => Effect.succeed({ action: "cancel" }),
    completeElicitation: () => Effect.void,
  }),
);
