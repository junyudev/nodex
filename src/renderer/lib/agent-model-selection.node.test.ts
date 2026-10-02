import { describe, expect, test } from "vite-plus/test";
import { agentBindingKey, agentModelKey, selectAgentCatalogModel } from "./agent-model-selection";
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
