import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("compiles Ultracode at the selected effort for models that support it", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "low" },
          { id: "ultracode", value: true },
        ]),
      ),
    ).toMatchObject({ effort: "low", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "ultracode", value: true }]))
        .settings,
    ).not.toHaveProperty("ultracode");
  });

  it("treats a retired effort value as the model default without enabling Ultracode", () => {
    const compiled = compileClaudeModelSelection(
      selection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }]),
    );
    expect(compiled.effort).toBe("medium");
    expect(compiled.settings).not.toHaveProperty("ultracode");
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
