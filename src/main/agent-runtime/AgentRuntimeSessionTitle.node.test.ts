import { assert, it } from "@effect/vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { generateSessionTitle } from "./AgentRuntimeSessionTitle";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

const input = {
  prompt: "Repair the login failure when the saved token expires",
  cwd: "/workspace",
  modelSelection: { instanceId: "acp-instance", model: "native-model" },
};

it.effect.each([false, true] as const)(
  "title generation respects the selected Agent's utility capability (%s)",
  (supportsTextGeneration) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const request: AgentRuntimeApplicationConnection["request"] = (method) => {
        calls.push(method);
        const output =
          method === "providers.read"
            ? [{ instanceId: "acp-instance", supportsTextGeneration, models: [] }]
            : { title: "Repair expired login", description: "Refresh the saved token" };
        return Effect.succeed(output as AgentRuntimeOperations[typeof method]["output"]);
      };
      const title = yield* generateSessionTitle({ request }, input);
      assert.equal(title, supportsTextGeneration ? "Repair expired login" : null);
      assert.deepEqual(
        calls,
        supportsTextGeneration
          ? ["providers.read", "text.generate-structured"]
          : ["providers.read"],
      );
    }),
);
