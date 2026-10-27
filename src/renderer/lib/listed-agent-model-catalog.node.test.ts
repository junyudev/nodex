import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentModelOption } from "../../shared/types";
import { catalogModel } from "./agent-model-catalog.test-fixtures";
import {
  listedModelCatalog,
  resolveReasoningEffortForModelChange,
} from "./listed-agent-model-catalog";

const withEfforts = (
  id: string,
  efforts: readonly string[],
  defaultReasoningEffort: string,
): AgentModelOption => ({
  ...catalogModel(id),
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: "",
  })),
  defaultReasoningEffort,
});

const codex = { kind: "codex", model: "a", reasoningEffort: "high", serviceTier: "fast" } as const;

describe("resolveReasoningEffortForModelChange", () => {
  const models = [
    withEfforts("keeps", ["medium", "high"], "medium"),
    withEfforts("defaults", ["low", "medium"], "medium"),
    withEfforts("prefers-high", ["low", "high", "xhigh"], "none"),
    withEfforts("first", ["low", "medium"], "none"),
  ];
  const next = (nextModelId: string, currentReasoningEffort = "xhigh") =>
    resolveReasoningEffortForModelChange({ currentReasoningEffort, nextModelId, models });

  it("keeps a supported effort, then tries the model default, High and the first level", () => {
    expect(next("keeps", "high")).toBe("high");
    expect(next("defaults")).toBe("medium");
    expect(next("prefers-high", "medium")).toBe("high");
    expect(next("first")).toBe("low");
  });

  it("offers the standard Codex levels for a model the list does not describe", () => {
    expect(next("unlisted", "medium")).toBe("medium");
  });
});

describe("listedModelCatalog", () => {
  it("lists the visible models for one Agent and selects the current one", () => {
    const models = [
      { ...catalogModel("gpt-5.3-codex-mini", "GPT-5.3 Codex-Mini") },
      { ...catalogModel("hidden"), hidden: true },
    ];
    const catalog = listedModelCatalog({
      binding: { kind: "codex" },
      label: "Codex",
      models,
      selection: { ...codex, model: "gpt-5.3-codex-mini" },
      onSelectionChange: () => {},
    });
    expect(catalog.entries.map((entry) => [entry.model.id, entry.model.displayName])).toEqual([
      ["gpt-5.3-codex-mini", "GPT-5.3 Codex Mini"],
    ]);
    expect(catalog.selected).toEqual({ binding: { kind: "codex" }, model: "gpt-5.3-codex-mini" });
    expect(catalog.refresh).toBeUndefined();
    expect(catalog.manage).toBeUndefined();
    expect(catalog.configOptions).toBeUndefined();
  });

  it("chooses a model with an effort it offers and keeps the other choices", async () => {
    const onSelectionChange = vi.fn();
    const models = [withEfforts("a", ["high"], "high"), withEfforts("b", ["low"], "low")];
    const catalog = listedModelCatalog({
      binding: { kind: "codex" },
      label: "Codex",
      models,
      selection: codex,
      onSelectionChange,
    });
    await catalog.choose({ binding: { kind: "codex" }, model: "b" });
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...codex, model: "b", reasoningEffort: "low" },
      "model",
    );
  });

  it("keeps a supported Claude effort and otherwise starts the next model at its default", async () => {
    const onSelectionChange = vi.fn();
    const binding = { kind: "claude", instanceConfigId: "work" } as const;
    const catalog = listedModelCatalog({
      binding,
      label: "Work",
      models: [withEfforts("opus", ["high", "max"], "high"), withEfforts("haiku", [], "default")],
      selection: { kind: "claude", model: "opus", reasoningEffort: "max", serviceTier: null },
      onSelectionChange,
    });
    expect(catalog.configOptions).toBeUndefined();
    await catalog.choose({ binding, model: "opus" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "opus", reasoningEffort: "max" }),
      "model",
    );
    await catalog.choose({ binding, model: "haiku" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "haiku", reasoningEffort: "default" }),
      "model",
    );
  });

  it("offers another Agent's advertised effort levels as its Effort option", async () => {
    const onSelectionChange = vi.fn();
    const binding = {
      kind: "acp",
      agentDefinitionId: "scripted-agent",
      instanceConfigId: "work",
    } as const;
    const selection = {
      kind: "acp",
      model: "deep",
      reasoningEffort: "default",
      serviceTier: null,
    } as const;
    const catalog = listedModelCatalog({
      binding,
      label: "Work",
      models: [withEfforts("deep", ["low", "high"], "low"), catalogModel("fast")],
      selection,
      onSelectionChange,
    });
    expect(catalog.configOptions).toMatchObject([
      {
        name: "Effort",
        type: "select",
        currentValue: "low",
        options: [{ value: "low" }, { value: "high" }],
      },
    ]);
    const [option] = catalog.configOptions ?? [];
    await catalog.changeConfig?.(option!.id, "high");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      { ...selection, reasoningEffort: "high" },
      "reasoningEffort",
    );
    // The owner fits "none" to the next model's advertised levels.
    await catalog.choose({ binding, model: "fast" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      { ...selection, model: "fast", reasoningEffort: "none" },
      "model",
    );
  });
});
