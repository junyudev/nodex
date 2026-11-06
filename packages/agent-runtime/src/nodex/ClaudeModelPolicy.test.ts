import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../src/shared/model-policy.ts";
import { RuntimeModelPolicy, make } from "./ModelPolicy.ts";
import { restrictions, verifyClaudeModelPolicy } from "./ClaudeModelPolicy.ts";

it.live(
  "verifies native allow and deny settings with the installed SDK without launching inference",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const provider = { instanceId, driver: "claudeAgent" };
      const policy = setModelOn(
        setModelOn(DEFAULT_MODEL_POLICY, provider, "claude-opus-5-5", false),
        provider,
        "custom-retired-model",
        false,
      );
      const owner = yield* make(policy, {});
      const managedSettings = yield* restrictions({ instanceId, model: "claude-sonnet-5-5" }).pipe(
        Effect.provideService(RuntimeModelPolicy, owner),
      );
      expect(managedSettings.deniedModels).toContain("claude-opus-5-5");
      expect(managedSettings.deniedModels).toContain("custom-retired-model");
      expect(managedSettings.availableModels).not.toContain("claude-opus-5-5");
      yield* Effect.tryPromise(() =>
        verifyClaudeModelPolicy({ settingSources: [], managedSettings }, resolveSettings),
      );
      yield* Effect.tryPromise(async () => {
        await expect(
          verifyClaudeModelPolicy({ managedSettings }, async () => ({
            effective: {},
            provenance: {},
            sources: [],
          })),
        ).rejects.toThrow("could not be verified");
      });
    }),
);
