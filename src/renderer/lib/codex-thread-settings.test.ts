import { describe, expect, test } from "bun:test";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  resolveCodexReasoningEffortOptions,
  resolveCodexThreadSettings,
} from "./codex-thread-settings";
import type { CodexModelOption } from "./types";

const MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3-Codex",
    description: "Default coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Lower effort" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep reasoning" },
    ],
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5-codex-mini",
    model: "gpt-5-codex-mini",
    displayName: "GPT-5-Codex Mini",
    description: "Fast small model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal", description: "Minimal" },
      { reasoningEffort: "low", description: "Lower effort" },
    ],
    defaultReasoningEffort: "minimal",
    isDefault: false,
  },
];

describe("codex-thread-settings", () => {
  test("defaults to the default model and its preferred reasoning effort", () => {
    const settings = resolveCodexThreadSettings(undefined, MODELS);

    expect(settings.model).toBe("gpt-5.3-codex");
    expect(settings.reasoningEffort).toBe("high");
  });

  test("clamps unsupported reasoning effort when the selected model changes", () => {
    const settings = resolveCodexThreadSettings(
      {
        model: "gpt-5-codex-mini",
        reasoningEffort: "high",
      },
      MODELS,
    );

    expect(settings.model).toBe("gpt-5-codex-mini");
    expect(settings.reasoningEffort).toBe("minimal");
  });

  test("resolves reasoning effort options from the selected model", () => {
    const options = resolveCodexReasoningEffortOptions("gpt-5-codex-mini", MODELS);

    expect(options.length).toBe(2);
    expect(options[0]?.reasoningEffort).toBe("minimal");
    expect(options[1]?.reasoningEffort).toBe("low");
  });

  test("formats fallback labels for the composer controls", () => {
    expect(formatCodexModelLabel("gpt-5.3-codex", MODELS)).toBe("GPT-5.3-Codex");
    expect(
      formatCodexModelLabel("gpt-5.1-codex-max", [
        ...MODELS,
        {
          id: "gpt-5.1-codex-max",
          model: "gpt-5.1-codex-max",
          displayName: "gpt-5.1-codex-max",
          description: "Alias missing from runtime",
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "high",
          isDefault: false,
        },
      ]),
    ).toBe("GPT-5.1-Codex-Max");
    expect(formatCodexReasoningEffortLabel("xhigh")).toBe("Extra High");
  });
});
