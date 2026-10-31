import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import { accountSchemas } from "../../shared/nodex-app-tools/account-schemas";
import { CodexAccount } from "../codex-application/CodexAccount";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const account = yield* CodexAccount;
    const identity = yield* CoreAuthority;
    const admitOperation = yield* makeAppToolOperation;
    return Effect.fn("AccountAppTools.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      if (!Object.hasOwn(accountSchemas, input.name)) return toolFailure("unknown_tool");
      const parsed = parseAppToolArguments(
        accountSchemas[input.name as keyof typeof accountSchemas],
        input.arguments,
      );
      if (!parsed.success) return parsed.result;
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      if (input.name === "get_usage_limits")
        return yield* account.readUsageLimits.pipe(
          Effect.map((value) =>
            input.caller.isActive() ? toolSuccess(value) : toolFailure("call_withdrawn"),
          ),
          Effect.catch(() => Effect.succeed(toolFailure("account_unavailable"))),
        );

      const reset = parseAppToolArguments(accountSchemas.consume_usage_reset, input.arguments);
      if (!reset.success) return reset.result;
      const operation = yield* admitOperation(
        input,
        authority,
        identity.identity.profileId,
        reset.data,
      );
      if (!operation.success) return operation.result;
      return yield* account
        .consumeRateLimitResetCredit({ idempotencyKey: operation.operationId })
        .pipe(
          Effect.map((result) =>
            toolSuccess({
              outcome: result.outcome,
              rateLimits: result.account.rateLimits ?? null,
              rateLimitResetCredits: result.account.rateLimitResetCredits ?? null,
              operationId: operation.operationId,
            }),
          ),
          Effect.catch(() =>
            Effect.succeed(
              toolFailure("reset_outcome_unavailable", "Retry only with the same idempotencyKey.", {
                operationId: operation.operationId,
              }),
            ),
          ),
        );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
