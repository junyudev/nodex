import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class CodexExecutionHostAuthState extends Context.Service<
  CodexExecutionHostAuthState,
  {
    readonly isLoginRequired: (hostId: string) => Effect.Effect<boolean>;
    readonly changes: Stream.Stream<ReadonlySet<string>>;
    readonly markLoginRequired: (hostId: string) => Effect.Effect<void>;
    readonly clearLoginRequired: (hostId: string) => Effect.Effect<void>;
    readonly backendLease: (hostId: string) => Effect.Effect<AbortSignal>;
    readonly withAccountMutation: <A, E, R>(
      hostId: string,
      method: string,
      request: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("nodex/main/codex-runtime/CodexExecutionHostAuthState") {}

export const live: Layer.Layer<CodexExecutionHostAuthState> = Layer.effect(
  CodexExecutionHostAuthState,
  Effect.gen(function* () {
    const loginRequiredHosts = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set());
    const backendHosts = yield* SubscriptionRef.make<
      ReadonlyMap<
        string,
        {
          readonly pending: number;
          readonly controller: AbortController;
        }
      >
    >(new Map());
    const changeBackend = (hostId: string, delta: number) =>
      SubscriptionRef.update(backendHosts, (hosts) => {
        const previous = hosts.get(hostId);
        previous?.controller.abort(
          new DOMException("Authenticated workspace changed", "AbortError"),
        );
        return new Map(hosts).set(hostId, {
          pending: (previous?.pending ?? 0) + delta,
          controller: new AbortController(),
        });
      });
    yield* Effect.addFinalizer(() =>
      SubscriptionRef.get(backendHosts).pipe(
        Effect.tap((hosts) =>
          Effect.sync(() => {
            for (const host of hosts.values()) host.controller.abort();
          }),
        ),
      ),
    );

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
      backendLease: (hostId) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(backendHosts, (hosts) =>
            hosts.has(hostId)
              ? hosts
              : new Map(hosts).set(hostId, { pending: 0, controller: new AbortController() }),
          );
          const ready = yield* SubscriptionRef.changes(backendHosts).pipe(
            Stream.map((hosts) => hosts.get(hostId)),
            Stream.filter((host) => host !== undefined && host.pending === 0),
            Stream.runHead,
          );
          return Option.getOrThrow(ready)!.controller.signal;
        }),
      withAccountMutation: (hostId, method, request) =>
        ACCOUNT_MUTATIONS.has(method)
          ? Effect.acquireUseRelease(
              changeBackend(hostId, 1),
              () => request,
              () => changeBackend(hostId, -1),
            )
          : request,
    });
  }),
);

const ACCOUNT_MUTATIONS = new Set([
  "account/login/start",
  "account/logout",
  "account/sessions/add",
  "account/sessions/switch",
  "account/sessions/logout",
]);
