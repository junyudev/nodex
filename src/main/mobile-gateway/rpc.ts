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
import type * as Scope from "effect/Scope";

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

export interface MobileRpcChannel {
  readonly handlers: MobileHandlers;
  readonly recover: (push: PushMobileEvent, discard: Effect.Effect<void>) => Effect.Effect<void>;
}

export class MobileRpc extends Context.Service<
  MobileRpc,
  {
    readonly open: (
      push: PushMobileEvent,
    ) => Effect.Effect<MobileRpcChannel, RpcError, Scope.Scope>;
  }
>()("nodex/main/mobile-gateway/MobileRpc") {}

export const rpcError = (code: RpcError["code"], message: string, retryable = false): RpcError => ({
  code,
  message,
  retryable,
});

export const invalid = (message: string) => rpcError("invalid_params", message);
export const missing = (message: string) => rpcError("not_found", message);
export const unavailable = (message: string) => rpcError("unavailable", message, true);
export const internal = () =>
  rpcError("internal", "Nodex on your desktop could not complete this.");

export const invokeMobileRpc = (
  handlers: MobileHandlers,
  method: string,
  input: unknown,
): Effect.Effect<unknown, RpcError> => {
  if (!Object.hasOwn(mobileMethods, method))
    return Effect.fail(rpcError("unknown_method", "This method is unavailable."));
  const key = method as MobileMethod;
  const contract = mobileMethods[key];
  const parsed = contract.params.safeParse(input);
  if (!parsed.success) return Effect.fail(invalid("The request parameters are invalid."));
  // The method selects both the decoder and its handler, so the decoded input belongs to this handler.
  const handler = handlers[key] as (input: typeof parsed.data) => Effect.Effect<unknown, RpcError>;
  return handler(parsed.data);
};
