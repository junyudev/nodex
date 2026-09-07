import * as Context from "effect/Context";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  CodexAccountSnapshot,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  emptyAccountRateLimitState,
  emptyAccountSnapshot,
  parseAccountIdentity,
  parseRateLimitResetCreditsSummary,
  parseRateLimitsSnapshot,
} from "./CodexAccountState";

export interface CodexAccountOptions {
  readonly pollInterval: Duration.Input;
  readonly refreshOnStart?: boolean;
}

export class CodexAccountInputError extends Schema.TaggedError<CodexAccountInputError>()(
  "CodexAccountInputError",
  { message: Schema.String },
) {}

export type CodexAccountError = CodexRuntimeError | CodexAccountInputError;
type AccountRefreshEffect = Effect.Effect<CodexAccountSnapshot, CodexRuntimeError>;
export type CodexUsageLimits = Pick<
  ClientRequestResponsesByMethod["account/rateLimits/read"],
  "rateLimits" | "rateLimitsByLimitId"
> & {
  readonly rateLimitResetCredits: CodexAccountSnapshot["rateLimitResetCredits"];
};

interface AccountRefreshSelection {
  readonly effect: AccountRefreshEffect;
  readonly owner: boolean;
}

export type CodexAccountLoginInput =
  | { readonly type: "chatgpt" }
  | { readonly type: "apiKey"; readonly apiKey: string };

export type CodexAccountLoginResult =
  | { readonly type: "apiKey" }
  | { readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string };

export class CodexAccount extends Context.Service<
  CodexAccount,
  {
    readonly snapshot: SubscriptionRef.SubscriptionRef<CodexAccountSnapshot>;
    readonly refresh: Effect.Effect<CodexAccountSnapshot, CodexRuntimeError>;
    readonly readUsageLimits: Effect.Effect<CodexUsageLimits, CodexRuntimeError>;
    readonly consumeRateLimitResetCredit: (
      input: CodexRateLimitResetInput,
    ) => Effect.Effect<CodexRateLimitResetResult, CodexAccountError>;
    readonly startLogin: (
      input: CodexAccountLoginInput,
    ) => Effect.Effect<CodexAccountLoginResult, CodexRuntimeError>;
    readonly cancelLogin: (
      loginId: string,
    ) => Effect.Effect<{ readonly status: "canceled" | "notFound" }, CodexRuntimeError>;
    readonly logout: Effect.Effect<boolean, CodexRuntimeError>;
  }
>()("nodex/main/codex-application/CodexAccount") {}

export const live = (
  options: CodexAccountOptions,
): Layer.Layer<CodexAccount, never, CodexGateway> =>
  Layer.effect(
    CodexAccount,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const snapshot = yield* SubscriptionRef.make<CodexAccountSnapshot>(emptyAccountSnapshot());
      const refreshLock = yield* Semaphore.make(1);
      const refreshInFlight = yield* Ref.make<AccountRefreshEffect | null>(null);
      const awaitReady = gateway.awaitReady(gateway.localHostId);
      const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Readonly<Record<string, unknown>>)
          : undefined;

      const readRateLimits = Effect.fn("CodexAccount.readRateLimits")(function* () {
        const response = yield* gateway
          .requestLocal("account/rateLimits/read", undefined)
          .pipe(Effect.orElseSucceed(() => null));
        if (response === null) return emptyAccountRateLimitState();
        return {
          rateLimits: parseRateLimitsSnapshot(response.rateLimits ?? null),
          rateLimitResetCredits: parseRateLimitResetCreditsSummary(
            response.rateLimitResetCredits ?? null,
          ),
        };
      });

      const load = Effect.gen(function* () {
        yield* awaitReady;
        const response = yield* gateway.requestLocal("account/read", { refreshToken: false });
        const account = parseAccountIdentity(response.account ?? null);
        const rateLimitState =
          account?.type === "chatgpt" ? yield* readRateLimits() : emptyAccountRateLimitState();
        const previous = yield* SubscriptionRef.get(snapshot);
        const next: CodexAccountSnapshot = {
          account,
          requiresOpenAiAuth: Boolean(response.requiresOpenaiAuth),
          pendingLogin: previous.pendingLogin ?? null,
          ...rateLimitState,
        };
        yield* SubscriptionRef.set(snapshot, next);
        yield* Effect.logInfo("Read Codex account snapshot").pipe(
          Effect.annotateLogs({
            accountType: next.account?.type ?? null,
            requiresOpenAiAuth: next.requiresOpenAiAuth,
            hasRateLimits: Boolean(next.rateLimits),
          }),
        );
        return next;
      }).pipe(refreshLock.withPermits(1));

      const refresh: CodexAccount["Service"]["refresh"] = Effect.gen(function* () {
        const candidate = yield* Effect.cached(load);
        const selection = yield* Ref.modify<AccountRefreshEffect | null, AccountRefreshSelection>(
          refreshInFlight,
          (current) =>
            current === null
              ? [{ effect: candidate, owner: true }, candidate]
              : [{ effect: current, owner: false }, current],
        );
        if (!selection.owner) return yield* selection.effect;
        return yield* selection.effect.pipe(
          Effect.ensuring(
            Ref.update(refreshInFlight, (current) =>
              current === selection.effect ? null : current,
            ),
          ),
        );
      });

      const refreshRateLimits = Effect.gen(function* () {
        const rateLimitState = yield* readRateLimits();
        return yield* SubscriptionRef.modify(snapshot, (current) => {
          const next = { ...current, ...rateLimitState };
          return [next, next];
        });
      }).pipe(refreshLock.withPermits(1));

      const pollOnce = SubscriptionRef.get(snapshot).pipe(
        Effect.flatMap((current) =>
          current.account?.type === "chatgpt" ? refreshRateLimits.pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.ignore,
      );
      yield* Effect.repeat(pollOnce, Schedule.spaced(options.pollInterval)).pipe(Effect.forkScoped);

      yield* gateway.events.pipe(
        Stream.filter(
          (event) => event.kind === "notification" && event.hostId === gateway.localHostId,
        ),
        Stream.runForEach((event) => {
          if (event.kind !== "notification") return Effect.void;
          if (event.value.method === "account/rateLimits/updated") {
            const params = asRecord(event.value.params);
            return SubscriptionRef.update(snapshot, (current) => ({
              ...current,
              rateLimits: parseRateLimitsSnapshot(params?.rateLimits ?? null),
            }));
          }
          if (event.value.method === "account/login/completed") {
            return SubscriptionRef.update(snapshot, (current) => ({
              ...current,
              pendingLogin: null,
            })).pipe(Effect.andThen(refresh.pipe(Effect.ignore)));
          }
          if (event.value.method === "account/updated") return refresh.pipe(Effect.ignore);
          return Effect.void;
        }),
        Effect.forkScoped,
      );

      if (options.refreshOnStart === true) yield* refresh.pipe(Effect.ignore);

      const consumeRateLimitResetCredit = Effect.fn("CodexAccount.consumeResetCredit")(function* (
        input: CodexRateLimitResetInput,
      ) {
        const idempotencyKey = input.idempotencyKey.trim();
        if (!idempotencyKey) {
          return yield* new CodexAccountInputError({
            message: "Rate-limit reset idempotency key is required",
          });
        }
        const creditId = input.creditId?.trim();
        if (input.creditId !== undefined && input.creditId !== null && !creditId) {
          return yield* new CodexAccountInputError({
            message: "Rate-limit reset credit ID must not be empty",
          });
        }
        yield* awaitReady;
        const response = yield* gateway.requestLocal("account/rateLimitResetCredit/consume", {
          idempotencyKey,
          ...(creditId ? { creditId } : {}),
        });
        const account =
          response.outcome === "reset" ||
          response.outcome === "alreadyRedeemed" ||
          response.outcome === "noCredit"
            ? yield* refreshRateLimits
            : yield* SubscriptionRef.get(snapshot);
        return { outcome: response.outcome, account };
      });

      const startLogin = Effect.fn("CodexAccount.startLogin")(function* (
        input: CodexAccountLoginInput,
      ) {
        yield* awaitReady;
        if (input.type === "apiKey") {
          yield* gateway.requestLocal("account/login/start", input);
          yield* refresh;
          return { type: "apiKey" as const };
        }
        const response = yield* gateway.requestLocal("account/login/start", input);
        const result = {
          type: "chatgpt" as const,
          loginId: response.type === "chatgpt" ? response.loginId : "",
          authUrl: response.type === "chatgpt" ? response.authUrl : "",
        };
        yield* SubscriptionRef.update(snapshot, (current) => ({
          ...current,
          pendingLogin: { loginId: result.loginId, authUrl: result.authUrl },
        }));
        return result;
      });

      const cancelLogin = Effect.fn("CodexAccount.cancelLogin")(function* (loginId: string) {
        yield* awaitReady;
        const response = yield* gateway.requestLocal("account/login/cancel", { loginId });
        yield* SubscriptionRef.update(snapshot, (current) =>
          current.pendingLogin?.loginId === loginId ? { ...current, pendingLogin: null } : current,
        );
        return {
          status: response.status === "canceled" ? ("canceled" as const) : ("notFound" as const),
        };
      });

      const logout = Effect.gen(function* () {
        yield* awaitReady;
        yield* gateway.requestLocal("account/logout", undefined);
        yield* SubscriptionRef.set(snapshot, emptyAccountSnapshot());
        return true;
      });

      return CodexAccount.of({
        snapshot,
        refresh,
        readUsageLimits: Effect.gen(function* () {
          yield* awaitReady;
          const response = yield* gateway.requestLocal("account/rateLimits/read", undefined);
          return {
            rateLimits: response.rateLimits,
            rateLimitsByLimitId: response.rateLimitsByLimitId ?? null,
            rateLimitResetCredits: parseRateLimitResetCreditsSummary(
              response.rateLimitResetCredits ?? null,
            ),
          };
        }),
        consumeRateLimitResetCredit,
        startLogin,
        cancelLogin,
        logout,
      });
    }),
  );
