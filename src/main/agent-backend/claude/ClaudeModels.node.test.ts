import { describe, expect, test } from "vite-plus/test";
import type { ModelInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeHistoryModel, claudeModelOptions, claudeSessionConfigOptions } from "./ClaudeModels";

describe("Claude model identity", () => {
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
    expect(models[1]?.reasoningEfforts).toEqual(models[0]?.reasoningEfforts);
    expect(models[2]?.reasoningEfforts).toBeUndefined();
    expect(models[3]?.reasoningEfforts).toBeUndefined();
    const config = claudeSessionConfigOptions(catalog, "default", "max");
    expect(config.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "max",
      options: [
        { value: "default" },
        { value: "low" },
        { value: "medium" },
        { value: "high" },
        { value: "xhigh" },
        { value: "max" },
      ],
    });
    expect(claudeSessionConfigOptions(catalog, "legacy", "max")[1]).toMatchObject({
      currentValue: "default",
      options: [{ value: "default" }],
    });
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
      { value: "default", name: "Claude Sonnet 5 (default)", description: "claude-sonnet-5" },
      { value: "claude-sonnet-5", name: "Claude Sonnet 5", description: "Balanced" },
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
    expect(models.slice(1).map(({ value, name }) => ({ value, name }))).toEqual([
      { value: "claude-sonnet-5[1m]", name: "Claude Sonnet 5 [1m]" },
      { value: "opusplan", name: "Opus Plan" },
    ]);
  });

  test("does not invent versions for older CLIs and retains a previously selected model", () => {
    const models = claudeModelOptions(
      [{ value: "sonnet", displayName: "Sonnet", description: "Older CLI" }],
      "claude-haiku-4-5-20251001",
    );
    expect(models.map(({ value }) => value)).toEqual([
      "default",
      "sonnet",
      "claude-haiku-4-5-20251001",
    ]);
    expect(models.at(-1)?.name).toBe("Claude Haiku 4.5");
  });

  test("restores the last real main-thread model, skipping subagents and synthetic errors", () => {
    const message = (model: unknown, fields: Partial<SessionMessage> = {}): SessionMessage => ({
      type: "assistant",
      uuid: "message",
      session_id: "session",
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { model },
      ...fields,
    });
    expect(
      claudeHistoryModel([
        message("claude-sonnet-5"),
        message("gateway/private"),
        message("claude-haiku-4-5", { parent_agent_id: "subagent" }),
        message("<synthetic>"),
        message(null),
      ]),
    ).toBe("gateway/private");
    expect(claudeHistoryModel([message("<synthetic>")])).toBeUndefined();
  });
});
