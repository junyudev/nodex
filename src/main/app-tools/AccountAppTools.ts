import * as Effect from "effect/Effect";
import { accountSchemas } from "../../shared/nodex-app-tools/account-schemas";
import { CodexAccount } from "../codex-application/CodexAccount";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const account = yield* CodexAccount;
  const turns = yield* CodexTurnAuthority;
  return Effect.fn("AccountAppTools.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    if (!Object.hasOwn(accountSchemas, input.name)) return toolFailure("unknown_tool");
    const parsed = accountSchemas[input.name as keyof typeof accountSchemas].safeParse(
      input.arguments,
    );
    if (!parsed.success) return toolFailure("invalid_arguments");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    if (input.name === "get_usage_limits")
      return yield* account.readUsageLimits.pipe(
        Effect.map((value) =>
          input.caller.isActive() ? toolSuccess(value) : toolFailure("call_withdrawn"),
        ),
        Effect.catch(() => Effect.succeed(toolFailure("account_unavailable"))),
      );
    if (authority.readOnly) return toolFailure("read_only_turn");
    const reset = accountSchemas.consume_usage_reset.safeParse(input.arguments);
    if (!reset.success) return toolFailure("invalid_arguments");
    return yield* account.consumeRateLimitResetCredit(reset.data).pipe(
      Effect.map((result) =>
        toolSuccess({
          outcome: result.outcome,
          rateLimits: result.account.rateLimits ?? null,
          rateLimitResetCredits: result.account.rateLimitResetCredits ?? null,
          idempotencyKey: reset.data.idempotencyKey,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          toolFailure("reset_outcome_unavailable", "Retry only with the same idempotencyKey.", {
            idempotencyKey: reset.data.idempotencyKey,
          }),
        ),
      ),
    );
  });
});
