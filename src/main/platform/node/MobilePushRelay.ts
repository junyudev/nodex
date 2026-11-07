/* @effect-diagnostics asyncFunction:off -- fetch is the Node HTTP boundary. */
import { PUSH_RELAY_ORIGIN, type RelayPushRequest } from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Only status leaves this Adapter; transport errors never expose addresses or payloads. */
export const make = (origin = PUSH_RELAY_ORIGIN) => ({
  send: (request: RelayPushRequest) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${origin}/v1/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal,
          redirect: "error",
        });
        await response.body?.cancel();
        return response.status;
      },
      catch: () => "transport" as const,
    }),
});
export class MobilePushRelay extends Context.Service<MobilePushRelay, ReturnType<typeof make>>()(
  "nodex/main/platform/node/MobilePushRelay",
) {}
export const live = Layer.succeed(MobilePushRelay, make());
