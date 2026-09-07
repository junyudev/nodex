import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { toolFailure } from "./app-tool-result";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { CodexAppCallClaim } from "../codex-runtime/codex-app-call-admission";

export class AppToolInvocationUnavailable extends Schema.TaggedError<AppToolInvocationUnavailable>()(
  "AppToolInvocationUnavailable",
  { reason: Schema.Literals(["closed", "capacity", "withdrawn"]) },
) {}

export interface AppToolInvocation {
  readonly caller: CodexAppCallClaim & { readonly hostId: string; readonly generation: number };
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface Ticket {
  readonly invocation: AppToolInvocation;
  readonly result: Deferred.Deferred<CallToolResult>;
  readonly withdrawn: Deferred.Deferred<void>;
  active: boolean;
  interpreted: boolean;
}

export class AppToolInvocationInbox extends Context.Service<
  AppToolInvocationInbox,
  {
    readonly invoke: (
      input: AppToolInvocation,
    ) => Effect.Effect<CallToolResult, AppToolInvocationUnavailable>;
    readonly invocations: Stream.Stream<Ticket>;
    readonly interpret: (
      ticket: Ticket,
      operation: (input: AppToolInvocation) => Effect.Effect<CallToolResult>,
    ) => Effect.Effect<void>;
  }
>()("nodex/main/app-tools/AppToolInvocationInbox") {}

/** Lossless application ingress. Caller cancellation also interrupts the semantic interpreter. */
export const make = Effect.gen(function* () {
  const queue = yield* Queue.bounded<Ticket>(128);
  const closed = yield* Deferred.make<void>();
  let pending = 0;
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      open = false;
      yield* Deferred.succeed(closed, undefined);
      yield* Queue.shutdown(queue);
    }),
  );

  const invoke = Effect.fn("AppToolInvocationInbox.invoke")(function* (
    invocation: AppToolInvocation,
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (!open) return yield* new AppToolInvocationUnavailable({ reason: "closed" });
        if (!invocation.caller.isActive())
          return yield* new AppToolInvocationUnavailable({ reason: "withdrawn" });
        if (pending >= 128) return yield* new AppToolInvocationUnavailable({ reason: "capacity" });
        pending += 1;
        const ticket: Ticket = {
          invocation,
          result: yield* Deferred.make<CallToolResult>(),
          withdrawn: yield* Deferred.make<void>(),
          active: true,
          interpreted: false,
        };
        return ticket;
      }),
      (ticket) =>
        Queue.offer(queue, ticket).pipe(
          Effect.andThen(
            Effect.raceFirst(
              Deferred.await(ticket.result),
              Deferred.await(closed).pipe(
                Effect.andThen(new AppToolInvocationUnavailable({ reason: "closed" })),
              ),
            ),
          ),
        ),
      (ticket) =>
        Effect.gen(function* () {
          pending -= 1;
          ticket.active = false;
          yield* Deferred.succeed(ticket.withdrawn, undefined);
        }),
    );
  });

  const interpret = Effect.fn("AppToolInvocationInbox.interpret")(function* (
    ticket: Ticket,
    operation: (input: AppToolInvocation) => Effect.Effect<CallToolResult>,
  ) {
    if (!open || !ticket.active || ticket.interpreted || !ticket.invocation.caller.isActive())
      return;
    ticket.interpreted = true;
    yield* Effect.raceFirst(
      Effect.suspend(() => operation(ticket.invocation)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(
                toolFailure(
                  "tool_execution_failed",
                  "The tool stopped unexpectedly. Inspect current state before retrying a write.",
                ),
              ),
        ),
        Effect.flatMap((result) => Deferred.succeed(ticket.result, result)),
      ),
      Effect.raceFirst(Deferred.await(ticket.withdrawn), Deferred.await(closed)),
    );
  });
  return AppToolInvocationInbox.of({ invoke, invocations: Stream.fromQueue(queue), interpret });
});
