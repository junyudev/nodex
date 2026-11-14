import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderInstanceId } from "@nodex/runtime-contracts";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../src/shared/model-policy.ts";
import { startScriptedAnthropicServer } from "../../../../scripts/scenarios/runtime/scripted-anthropic-server.ts";
import { RuntimeModelPolicy, make } from "./ModelPolicy.ts";
import {
  applyClaudeModelLineup,
  BUNDLED_CLAUDE_MODEL_CATALOG,
  parseClaudeModelLineup,
} from "../provider/ClaudeModelCatalog.ts";
import { restrictions, verifyClaudeModelPolicy } from "./ClaudeModelPolicy.ts";

it.live("Claude Code sends the exact selected version with its preceding version off", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const provider = { instanceId, driver: "claudeAgent" };
    const switches = [
      ["claude-fable-5", "claude-fable-5-2"],
      ["claude-opus-5", "claude-opus-5-5"],
    ] as const;
    const owner = yield* make(
      switches.reduce(
        (policy, [off]) => setModelOn(policy, provider, off, false),
        DEFAULT_MODEL_POLICY,
      ),
      {},
    );
    const cwd = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-claude-model-policy-"))),
      (cwd) => Effect.promise(() => rm(cwd, { recursive: true, force: true })),
    );
    const endpoint = yield* Effect.acquireRelease(
      Effect.tryPromise(() => startScriptedAnthropicServer(() => ({ type: "text", text: "OK" }))),
      (endpoint) => Effect.promise(endpoint.close),
    );
    for (const [off, model] of switches) {
      const managedSettings = yield* restrictions({ instanceId, model }).pipe(
        Effect.provideService(RuntimeModelPolicy, owner),
      );
      expect(managedSettings.availableModels).toContain(model);
      expect(managedSettings.availableModels).not.toContain(off);
      const sentBefore = endpoint.requests.length;
      yield* Effect.tryPromise(async (signal) => {
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        signal.addEventListener("abort", abort, { once: true });
        const session = query({
          prompt: "Respond with OK.",
          options: {
            abortController,
            cwd,
            env: { ...endpoint.environment, HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: cwd },
            managedSettings,
            model,
            permissionMode: "dontAsk",
            persistSession: false,
            settingSources: [],
            tools: [],
          },
        });
        try {
          for await (const message of session) {
            if (message.type === "result") expect(message.subtype).toBe("success");
          }
        } finally {
          session.close();
          signal.removeEventListener("abort", abort);
        }
      });
      const requests = endpoint.requests.slice(sentBefore);
      expect(
        requests.some(
          (request) =>
            request.messages.some((entry) =>
              JSON.stringify(entry.content).includes("Respond with OK."),
            ) && request.model === model,
        ),
      ).toBe(true);
      expect(requests.every((request) => request.model !== off)).toBe(true);
    }
  }).pipe(Effect.scoped),
);

it.live(
  "verifies native exact model restrictions with the installed SDK without launching inference",
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
      expect(managedSettings.availableModels).not.toContain("custom-retired-model");
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

it.effect("refuses extended context selections for an off model", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const model = "claude-sonnet-4-6";
    const policy = setModelOn(
      DEFAULT_MODEL_POLICY,
      { instanceId, driver: "claudeAgent" },
      model,
      false,
    );
    const owner = yield* make(policy, {});
    const failure = yield* restrictions({ instanceId, model: `${model}[1m]` }).pipe(
      Effect.provideService(RuntimeModelPolicy, owner),
      Effect.flip,
    );
    expect(failure.code).toBe("model_off");
  }),
);

it.effect(
  "newly discovered Claude models follow the provider default in native exact restrictions",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const catalog = applyClaudeModelLineup(
        BUNDLED_CLAUDE_MODEL_CATALOG,
        parseClaudeModelLineup([{ value: "fable", resolvedModel: "claude-fable-5-3" }]),
      );
      const owner = yield* make(DEFAULT_MODEL_POLICY, {});
      const settings = yield* restrictions(
        { instanceId, model: "claude-sonnet-5-5" },
        catalog,
      ).pipe(Effect.provideService(RuntimeModelPolicy, owner));
      expect(settings.availableModels).toContain("claude-fable-5-3");
      expect(settings.availableModelsMatch).toBe("exact");
      const disabled = yield* make(
        setModelOn(
          DEFAULT_MODEL_POLICY,
          { instanceId, driver: "claudeAgent" },
          "claude-fable-5-3",
          false,
        ),
        {},
      );
      const restricted = yield* restrictions(
        { instanceId, model: "claude-sonnet-5-5" },
        catalog,
      ).pipe(Effect.provideService(RuntimeModelPolicy, disabled));
      expect(restricted.availableModels).not.toContain("claude-fable-5-3");
    }),
);
