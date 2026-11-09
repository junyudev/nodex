import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";

export class RemoteHostError extends Schema.TaggedError<RemoteHostError>()("RemoteHostError", {
  message: Schema.String,
}) {}

/**
 * One call to this Space's execution owner, relayed by its authenticated Core with this Member's
 * authority. The admitted owner returns the existing typed application contract.
 */
export const makeRemoteHostCall = Effect.gen(function* () {
  const access = yield* CoreSessionAccess;
  return <A>(operation: components["schemas"]["HostOperation"], input: unknown) =>
    access
      .use("host.call", (client, signal) => {
        if (!client.hostCall) throw new Error("This Core has no execution owner transport");
        return client.hostCall({ operation, input }, { signal, deadlineMs: 28_000 });
      })
      .pipe(
        Effect.flatMap((result) =>
          result.status === "ok"
            ? Effect.succeed(result.value as A)
            : Effect.fail(new RemoteHostError({ message: result.message })),
        ),
      );
});
