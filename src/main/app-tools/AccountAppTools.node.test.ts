import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexAccount, CodexAccountInputError } from "../codex-application/CodexAccount";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./AccountAppTools";
const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: false,
  scope: "project",
  source: "project_turn",
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
  "preserves reset identity and outcomes without exposing login data or redeeming on read-only Turns",
  () =>
    Effect.gen(function* () {
      let readOnly = true;
      let uncertain = false;
      const calls: string[] = [];
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.sync(() => ({ ...authority, readOnly })),
        } as unknown as CodexTurnAuthority["Service"]),
        Effect.provideService(CodexAccount, {
          readUsageLimits: Effect.succeed({
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
      assert.deepStrictEqual((yield* execute(input)).structuredContent, {
        error: { code: "read_only_turn" },
      });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(
        (yield* execute({ ...input, name: "get_usage_limits", arguments: {} })).structuredContent,
        { rateLimits: null, rateLimitsByLimitId: null, rateLimitResetCredits: null },
      );
      readOnly = false;
      assert.deepStrictEqual((yield* execute(input)).structuredContent, {
        outcome: "noCredit",
        rateLimits: null,
        rateLimitResetCredits: null,
        idempotencyKey: "exact-retry-key",
      });
      uncertain = true;
      assert.deepStrictEqual((yield* execute(input)).structuredContent, {
        error: {
          code: "reset_outcome_unavailable",
          details: { idempotencyKey: "exact-retry-key" },
        },
      });
      assert.deepStrictEqual(calls, ["exact-retry-key", "exact-retry-key"]);
    }),
);
