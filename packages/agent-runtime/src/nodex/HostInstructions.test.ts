import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ORCHESTRATION_INSTRUCTIONS } from "./Instructions.ts";
import { t3AcpPromptWithInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

it.effect("sends admitted host context through Codex's trusted instruction channels", () =>
  Effect.gen(function* () {
    const params = yield* buildCodexTurnStartParams({
      nativeThreadId: "native:test",
      codexInput: [{ type: "text", text: "Help with this Page." }],
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      hasT3Mcp: true,
      browserToolsAvailable: false,
      deviceToolsAvailable: false,
      hostInstructions: "The admitted CLI context is ready.",
      hostOrchestrationInstructions: ORCHESTRATION_INSTRUCTIONS,
    });
    expect(params.additionalContext?.nodex_host).toEqual({
      kind: "application",
      value: "The admitted CLI context is ready.",
    });
    expect(params.additionalContext?.t3_code_orchestration).toEqual({
      kind: "application",
      value: ORCHESTRATION_INSTRUCTIONS,
    });
    expect(params.additionalContext?.t3_code_tools).toBeUndefined();
  }),
);

it("sends admitted host context with Claude's system preset", () => {
  const options = makeClaudeQueryOptions({
    nativeThreadId: "native:test",
    resume: false,
    cwd: "/workspace",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-4-6",
    },
    mcpServers: {},
    hostInstructions: "The admitted CLI context is ready.",
    hostOrchestrationInstructions: ORCHESTRATION_INSTRUCTIONS,
  });
  expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
  const prompt =
    typeof options.systemPrompt === "object" &&
    !Array.isArray(options.systemPrompt) &&
    options.systemPrompt?.type === "preset"
      ? options.systemPrompt.append
      : undefined;
  expect(prompt).toContain(ORCHESTRATION_INSTRUCTIONS);
  expect(prompt).toContain("The admitted CLI context is ready.");
});

it("refreshes admitted ACP context on each Turn while preserving native slash commands", () => {
  const state = { interactionMode: "default", hasT3Mcp: true } as const;
  const prepared = {
    prompt: "Inspect the Page.",
    state,
    previousState: state,
    hostInstructions: "Use the current admitted Page and CLI tools.",
    hostOrchestrationInstructions: ORCHESTRATION_INSTRUCTIONS,
  };
  const prompt = t3AcpPromptWithInstructions(prepared);
  expect(prompt).toContain(prepared.hostInstructions);
  expect(prompt).toContain(ORCHESTRATION_INSTRUCTIONS);
  expect(prompt).toContain("<user_request>\nInspect the Page.\n</user_request>");
  expect(prompt).not.toContain("T3 Code collaborative browser");
  expect(t3AcpPromptWithInstructions({ ...prepared, prompt: "/compact" })).toBe("/compact");
});

it("enforces custom Claude thinking constraints and validated context suffixes at execution", () => {
  const settings = Schema.decodeUnknownSync(ClaudeSettings)({
    customModels: [
      {
        slug: "custom-model",
        capabilities: {
          optionDescriptors: [
            {
              type: "select",
              id: "effort",
              label: "Effort",
              options: [
                { id: "high", label: "High" },
                { id: "max", label: "Max" },
              ],
            },
            { type: "boolean", id: "thinking", label: "Thinking" },
            {
              type: "select",
              id: "contextWindow",
              label: "Context",
              options: [{ id: "1m", label: "1M" }],
            },
          ],
        },
      },
    ],
    modelTraits: {
      "custom-model": {
        disableThinking: true,
        disabledThinkingEfforts: ["high"],
        contextWindows: ["1m"],
      },
    },
  });
  const selection = {
    instanceId: ProviderInstanceId.make("claude-custom"),
    model: "custom-model",
    options: [
      { id: "effort", value: "max" },
      { id: "thinking", value: false },
      { id: "contextWindow", value: "1m" },
    ],
  };
  const options = makeClaudeQueryOptions({
    nativeThreadId: "custom-thread",
    resume: false,
    cwd: "/workspace",
    modelSelection: selection,
    settings,
  });
  expect(options.model).toBe("custom-model[1m]");
  expect(options.effort).toBe("high");
  expect(options.settings).toMatchObject({ alwaysThinkingEnabled: false });
  expect(options.thinking).toBeUndefined();
  const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, settings.customModels);
  const required = compileClaudeModelSelection(selection, catalog, {
    "custom-model": { disableThinking: false },
  });
  expect(required.settings.alwaysThinkingEnabled).toBe(true);
  const invalidContext = compileClaudeModelSelection(
    { ...selection, options: [{ id: "contextWindow", value: "9m" }] },
    catalog,
    settings.modelTraits,
  );
  expect(invalidContext.apiModelId).toBe("custom-model");
});
