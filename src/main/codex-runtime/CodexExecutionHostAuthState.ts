import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class CodexExecutionHostAuthState extends Context.Service<
  CodexExecutionHostAuthState,
  {
    readonly isLoginRequired: (hostId: string) => Effect.Effect<boolean>;
    readonly changes: Stream.Stream<ReadonlySet<string>>;
    readonly markLoginRequired: (hostId: string) => Effect.Effect<void>;
    readonly clearLoginRequired: (hostId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-runtime/CodexExecutionHostAuthState") {}

export const live: Layer.Layer<CodexExecutionHostAuthState> = Layer.effect(
  CodexExecutionHostAuthState,
  Effect.gen(function* () {
    const loginRequiredHosts = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set());

    const setLoginRequired = Effect.fn("CodexExecutionHostAuthState.setLoginRequired")(function* (
      hostId: string,
      required: boolean,
    ) {
      const normalizedHostId = hostId.trim();
      if (!normalizedHostId) return;
      yield* SubscriptionRef.update(loginRequiredHosts, (current) => {
        const alreadyRequired = current.has(normalizedHostId);
        if (alreadyRequired === required) return current;
        const next = new Set(current);
        if (required) next.add(normalizedHostId);
        else next.delete(normalizedHostId);
        return next;
      });
    });

    return CodexExecutionHostAuthState.of({
      isLoginRequired: (hostId) =>
        SubscriptionRef.get(loginRequiredHosts).pipe(
          Effect.map((current) => current.has(hostId.trim())),
        ),
      changes: SubscriptionRef.changes(loginRequiredHosts).pipe(Stream.changes),
      markLoginRequired: (hostId) => setLoginRequired(hostId, true),
      clearLoginRequired: (hostId) => setLoginRequired(hostId, false),
    });
  }),
);
