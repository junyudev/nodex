import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CodexAccount, CodexAccountInputError } from "../codex-application/CodexAccount";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./AccountAppTools";
const authority: NodexAgentTurnContext = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};
const input: AppToolInvocation = {
  name: "consume_usage_reset",
  arguments: { idempotencyKey: "exact-retry-key" },
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
it.effect(
  "preserves reset identity and private account data while refusing withdrawn native calls",
  () =>
    Effect.gen(function* () {
      let active = true;
      const call = { ...input, caller: { ...input.caller, isActive: () => active } };
      let uncertain = false;
      const calls: string[] = [];
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.succeed(authority),
        } as unknown as CodexTurnAuthority["Service"]),
        Effect.provideService(CodexAccount, {
          readUsageLimits: Effect.succeed({
            ordinaryUsageAllowed: false,
            rateLimits: null,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          }),
          consumeRateLimitResetCredit: (request: { idempotencyKey: string }) =>
            Effect.gen(function* () {
              calls.push(request.idempotencyKey);
              if (uncertain) return yield* new CodexAccountInputError({ message: "response lost" });
              return {
                outcome: "noCredit",
                account: {
                  account: { type: "chatgpt", email: "private@example.com", planType: "plus" },
                  pendingLogin: { loginId: "private", authUrl: "private" },
                  requiresOpenAiAuth: false,
                },
              };
            }),
        } as unknown as CodexAccount["Service"]),
      );
      assert.deepStrictEqual(
        (yield* execute({ ...call, name: "get_usage_limits", arguments: {} })).structuredContent,
        {
          ordinaryUsageAllowed: false,
          rateLimits: null,
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        },
      );
      assert.deepStrictEqual((yield* execute(call)).structuredContent, {
        outcome: "noCredit",
        rateLimits: null,
        rateLimitResetCredits: null,
        idempotencyKey: "exact-retry-key",
      });
      uncertain = true;
      assert.deepStrictEqual((yield* execute(call)).structuredContent, {
        error: {
          code: "reset_outcome_unavailable",
          details: { idempotencyKey: "exact-retry-key" },
        },
      });
      active = false;
      assert.deepStrictEqual((yield* execute(call)).structuredContent, {
        error: { code: "call_withdrawn" },
      });
      assert.deepStrictEqual(calls, ["exact-retry-key", "exact-retry-key"]);
    }),
);
