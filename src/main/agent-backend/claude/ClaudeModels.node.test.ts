import { describe, expect, test } from "vite-plus/test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeKnownThinkingTraits } from "../../../shared/claude-models";
import { claudeModelOptions } from "./ClaudeModels";

describe("Claude model identity", () => {
  test("only verified dated identities and context decorations inherit known thinking capability", () => {
    expect(claudeKnownThinkingTraits("claude-opus-5[1M]")).toEqual({
      disableThinking: true,
      disabledThinkingEfforts: ["low", "medium", "high"],
    });
    expect(claudeKnownThinkingTraits("claude-sonnet-4-5-20250929")).toEqual({
      disableThinking: true,
    });
    expect(claudeKnownThinkingTraits("claude-haiku-4-5@20251001")).toEqual({
      disableThinking: true,
    });
    expect(claudeKnownThinkingTraits("claude-sonnet-5-5[1M]")).toEqual({ disableThinking: false });
    expect(claudeKnownThinkingTraits("claude-sonnet-4-5-20991231")).toEqual({});
  });
  test("thinking Off is an exact capability of each native model", () => {
    const catalog: ModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "gateway/opaque",
        displayName: "Opaque",
        description: "",
        supportsAdaptiveThinking: true,
      },
    ];
    const options = claudeModelOptions(catalog);
    expect(options.map(({ value, disableThinking }) => ({ value, disableThinking }))).toEqual([
      { value: "claude-opus-5", disableThinking: true },
      { value: "claude-sonnet-5-5", disableThinking: false },
      { value: "gateway/opaque", disableThinking: undefined },
    ]);
  });
  test("configured opaque models declare their own traits while native overrides keep unspecified capabilities", () => {
    const native: ModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["high"],
        supportsFastMode: true,
      },
    ];
    const custom = [
      {
        id: "gateway/private",
        displayName: "Private",
        traits: {
          effortLevels: ["low", "max"] as ("low" | "max")[],
          adaptiveThinking: true,
          contextWindows: ["1m"],
        },
      },
      { id: "claude-opus-5", displayName: "Preferred", traits: {} },
    ];
    const options = claudeModelOptions(native, undefined, custom);
    expect(options.find(({ value }) => value === "claude-opus-5")).toMatchObject({
      name: "Preferred",
      reasoningEfforts: ["high"],
      fastMode: true,
    });
  });
  test("projects native effort capabilities without inventing support for unknown models", () => {
    const catalog: ModelInfo[] = [
      {
        value: "default",
        resolvedModel: "claude-opus-5",
        displayName: "Default",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "legacy",
        displayName: "Legacy",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: ["high"],
      },
    ];
    const models = claudeModelOptions(catalog, "gateway/private");
    expect(models[0]?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.reasoningEfforts).toEqual([]);
    expect(models[2]?.reasoningEfforts).toBeUndefined();
  });

  test("resolves CLI aliases to concrete IDs and deduplicates the default model", () => {
    const models = claudeModelOptions([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default",
        description: "Default",
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Balanced",
      },
      {
        value: "opus",
        resolvedModel: "gateway/private-opus",
        displayName: "Opus",
        description: "Gateway",
      },
    ]);
    expect(models).toEqual([
      {
        value: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        description: "Balanced",
        disableThinking: true,
      },
      { value: "gateway/private-opus", name: "gateway/private-opus", description: "Gateway" },
    ]);
  });

  test("retains context suffixes and plan-routing aliases", () => {
    const models = claudeModelOptions([
      {
        value: "sonnet[1m]",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet (1M)",
        description: "",
      },
      {
        value: "opusplan",
        resolvedModel: "claude-opus-5",
        displayName: "Opus Plan",
        description: "Opus for planning, Sonnet for execution",
      },
    ]);
    expect(models.map(({ value, name }) => ({ value, name }))).toEqual([
      { value: "claude-sonnet-5[1m]", name: "Claude Sonnet 5 [1m]" },
      { value: "opusplan", name: "Opus Plan" },
    ]);
  });

  test("does not invent versions for older CLIs and retains a previously selected model", () => {
    const models = claudeModelOptions(
      [{ value: "sonnet", displayName: "Sonnet", description: "Older CLI" }],
      "claude-haiku-4-5-20251001",
    );
    expect(models.map(({ value }) => value)).toEqual(["sonnet", "claude-haiku-4-5-20251001"]);
    expect(models.at(-1)?.name).toBe("Claude Haiku 4.5");
  });
});
