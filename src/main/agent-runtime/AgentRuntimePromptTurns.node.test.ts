import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { readPromptTurns } from "./AgentRuntimePromptTurns";

it.effect(
  "reads only addressed metadata and shares one complete answer for messages delivered into the same Run",
  () =>
    Effect.gen(function* () {
      const calls = vi.fn();
      const request = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ): Effect.Effect<AgentRuntimeOperations[M]["output"], unknown> => {
        calls(method, input);
        const value =
          method === "thread.message-turn"
            ? {
                runId: "run",
                status: "completed",
                completedAt: "2026-10-31T00:00:00Z",
                finalAssistantItemId: "answer",
              }
            : {
                type: "assistant_message",
                streaming: false,
                status: "completed",
                text: "**Final**\n\n" + "x".repeat(40_000),
              };
        return Effect.succeed(value as AgentRuntimeOperations[M]["output"]);
      };
      const turns = yield* readPromptTurns({ request }, "root", ["opening", "steer"]);
      expect(turns.map((turn) => [turn.messageId, turn.phase, turn.reply?.length])).toEqual([
        ["opening", "done", 40_011],
        ["steer", "done", 40_011],
      ]);
      expect(calls.mock.calls.map(([method]) => method)).toEqual([
        "thread.message-turn",
        "thread.item.full",
        "thread.message-turn",
      ]);
    }),
);
it.effect.each(["queued", "running", "waiting", "failed", "interrupted"] as const)(
  "does not read a reply for %s work",
  (status) =>
    Effect.gen(function* () {
      const request = vi.fn().mockReturnValue(
        Effect.succeed({
          runId: "run",
          status,
          completedAt: null,
          finalAssistantItemId: "partial",
        }),
      );
      const turns = yield* readPromptTurns({ request }, "root", ["message"]);
      expect(turns[0]?.reply).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    }),
);
