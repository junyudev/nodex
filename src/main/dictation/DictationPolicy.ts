import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { ChatGptDesktop } from "../codex-application/ChatGptDesktop";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import {
  decodeChatGptBackendIdentity,
  readChatGptBackendRequestAuth,
} from "../codex/chatgpt-backend-auth";
import { ElectronNet, readDesktopBootstrapMetadata } from "../platform/electron/ElectronNet";
import {
  EMPTY_DICTATION_POLICY,
  requiresDictationWorkspacePermission,
  resolveDictationPolicy,
  type DictationPolicySnapshot,
  type DictationGateValues,
} from "./DictationPolicyState";

import {
  decodePolicyBootstrap,
  makePolicyFallbackUser,
  makeDictationPolicyClient,
} from "../platform/electron/DictationPolicyClient";

export type { DictationPolicySnapshot } from "./DictationPolicyState";

class DictationPolicyError extends Schema.TaggedError<DictationPolicyError>()(
  "DictationPolicyError",
  {
    message: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    errorCode: Schema.optionalKey(Schema.String),
  },
) {}

const Permissions = Schema.Struct({ permissions: Schema.Array(Schema.String) });
type Refresh = Effect.Effect<DictationPolicySnapshot>;
const authMethod = (value: unknown): string | null =>
  typeof value === "string" ? (value === "chatgptAuthTokens" ? "chatgpt" : value) : null;

/** One authenticated policy owner per media lifetime. Reads never initiate a network request. */
export const makeDictationPolicy = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const chatgpt = yield* ChatGptDesktop;
  const capabilities = yield* CodexAppServerCapabilities;
  const workspaceRouting = yield* CodexWorkspaceRouting;
  const authState = yield* CodexExecutionHostAuthState;
  const electron = yield* ElectronNet;
  const snapshot = yield* SubscriptionRef.make(EMPTY_DICTATION_POLICY);
  const generation = yield* Ref.make(0);
  const inFlight = yield* Ref.make<Refresh | null>(null);
  const active = yield* Ref.make<Scope.Closeable | null>(null);
  const mutationRefreshes = yield* Queue.unbounded<void>();
  const closeActive = Effect.gen(function* () {
    const previous = yield* Ref.getAndSet(active, null);
    if (previous) yield* Scope.close(previous, Exit.void);
  });
  yield* Effect.addFinalizer(() => closeActive);

  const publish = Effect.fn("DictationPolicy.publish")(function* (value: DictationPolicySnapshot) {
    const previous = yield* SubscriptionRef.get(snapshot);
    if (
      Object.keys(value).every(
        (key) =>
          value[key as keyof DictationPolicySnapshot] ===
          previous[key as keyof DictationPolicySnapshot],
      )
    )
      return previous;
    yield* SubscriptionRef.set(snapshot, value);
    return value;
  });
  const readJson = Effect.fn("DictationPolicy.readJson")(function* (response: Response) {
    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      const error = Schema.decodeUnknownOption(
        Schema.Struct({ error: Schema.Struct({ code: Schema.optionalKey(Schema.String) }) }),
      )(body);
      return yield* new DictationPolicyError({
        message: `Policy request failed (${response.status})`,
        status: response.status,
        ...(error._tag === "Some" && error.value.error.code !== undefined
          ? { errorCode: error.value.error.code }
          : {}),
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new DictationPolicyError({ message: "Invalid policy response" }),
    });
  });
  const featureEnabled = Effect.gen(function* () {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: ClientRequestResponsesByMethod["experimentalFeature/list"] =
        yield* gateway.requestLocal("experimentalFeature/list", { cursor, limit: 100 });
      const feature = page.data.find((item) => item.name === "in_app_dictation");
      if (feature) return feature.enabled !== false;
      cursor = page.nextCursor ?? null;
      if (cursor !== null && seen.has(cursor))
        return yield* new DictationPolicyError({ message: "Invalid feature pagination" });
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return true;
  });
  const load = Effect.fn("DictationPolicy.load")(function* (capturedGeneration: number) {
    const lease = yield* authState.backendLease(gateway.localHostId);
    const status = yield* chatgpt.authStatus(true, false);
    const method = authMethod(status.authMethod);
    const auth =
      method === "chatgpt"
        ? yield* readChatGptBackendRequestAuth(gateway).pipe(
            Effect.provideService(CodexAppServerCapabilities, capabilities),
            Effect.provideService(CodexWorkspaceRouting, workspaceRouting),
            Effect.provideService(CodexExecutionHostAuthState, authState),
          )
        : { signal: lease, token: undefined, identity: null, planType: null };
    const identity = auth.identity;
    const metadata = yield* readDesktopBootstrapMetadata;
    const bootstrap = identity
      ? yield* chatgpt
          .request({
            baseUrl: "https://chatgpt.com/backend-api",
            path: "/wham/statsig/bootstrap",
            method: "POST",
            action: "load dictation availability",
            headers: {
              "Content-Type": "application/json",
              "X-OpenAI-Expected-Account-Id": identity.accountId,
            },
            expectedAccount: identity,
            body: JSON.stringify(metadata),
            signal: auth.signal,
          })
          .pipe(
            Effect.flatMap(readJson),
            Effect.timeout("5 seconds"),
            Effect.retry({
              times: 5,
              schedule: Schedule.spaced("500 millis"),
              while: (error) =>
                Schema.is(DictationPolicyError)(error) &&
                error.status === 401 &&
                error.errorCode !== "ip_not_authorized" &&
                !auth.signal.aborted,
            }),
            Effect.flatMap((response) =>
              Effect.try({
                try: () => decodePolicyBootstrap(response, identity),
                catch: () => new DictationPolicyError({ message: "Invalid authenticated policy" }),
              }),
            ),
            Effect.orElseSucceed(() => undefined),
          )
      : undefined;
    if (auth.signal.aborted)
      return yield* new DictationPolicyError({ message: "Authenticated workspace changed" });
    let workspaceId: string | undefined;
    let plan = auth.planType;
    if (!bootstrap && identity) {
      const accounts = yield* chatgpt
        .request({
          baseUrl: "https://chatgpt.com/backend-api",
          path: "/wham/accounts/check",
          method: "GET",
          action: "load policy identity",
          expectedAccount: identity,
          signal: auth.signal,
        })
        .pipe(
          Effect.flatMap(readJson),
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                account_ordering: Schema.Array(Schema.String),
                accounts: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    structure: Schema.optionalKey(Schema.String),
                    plan_type: Schema.optionalKey(Schema.String),
                  }),
                ),
              }),
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const current = accounts?.accounts.find(
        (account) => account.id === accounts.account_ordering[0],
      );
      if (current && current.id !== identity.accountId)
        return yield* new DictationPolicyError({ message: "Authenticated workspace changed" });
      workspaceId = current?.structure === "workspace" ? current.id : undefined;
      plan = current?.plan_type ?? plan;
    }
    const fallbackUser = yield* Effect.try({
      try: () =>
        makePolicyFallbackUser({
          token: auth.token,
          identity,
          authMethod: method,
          plan,
          workspaceId,
          metadata,
        }),
      catch: () => new DictationPolicyError({ message: "Invalid policy identity" }),
    });
    const client = yield* makeDictationPolicyClient({
      user: bootstrap?.user ?? fallbackUser,
      bootstrap: bootstrap?.statsigPayload,
      signal: auth.signal,
      metadata,
    }).pipe(Effect.provideService(ElectronNet, electron));
    const evaluate = Effect.fn("DictationPolicy.evaluate")(function* (gates: DictationGateValues) {
      const enabled = yield* featureEnabled;
      let permissions: readonly string[] | null = null;
      if (identity && gates.workspacePermissions && requiresDictationWorkspacePermission(plan)) {
        const response = yield* chatgpt
          .request({
            baseUrl: "https://chatgpt.com/backend-api",
            path: `/accounts/${encodeURIComponent(identity.accountId)}/settings`,
            method: "GET",
            action: "load dictation permissions",
            expectedAccount: identity,
            headers: { "X-OpenAI-Expected-Account-Id": identity.accountId },
            signal: auth.signal,
          })
          .pipe(Effect.flatMap(readJson));
        permissions = (yield* Schema.decodeUnknownEffect(Permissions)(response)).permissions;
      }
      const current = yield* chatgpt.authStatus(true, false);
      const currentIdentity = current.authToken
        ? decodeChatGptBackendIdentity(current.authToken)
        : null;
      const currentMethod = authMethod(current.authMethod);
      if (
        auth.signal.aborted ||
        currentMethod !== method ||
        current.requiresOpenaiAuth !== status.requiresOpenaiAuth ||
        currentIdentity?.accountId !== identity?.accountId ||
        currentIdentity?.userId !== identity?.userId
      )
        return yield* new DictationPolicyError({ message: "Authenticated workspace changed" });
      return resolveDictationPolicy({
        identity,
        auth: {
          method,
          requiresAuth: status.requiresOpenaiAuth !== false,
          hasToken: Boolean(status.authToken),
        },
        gates,
        featureEnabled: enabled,
        plan,
        permissions,
      });
    });
    const initial = yield* evaluate(yield* client.read);
    yield* client.changes.pipe(
      Stream.runForEach((gates) =>
        Effect.gen(function* () {
          const next = yield* evaluate(gates).pipe(
            Effect.orElseSucceed(() => EMPTY_DICTATION_POLICY),
          );
          if ((yield* Ref.get(generation)) === capturedGeneration) yield* publish(next);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.callback<void>((resume) => {
      const onAbort = () => resume(Effect.void);
      if (auth.signal.aborted) onAbort();
      else auth.signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => auth.signal.removeEventListener("abort", onAbort));
    }).pipe(Effect.andThen(Queue.offer(mutationRefreshes, undefined)), Effect.forkScoped);
    return initial;
  });
  const refreshOnce: Refresh = Effect.gen(function* () {
    const capturedGeneration = yield* Ref.updateAndGet(generation, (value) => value + 1);
    yield* closeActive;
    const scope = yield* Scope.make();
    yield* Ref.set(active, scope);
    const next = yield* load(capturedGeneration).pipe(
      Scope.provide(scope),
      Effect.orElseSucceed(() => EMPTY_DICTATION_POLICY),
    );
    if ((yield* Ref.get(generation)) !== capturedGeneration)
      return yield* SubscriptionRef.get(snapshot);
    return yield* publish(next);
  });
  const refresh: Refresh = Effect.gen(function* () {
    const candidate = yield* Effect.cached(refreshOnce);
    const selected = yield* Ref.modify<
      Refresh | null,
      { readonly effect: Refresh; readonly owner: boolean }
    >(inFlight, (current) => [
      { effect: current ?? candidate, owner: current === null },
      current ?? candidate,
    ]);
    if (!selected.owner) return yield* selected.effect;
    return yield* selected.effect.pipe(
      Effect.ensuring(
        Ref.update(inFlight, (current) => (current === selected.effect ? null : current)),
      ),
    );
  });
  yield* gateway.events.pipe(
    Stream.filter((event) =>
      event.kind === "notification"
        ? event.hostId === gateway.localHostId && event.value.method === "account/updated"
        : event.value.hostId === gateway.localHostId && event.value.kind !== "ready",
    ),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        yield* Ref.update(generation, (value) => value + 1);
        yield* Ref.set(inFlight, null);
        yield* closeActive;
        yield* publish(EMPTY_DICTATION_POLICY);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Stream.fromQueue(mutationRefreshes).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        yield* publish(EMPTY_DICTATION_POLICY);
        yield* refresh;
      }),
    ),
    Effect.forkScoped,
  );
  return {
    read: SubscriptionRef.get(snapshot),
    refresh,
    changes: SubscriptionRef.changes(snapshot),
  };
});
