import {
  mobileMethods,
  type MobileEvent,
  type MobileEventData,
  type MobileMethod,
  type MobileParams,
  type MobileResult,
  type RpcError,
} from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HostInvocation } from "../HostInvocation";
import type * as Scope from "effect/Scope";
import type { PushTargets } from "./push-delivery";

export type PushMobileEvent = <K extends MobileEvent>(
  event: K,
  data: MobileEventData<K>,
) => Effect.Effect<void>;

export type MobileHandlers = {
  [K in MobileMethod]: (
    input: MobileParams<K>,
  ) => Effect.Effect<
    K extends "chat.open" ? Effect.Effect<MobileResult<K>, RpcError> : MobileResult<K>,
    RpcError
  >;
};

/** A Device's notification registration belongs to Core, so its phone relay handles these. */
export type PushMethod = "push.register" | "push.unregister";

export interface MobileRpcChannel {
  readonly handlers: Omit<MobileHandlers, PushMethod>;
  readonly recover: (push: PushMobileEvent, discard: Effect.Effect<void>) => Effect.Effect<void>;
}

export class MobileRpc extends Context.Service<
  MobileRpc,
  {
    readonly open: (
      push: PushMobileEvent,
    ) => Effect.Effect<MobileRpcChannel, RpcError, Scope.Scope>;
    /** Tells each Member's phones, without a live channel, what concerns them while they are away. */
    readonly notify: (targets: PushTargets) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/host/mobile/MobileRpc") {}

export const rpcError = (code: RpcError["code"], message: string, retryable = false): RpcError => ({
  code,
  message,
  retryable,
});

export const invalid = (message: string) => rpcError("invalid_params", message);
export const missing = (message: string) => rpcError("not_found", message);
export const capabilityUnavailable = (message: string) =>
  rpcError("capability_unavailable", message, false);
export const unavailable = (message: string) => rpcError("unavailable", message, true);
export const internal = () => rpcError("internal", "The Space Host could not complete this.");

/** The Member whose phone a channel belongs to, as Core opened it; never named by the phone. */
export const PhoneMember = Context.Reference<string | null>("nodex/host/mobile/PhoneMember", {
  defaultValue: () => null,
});

/** Phone façades never borrow the embedding process's local Member authority. */
export const requirePhoneInvocation = Effect.flatMap(HostInvocation, (credential) =>
  credential
    ? Effect.succeed(credential)
    : Effect.fail(rpcError("rejected", "A verified Member invocation is required.")),
);

export const invokeMobileRpc = (
  handlers: MobileHandlers,
  method: string,
  input: unknown,
): Effect.Effect<unknown, RpcError> =>
  Effect.gen(function* () {
    yield* requirePhoneInvocation;
    if (!Object.hasOwn(mobileMethods, method))
      return yield* Effect.fail(rpcError("unknown_method", "This method is unavailable."));
    const key = method as MobileMethod;
    const contract = mobileMethods[key];
    const parsed = contract.params.safeParse(input);
    if (!parsed.success) return yield* Effect.fail(invalid("The request parameters are invalid."));
    // The method selects both the decoder and its handler, so the decoded input belongs to this handler.
    const handler = handlers[key] as (
      input: typeof parsed.data,
    ) => Effect.Effect<unknown, RpcError>;
    return yield* handler(parsed.data);
  });
