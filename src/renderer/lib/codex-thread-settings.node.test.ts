import { describe, expect, test } from "vite-plus/test";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  formatCodexThreadDetailLevelLabel,
  readCodexThreadSettings,
  resolveCodexModelSelection,
  resolveCodexReasoningEffortOptions,
  resolveCodexThreadDetailLevel,
  resolveCodexThreadSettings,
  THREAD_SETTINGS_STORAGE_KEY,
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
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
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
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

describe("codex-thread-settings", () => {
  test("preserves dynamic reasoning efforts and drops invalid closed settings fields", () => {
    const storageGlobal = globalThis as unknown as {
      localStorage?: {
        getItem: (key: string) => string | null;
        setItem: (key: string, value: string) => void;
        removeItem: (key: string) => void;
      };
    };
    const previousLocalStorage = storageGlobal.localStorage;
    const store = new Map<string, string>();
    storageGlobal.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };

    try {
      store.set(
        THREAD_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          model: " gpt-5.3-codex ",
          reasoningEffort: "future-effort",
          detailLevel: "invalid-detail-level",
        }),
      );

      const settings = readCodexThreadSettings();

      expect(settings?.model).toBe("gpt-5.3-codex");
      expect(settings?.reasoningEffort).toBe("future-effort");
      expect(settings?.detailLevel).toBe(undefined);
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
      } else {
        delete storageGlobal.localStorage;
      }
    }
  });

  test("defaults to the default model and its preferred reasoning effort", () => {
    const settings = resolveCodexThreadSettings(undefined, MODELS);

    expect(settings.model).toBe("gpt-5.3-codex");
    expect(settings.reasoningEffort).toBe("high");
  });

  test("omits a model fallback when the selector list is unavailable", () => {
    const settings = resolveCodexThreadSettings(
      {
        model: "gpt-5.2-codex",
        reasoningEffort: "medium",
      },
      [],
    );

    expect(settings.model).toBe("");
    expect(settings.reasoningEffort).toBe("medium");
  });

  test("falls back from unavailable stored models to the visible default", () => {
    const settings = resolveCodexThreadSettings(
      {
        model: "gpt-5.2-codex",
        reasoningEffort: "medium",
      },
      MODELS,
    );

    expect(settings.model).toBe("gpt-5.3-codex");
    expect(settings.reasoningEffort).toBe("medium");
  });

  test("resolves shared model selections from visible defaults", () => {
    const selection = resolveCodexModelSelection({
      model: "retired-model",
      reasoningEffort: "max",
      models: MODELS,
      fallbackReasoningEffort: "medium",
    });

    expect(selection.model).toBe("gpt-5.3-codex");
    expect(selection.reasoningEffort).toBe("high");
  });

  test("matches persisted model aliases against visible model entries", () => {
    const selection = resolveCodexModelSelection({
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      models: [
        ...MODELS,
        {
          id: "mini-id",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          description: "Alias row",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "minimal", description: "Minimal" },
            { reasoningEffort: "low", description: "Lower effort" },
          ],
          defaultReasoningEffort: "minimal",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        },
      ],
    });

    expect(selection.model).toBe("mini-id");
    expect(selection.reasoningEffort).toBe("minimal");
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
    expect(formatCodexModelLabel("gpt-5.3-codex", MODELS)).toBe("GPT-5.3 Codex");
    expect(formatCodexModelLabel(undefined, MODELS)).toBe("Default model");
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
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        },
      ]),
    ).toBe("GPT-5.1 Codex Max");
    expect(formatCodexModelLabel("gpt-6-astra", [])).toBe("GPT-6 Astra");
    expect(
      formatCodexModelLabel("gpt-6-astra", [
        { ...MODELS[0]!, id: "gpt-6-astra", displayName: "GPT-6-Astra" },
      ]),
    ).toBe("GPT-6 Astra");
    expect(formatCodexReasoningEffortLabel("max")).toBe("Max");
    expect(formatCodexReasoningEffortLabel("low")).toBe("Light");
    expect(formatCodexReasoningEffortLabel("xhigh")).toBe("Extra High");
    expect(formatCodexReasoningEffortLabel("future_effort")).toBe("Future Effort");
    expect(formatCodexThreadDetailLevelLabel("STEPS_EXECUTION")).toBe("Steps with code output");
    expect(resolveCodexThreadDetailLevel(undefined)).toBe("STEPS_COMMANDS");
  });

  test("defaults thread detail level to steps with code commands", () => {
    const settings = resolveCodexThreadSettings(undefined, MODELS);

    expect(settings.detailLevel).toBe("STEPS_COMMANDS");
  });

  test("preserves a stored thread detail level", () => {
    const settings = resolveCodexThreadSettings(
      {
        detailLevel: "STEPS_EXECUTION",
      },
      MODELS,
    );

    expect(settings.detailLevel).toBe("STEPS_EXECUTION");
  });
});
