import { describe, expect, test } from "vite-plus/test";
import {
  parseCodexDynamicCreateThreadInput,
  projectCodexDynamicCreateModel,
  validateCodexDynamicCreateModelReasoning,
} from "./codex-dynamic-thread-create";

describe("Codex dynamic create-thread contract", () => {
  test("preserves accepted scalar whitespace and validates every exact target branch", () => {
    expect(
      JSON.stringify(
        parseCodexDynamicCreateThreadInput({
          prompt: "  delegated prompt  ",
          target: {
            type: "project",
            projectId: " project-id ",
            environment: {
              type: "worktree",
              startingState: { type: "branch", branchName: " feature/exact " },
            },
          },
          model: " gpt-exact ",
          thinking: "ultra",
        }),
      ),
    ).toBe(
      JSON.stringify({
        prompt: "  delegated prompt  ",
        target: {
          type: "project",
          projectId: " project-id ",
          environment: {
            type: "worktree",
            startingState: { type: "branch", branchName: " feature/exact " },
          },
        },
        model: " gpt-exact ",
        thinking: "ultra",
      }),
    );

    expect(
      JSON.stringify(
        parseCodexDynamicCreateThreadInput({
          prompt: "projectless",
          target: { type: "projectless", directoryName: " Deliverables " },
          thinking: "none",
        }),
      ),
    ).toBe(
      JSON.stringify({
        prompt: "projectless",
        target: { type: "projectless", directoryName: " Deliverables " },
        thinking: "none",
      }),
    );
  });

  test("rejects empty scalars, invalid environments, starting states, and efforts", () => {
    expect(
      parseCodexDynamicCreateThreadInput({ prompt: "", target: { type: "projectless" } }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: { type: "project", projectId: "p", environment: { type: "cloud" } },
      }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: {
          type: "project",
          projectId: "p",
          environment: { type: "worktree", startingState: { type: "branch", branchName: "" } },
        },
      }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: { type: "projectless" },
        thinking: "extreme",
      }),
    ).toBe(null);
  });

  test("projects exact model-only and thinking-only launch settings", () => {
    expect(JSON.stringify(projectCodexDynamicCreateModel("gpt-exact", undefined))).toBe(
      JSON.stringify({
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-exact",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        configOverrides: null,
      }),
    );
    expect(JSON.stringify(projectCodexDynamicCreateModel(undefined, "max"))).toBe(
      JSON.stringify({
        collaborationMode: null,
        configOverrides: { model_reasoning_effort: "max" },
      }),
    );
  });

  test("returns the exact unsupported model/reasoning diagnostics", () => {
    const models = [
      {
        id: "gpt-exact",
        model: "gpt-exact",
        displayName: "Exact",
        description: "",
        modelSpecialty: null,
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium" as const,
        supportedReasoningEfforts: [{ reasoningEffort: "high" as const, description: "" }],
        inputModalities: ["text" as const],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
      },
    ];
    expect(validateCodexDynamicCreateModelReasoning("gpt-exact", "high", models)).toBe(null);
    expect(validateCodexDynamicCreateModelReasoning("gpt-exact", "low", models)).toBe(
      'create_thread rejected unsupported model/reasoning combination: "gpt-exact" does not support "low". Supported reasoning efforts: high.',
    );
    expect(validateCodexDynamicCreateModelReasoning("missing", "low", models)).toBe(
      'create_thread could not validate reasoning effort "low" for model "missing". Use a model and reasoning combination listed in the tool description, or omit thinking.',
    );
  });
});
