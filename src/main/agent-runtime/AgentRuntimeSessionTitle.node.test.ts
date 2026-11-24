import { assert, it } from "@effect/vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../shared/model-policy";
import {
  selectWritingModel,
  writingModelCandidates,
} from "../../shared/agent-runtime-utility-model";
import { agentRuntimeProviderFixture } from "../../shared/testing/agent-runtime-snapshot";
import { generateSessionTitle } from "./AgentRuntimeSessionTitle";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const codex = agentRuntimeProviderFixture({
  models: [model("gpt-6.1-sol"), model("gpt-6-luna")],
});
const claude = agentRuntimeProviderFixture({
  instanceId: "claude-work",
  driver: "claudeAgent",
  models: [model("claude-opus"), model("claude-haiku")],
});
const opus = { instanceId: claude.instanceId, model: "claude-opus" };
const sol = { instanceId: codex.instanceId, model: "gpt-6.1-sol" };

it("uses the exact writing choice, then the chat Agent, then the default available Agent", () => {
  const policy = DEFAULT_MODEL_POLICY;
  assert.deepEqual(selectWritingModel([claude, codex], policy, sol, opus), sol);
  assert.deepEqual(
    selectWritingModel(
      [claude, { ...codex, auth: { status: "unauthenticated" } }],
      policy,
      sol,
      opus,
    ),
    { instanceId: claude.instanceId, model: "claude-haiku" },
  );
  assert.deepEqual(selectWritingModel([claude, codex], policy, null), {
    instanceId: codex.instanceId,
    model: "gpt-6-luna",
  });
  assert.deepEqual(
    selectWritingModel([{ ...claude, supportsTextGeneration: false }, codex], policy, opus, opus),
    { instanceId: codex.instanceId, model: "gpt-6-luna" },
  );
  assert.isNull(selectWritingModel([{ ...codex, installed: false }], policy, sol, sol));
  // The chat's Agent writes first and the default Agent once if it fails; an exact choice alone.
  assert.deepEqual(writingModelCandidates([claude, codex], policy, null, opus), [
    { instanceId: claude.instanceId, model: "claude-haiku" },
    { instanceId: codex.instanceId, model: "gpt-6-luna" },
  ]);
  assert.deepEqual(writingModelCandidates([claude, codex], policy, sol, opus), [sol]);
});

it("keeps the model policy authoritative and only spends credit on a model the person chose", () => {
  const credit = { ...codex, instanceId: "nodex_codex_account", source: "nodex" as const };
  const policy = setModelOn(DEFAULT_MODEL_POLICY, codex, "gpt-6-luna", false);
  assert.deepEqual(selectWritingModel([codex], policy, null, sol), sol);
  assert.isNull(selectWritingModel([credit], policy, null));
  const creditModel = { ...sol, instanceId: credit.instanceId };
  assert.deepEqual(selectWritingModel([credit], policy, null, creditModel), creditModel);
  assert.deepEqual(selectWritingModel([credit], policy, creditModel), creditModel);
});

it.effect("a chosen writing model titles a chat on a different Agent at its lightest effort", () =>
  Effect.gen(function* () {
    const providers = [
      claude,
      {
        ...codex,
        models: [
          {
            ...model(sol.model),
            capabilities: {
              optionDescriptors: [
                { id: "reasoningEffort", type: "select", options: [{ id: "low" }, { id: "high" }] },
              ],
            },
          },
        ],
      },
    ];
    const selections: unknown[] = [];
    const request: AgentRuntimeApplicationConnection["request"] = (method, payload) => {
      if (method === "text.generate-structured" && "modelSelection" in payload)
        selections.push(payload.modelSelection);
      const output = method === "providers.read" ? providers : { title: "Repair expired login" };
      return Effect.succeed(output as AgentRuntimeOperations[typeof method]["output"]);
    };
    const title = yield* generateSessionTitle(
      { request },
      {
        prompt: "Repair the login failure when the saved token expires",
        cwd: "/workspace",
        modelSelection: opus,
        writingModel: sol,
        modelPolicy: DEFAULT_MODEL_POLICY,
        nativeTitle: Effect.die("A runnable writing model takes precedence"),
      },
    );
    assert.equal(title, "Repair expired login");
    assert.deepEqual(selections, [{ ...sol, options: [{ id: "reasoningEffort", value: "low" }] }]);
  }),
);

it.effect("a failed writer hands the title to the next one, and an exact choice writes alone", () =>
  Effect.gen(function* () {
    const attempts: unknown[] = [];
    const request: AgentRuntimeApplicationConnection["request"] = (method, payload) => {
      const selection =
        method === "text.generate-structured" && "modelSelection" in payload
          ? payload.modelSelection
          : undefined;
      if (!selection)
        return Effect.succeed([claude, codex] as AgentRuntimeOperations[typeof method]["output"]);
      attempts.push(selection);
      return selection.instanceId === claude.instanceId
        ? Effect.fail(new Error("Claude CLI request timed out."))
        : Effect.succeed({ title: "Repair expired login" } as never);
    };
    const input = {
      prompt: "Repair the login failure when the saved token expires",
      cwd: "/workspace",
      modelSelection: opus,
      modelPolicy: DEFAULT_MODEL_POLICY,
    };
    assert.equal(
      yield* generateSessionTitle({ request }, { ...input, writingModel: null }),
      "Repair expired login",
    );
    assert.deepEqual(attempts, [
      { instanceId: claude.instanceId, model: "claude-haiku" },
      { instanceId: codex.instanceId, model: "gpt-6-luna" },
    ]);
    attempts.length = 0;
    const chosen = { instanceId: claude.instanceId, model: "claude-haiku" };
    assert.equal(
      yield* generateSessionTitle(
        { request },
        { ...input, writingModel: chosen, nativeTitle: Effect.succeed("Native title") },
      ),
      "Native title",
    );
    assert.deepEqual(attempts, [chosen]);
  }),
);
