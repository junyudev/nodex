import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { components } from "@nodex/core-protocol";
import { CoreClient } from "../main/core-client/core-client";
import { MainConfig } from "../main/app/MainConfig";
import { MainShutdown } from "../main/app/MainShutdown";
import { executeHostCommand } from "./HostCommands";
import { MemberMessageRefusal } from "./MemberMessages";
import { startPhoneRelay } from "./mobile/PhoneRelay";
import type { HeadlessHost } from "./HeadlessApplicationLive";

/** Core admits Members and carries bounded work over private local IPC to its execution owner. */
export const startHostRelay = Effect.fn("HostRelay.start")(function* (input: {
  readonly coreHome: string;
  readonly instance: string;
  readonly host: HeadlessHost["Service"];
  readonly onFailure?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}) {
  const shutdown = yield* MainShutdown;
  const config = yield* MainConfig;
  const client = yield* Effect.tryPromise((signal) =>
    CoreClient.connect({
      nodexHome: input.coreHome,
      clientKind: "electron_host",
      buildId: "nodex-host-relay",
      signal,
    }),
  );
  const lease = yield* Effect.tryPromise((signal) =>
    client.registerHost({ instance: input.instance }, { signal }),
  );
  const onFailure =
    input.onFailure ??
    ((cause: Cause.Cause<unknown>) =>
      shutdown
        .request({ _tag: "RuntimeFatal", subsystem: "host-relay", cause })
        .pipe(Effect.asVoid));
  yield* startPhoneRelay({
    client,
    lease,
    rpc: input.host.phone,
    onFailure,
    hostMetadata: { platform: config.platform, appVersion: config.appVersion },
  });
  const loop = Effect.gen(function* () {
    const invocation = yield* Effect.tryPromise((signal) => client.pollHost(lease, { signal }));
    if (!invocation) return;
    const result: components["schemas"]["HostCallResult"] = yield* Effect.suspend(() =>
      executeHostCommand(input.host, invocation),
    ).pipe(
      Effect.map((value) => ({ status: "ok" as const, value: value ?? null })),
      Effect.catchCause((cause) =>
        Effect.logWarning("Host request failed").pipe(
          Effect.annotateLogs({ operation: invocation.call.operation, cause: Cause.pretty(cause) }),
          Effect.as({
            status: "error" as const,
            // A refusal the person can act on keeps its sentence; anything else stays in this log.
            message: Option.match(Cause.findErrorOption(cause), {
              onNone: () => "The Host could not complete this request",
              onSome: (error) =>
                error instanceof MemberMessageRefusal
                  ? error.message
                  : "The Host could not complete this request",
            }),
          }),
        ),
      ),
    );
    // An expired or canceled call is harmless. Poll failure retires this relay generation.
    yield* Effect.tryPromise((signal) =>
      client.completeHost({ ...lease, id: invocation.id, result }, { signal }),
    ).pipe(Effect.catch(() => Effect.void));
  }).pipe(Effect.forever);
  yield* Effect.forEach([0, 1, 2, 3], () => loop, { concurrency: 4, discard: true }).pipe(
    Effect.catchCause(onFailure),
    Effect.forkScoped,
  );
});
