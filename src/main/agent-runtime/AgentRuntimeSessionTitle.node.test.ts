import { assert, it } from "@effect/vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../shared/model-policy";
import { generateSessionTitle } from "./AgentRuntimeSessionTitle";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

const input = {
  prompt: "Repair the login failure when the saved token expires",
  cwd: "/workspace",
  modelSelection: { instanceId: "acp-instance", model: "native-model" },
  titleModel: null,
  modelPolicy: DEFAULT_MODEL_POLICY,
};

type Providers = AgentRuntimeOperations["providers.read"]["output"];

const connectionTo = (providers: readonly unknown[]) => {
  const calls: string[] = [];
  const selections: unknown[] = [];
  const request: AgentRuntimeApplicationConnection["request"] = (method, payload) => {
    calls.push(method);
    if (method === "text.generate-structured")
      selections.push((payload as { modelSelection: unknown }).modelSelection);
    const output =
      method === "providers.read"
        ? (providers as Providers)
        : { title: "Repair expired login", description: "Refresh the saved token" };
    return Effect.succeed(output as AgentRuntimeOperations[typeof method]["output"]);
  };
  return { calls, selections, request };
};

const titleProviders = [
  { instanceId: "acp-instance", supportsTextGeneration: false, models: [] },
  {
    instanceId: "codex",
    models: [
      {
        slug: "gpt-6-luna",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              type: "select",
              options: [{ id: "low" }, { id: "high" }],
            },
          ],
        },
      },
    ],
  },
];

it.effect.each([false, true] as const)(
  "title generation respects the selected Agent's utility capability (%s)",
  (supportsTextGeneration) =>
    Effect.gen(function* () {
      const { calls, request } = connectionTo([
        { instanceId: "acp-instance", supportsTextGeneration, models: [] },
      ]);
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

it.effect("a title model names a chat whose own Agent cannot generate text", () =>
  Effect.gen(function* () {
    const { selections, request } = connectionTo(titleProviders);
    const title = yield* generateSessionTitle(
      { request },
      { ...input, titleModel: { instanceId: "codex", model: "gpt-6-luna" } },
    );
    assert.equal(title, "Repair expired login");
    assert.deepEqual(selections, [
      {
        instanceId: "codex",
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    ]);
  }),
);

it.effect("a title model that went away is not replaced by the chat's own model", () =>
  Effect.gen(function* () {
    const { selections, request } = connectionTo([]);
    yield* generateSessionTitle(
      { request },
      {
        ...input,
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        titleModel: { instanceId: "removed", model: "gone" },
      },
    );
    assert.deepEqual(selections, [{ instanceId: "removed", model: "gone" }]);
  }),
);

const codex = {
  instanceId: "codex",
  driver: "codex",
  models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-luna" }],
};
const titledOn = (
  providers: readonly unknown[],
  modelSelection: { readonly instanceId: string; readonly model: string },
  modelPolicy = DEFAULT_MODEL_POLICY,
) =>
  Effect.gen(function* () {
    const { selections, request } = connectionTo(providers);
    yield* generateSessionTitle({ request }, { ...input, modelSelection, modelPolicy });
    return selections;
  });

it.effect("a light model on the chat's own Agent titles it by default", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* titledOn([codex], { instanceId: "codex", model: "gpt-6.1-sol" }), [
      { instanceId: "codex", model: "gpt-6-luna" },
    ]);
    const claude = {
      instanceId: "claude-work",
      driver: "claudeAgent",
      models: [
        { slug: "claude-opus-5-5" },
        { slug: "claude-sonnet-5-5" },
        { slug: "claude-haiku-5-5" },
      ],
    };
    assert.deepEqual(
      yield* titledOn([claude], { instanceId: "claude-work", model: "claude-opus-5-5" }),
      [{ instanceId: "claude-work", model: "claude-haiku-5-5" }],
    );
  }),
);

it.effect("a chat keeps its own model when the light one is off", () =>
  Effect.gen(function* () {
    const modelPolicy = setModelOn(DEFAULT_MODEL_POLICY, codex, "gpt-6-luna", false);
    assert.deepEqual(
      yield* titledOn([codex], { instanceId: "codex", model: "gpt-6.1-sol" }, modelPolicy),
      [{ instanceId: "codex", model: "gpt-6.1-sol" }],
    );
  }),
);

it.effect("a credit chat is never moved to a model the person did not choose", () =>
  Effect.gen(function* () {
    const credit = { ...codex, instanceId: "nodex_codex_account", source: "nodex" };
    assert.deepEqual(
      yield* titledOn([credit], { instanceId: "nodex_codex_account", model: "gpt-6.1-sol" }),
      [{ instanceId: "nodex_codex_account", model: "gpt-6.1-sol" }],
    );
  }),
);

it.effect("an Agent whose catalog reaches many vendors keeps the chat's own model", () =>
  Effect.gen(function* () {
    const openCode = {
      instanceId: "opencode",
      driver: "opencode",
      models: [{ slug: "opencode/beam-free" }, { slug: "anthropic/claude-haiku-5-5" }],
    };
    assert.deepEqual(
      yield* titledOn([openCode], { instanceId: "opencode", model: "opencode/beam-free" }),
      [{ instanceId: "opencode", model: "opencode/beam-free" }],
    );
  }),
);
