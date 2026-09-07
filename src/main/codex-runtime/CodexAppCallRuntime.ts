import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { createCodexAppCallAdmission, type CodexAppCallClaim } from "./codex-app-call-admission";

export class CodexAppCallRejected extends Schema.TaggedError<CodexAppCallRejected>()(
  "CodexAppCallRejected",
  { reason: Schema.Literals(["unverified", "revoked", "capacity"]) },
) {}

/** One instance belongs to one physical Endpoint generation's Scope. */
export const make = Effect.gen(function* () {
  const ledger = createCodexAppCallAdmission();
  const revision = yield* SubscriptionRef.make(0);
  let pending = 0;
  let closed = false;
  const change = (mutation: () => void) =>
    Effect.sync(mutation).pipe(Effect.andThen(SubscriptionRef.update(revision, (n) => n + 1)));
  yield* Effect.addFinalizer(() =>
    change(() => {
      closed = true;
      ledger.close();
    }),
  );

  const run = <A, E, R>(
    input: Parameters<typeof ledger.claim>[0],
    operation: (claim: CodexAppCallClaim) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CodexAppCallRejected, R> =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (closed) return Effect.fail(new CodexAppCallRejected({ reason: "revoked" }));
        if (pending >= 128) return Effect.fail(new CodexAppCallRejected({ reason: "capacity" }));
        pending += 1;
        return Effect.void;
      }),
      () =>
        Effect.gen(function* () {
          // SubscriptionRef supplies the current revision before updates, closing the arrival race.
          const candidate = yield* SubscriptionRef.changes(revision).pipe(
            Stream.mapEffect(() =>
              closed
                ? Effect.fail(new CodexAppCallRejected({ reason: "revoked" }))
                : Effect.sync(() => ledger.claim(input)),
            ),
            Stream.filter((claim): claim is CodexAppCallClaim => claim !== null),
            Stream.runHead,
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new CodexAppCallRejected({ reason: "unverified" })),
            }),
          );
          if (Option.isNone(candidate))
            return yield* new CodexAppCallRejected({ reason: "unverified" });
          const claim = candidate.value;
          const revoked = SubscriptionRef.changes(revision).pipe(
            Stream.filter(() => !claim.isActive()),
            Stream.runHead,
            Effect.andThen(Effect.fail(new CodexAppCallRejected({ reason: "revoked" }))),
          );
          return yield* Effect.raceFirst(operation(claim), revoked);
        }),
      () =>
        Effect.sync(() => {
          pending -= 1;
        }),
    );

  return {
    startTurn: (threadId: string, turnId: string) =>
      change(() => ledger.startTurn(threadId, turnId)),
    endTurn: (threadId: string, turnId: string) => change(() => ledger.endTurn(threadId, turnId)),
    observe: (event: ItemStartedNotification) =>
      change(() => {
        ledger.observe(event);
      }),
    run,
  };
});
