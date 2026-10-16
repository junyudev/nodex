import { describe, expect, test } from "vite-plus/test";
import {
  agentBindingKey,
  agentModelKey,
  agentRuntimeQualifier,
  selectAgentCatalogModel,
  visibleAgentModelPickerEntries,
} from "./agent-model-selection";
import { modelCatalog } from "./agent-model-catalog.test-fixtures";

const variant = {
  type: "select",
  id: "variant",
  name: "Variant",
  description: null,
  category: "thought_level",
  currentValue: "deep",
  options: [{ value: "deep", name: "Deep", description: null }],
} as const;
const memory = {
  type: "boolean",
  id: "memory",
  name: "Memory",
  description: null,
  category: null,
  currentValue: true,
} as const;

describe("runtime model choices", () => {
  test("keeps identical model IDs and ACP definition IDs distinct", () => {
    expect(agentModelKey({ kind: "opencode", instanceConfigId: "a" }, "model")).not.toBe(
      agentModelKey({ kind: "opencode", instanceConfigId: "b" }, "model"),
    );
    expect(
      agentBindingKey({ kind: "acp", instanceConfigId: null, agentDefinitionId: "a" }),
    ).not.toBe(agentBindingKey({ kind: "acp", instanceConfigId: null, agentDefinitionId: "b" }));
  });
  test("uses exact-model options, retaining only supported values and native mode IDs", () => {
    const catalog = modelCatalog({
      configOptions: [variant],
      modelConfigOptions: { "local/small": [memory] },
      modes: {
        currentModeId: "build",
        availableModes: [{ id: "build", name: "Build", description: null }],
      },
    });
    expect(
      selectAgentCatalogModel(catalog, "local/small", {
        binding: catalog.binding,
        model: "moonshot/kimi-k3",
        options: [
          { id: "variant", value: "deep" },
          { id: "memory", value: false },
        ],
        modeId: "removed",
      }),
    ).toEqual({
      binding: catalog.binding,
      model: "local/small",
      options: [{ id: "memory", value: false }],
      modeId: "build",
    });
    expect(
      selectAgentCatalogModel(catalog, "moonshot/kimi-k3", {
        binding: { kind: "opencode", instanceConfigId: "other" },
        model: "moonshot/kimi-k3",
        options: [
          { id: "variant", value: "deep" },
          { id: "memory", value: false },
        ],
      })?.options,
    ).toEqual([{ id: "variant", value: "deep" }]);
  });
  test("does not fabricate models or controls for an unavailable runtime", () => {
    const catalog = modelCatalog({
      health: { status: "authentication-required", error: "Sign in" },
    });
    expect(selectAgentCatalogModel(catalog, "moonshot/kimi-k3")).toBeNull();
    expect(selectAgentCatalogModel(modelCatalog(), "unknown")).toBeNull();
    expect(selectAgentCatalogModel(modelCatalog(), "local/small")?.options).toBeUndefined();
  });
});

describe("default picker models", () => {
  const local = { kind: "opencode", instanceConfigId: "local" } as const;
  const work = { kind: "opencode", instanceConfigId: "work" } as const;
  const choice = { binding: local, model: "moonshot/kimi-k3" } as const;
  const entries = [
    { binding: local, model: { id: "opencode/deepseek-v4.1-flash-free" } },
    { binding: local, model: { id: "opencode/glm-5.3-flash-free" } },
    { binding: local, model: { id: choice.model } },
    { binding: work, model: { id: choice.model } },
    { binding: local, model: { id: "opencode/free-preview" } },
    { binding: local, model: { id: "opencode/preview-free-paid" } },
    { binding: { kind: "codex" } as const, model: { id: "gpt-sol" } },
    { binding: { kind: "claude", instanceConfigId: "local" } as const, model: { id: "sonnet" } },
  ];

  test("matches the free suffix while preserving other backends and the exact selected instance", () => {
    expect(visibleAgentModelPickerEntries(entries, choice, false)).toEqual([
      entries[0],
      entries[1],
      entries[2],
      entries[6],
      entries[7],
    ]);
  });

  test("expanding returns the complete catalog without changing its entries", () => {
    expect(visibleAgentModelPickerEntries(entries, choice, true)).toEqual(entries);
  });

  test("does not invent entries for an empty catalog or unavailable selection", () => {
    expect(visibleAgentModelPickerEntries([], choice, false)).toEqual([]);
    expect(
      visibleAgentModelPickerEntries(entries, { binding: local, model: "unavailable" }, false),
    ).toEqual([entries[0], entries[1], entries[6], entries[7]]);
  });
});

describe("runtime qualifiers", () => {
  test("branded runtimes rely on their mark unless the instance label distinguishes them", () => {
    expect(agentRuntimeQualifier({ kind: "codex" }, "Codex")).toBeNull();
    const claude = { kind: "claude", instanceConfigId: "claude-default" } as const;
    expect(agentRuntimeQualifier(claude, "Claude Code")).toBeNull();
    expect(agentRuntimeQualifier(claude, " claude ")).toBeNull();
    expect(agentRuntimeQualifier(claude, "Work")).toBe("Work");
  });

  test("unbranded runtimes always name their instance", () => {
    const opencode = { kind: "opencode", instanceConfigId: "local" } as const;
    expect(agentRuntimeQualifier(opencode, "Local · Moonshot")).toBe("Local · Moonshot");
    expect(agentRuntimeQualifier(opencode, "Codex")).toBe("Codex");
    expect(agentRuntimeQualifier(opencode, "  ")).toBeNull();
  });
});
