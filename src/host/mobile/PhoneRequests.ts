import type { ChatRequest } from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Core projects answer entitlement; a Runtime snapshot alone supplies no Member authority. */
export interface PhoneRequestEntitlement {
  readonly filter: (
    sessionId: string,
    requests: readonly ChatRequest[],
  ) => Effect.Effect<ChatRequest[]>;
}

export const PhoneRequests = Context.Reference<PhoneRequestEntitlement>(
  "nodex/host/mobile/PhoneRequests",
  {
    defaultValue: () => ({ filter: () => Effect.succeed([]) }),
  },
);
