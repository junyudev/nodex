import type { AgentCatalog } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import {
  agentChipLabel,
  atOfferedEffort,
  effectiveAgentChoice,
  offeredEfforts,
} from "./agent-choice";

const efforts = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];

const catalog: AgentCatalog = {
  providers: [
    {
      instanceId: "codex",
      label: "Codex",
      unavailableReason: null,
      models: [
        { id: "m1", label: "Model One", efforts, defaultEffort: "low" },
        { id: "plain", label: "Plain", efforts: [], defaultEffort: null },
      ],
    },
    {
      instanceId: "claude",
      label: "Claude",
      unavailableReason: "Sign in to use this Agent",
      models: [{ id: "m2", label: "Model Two", efforts: [], defaultEffort: null }],
    },
  ],
  defaultChoice: { providerInstanceId: "codex", model: "m1", reasoningEffort: "high" },
};

describe("effectiveAgentChoice", () => {
  it("uses the Host's default when the person chose nothing", () => {
    expect(effectiveAgentChoice(catalog, null)).toEqual(catalog.defaultChoice);
  });

  it("keeps the person's choice while it is offered", () => {
    const chosen = { providerInstanceId: "codex", model: "m1", reasoningEffort: "low" };
    expect(effectiveAgentChoice(catalog, chosen)).toBe(chosen);
  });

  it("falls back when the model is gone or the Agent can't run", () => {
    expect(
      effectiveAgentChoice(catalog, {
        providerInstanceId: "codex",
        model: "gone",
        reasoningEffort: null,
      }),
    ).toEqual(catalog.defaultChoice);
    expect(
      effectiveAgentChoice(catalog, {
        providerInstanceId: "claude",
        model: "m2",
        reasoningEffort: null,
      }),
    ).toEqual(catalog.defaultChoice);
  });

  it("keeps the remembered choice until the catalog has loaded", () => {
    const chosen = { providerInstanceId: "claude", model: "m2", reasoningEffort: "high" };
    expect(effectiveAgentChoice(null, chosen)).toBe(chosen);
  });

  it("runs a model chosen without an effort at the model's own, not the Host default's", () => {
    expect(
      effectiveAgentChoice(catalog, {
        providerInstanceId: "codex",
        model: "m1",
        reasoningEffort: null,
      }),
    ).toMatchObject({ model: "m1", reasoningEffort: "low" });
  });
});

describe("atOfferedEffort", () => {
  const choice = { providerInstanceId: "codex", model: "m1", reasoningEffort: "high" };

  it("prefers the effort picked here while the model offers it", () => {
    expect(atOfferedEffort(catalog, choice, "low").reasoningEffort).toBe("low");
    expect(atOfferedEffort(catalog, choice, "max")).toBe(choice);
  });

  it("falls back to the model's own for an effort it does not offer", () => {
    expect(atOfferedEffort(catalog, { ...choice, reasoningEffort: "max" }).reasoningEffort).toBe(
      "low",
    );
    expect(atOfferedEffort(catalog, { ...choice, model: "plain" }).reasoningEffort).toBeNull();
  });

  it("offers nothing to choose for a model the catalog does not name", () => {
    expect(offeredEfforts(catalog, { ...choice, model: "gone" })).toEqual([]);
    expect(offeredEfforts(catalog, choice)).toBe(efforts);
  });
});

describe("agentChipLabel", () => {
  it("names the model and its effort", () => {
    expect(agentChipLabel(catalog, null)).toBe("Model One · High");
  });

  it("names only a model that offers no effort", () => {
    expect(
      agentChipLabel(catalog, {
        providerInstanceId: "codex",
        model: "plain",
        reasoningEffort: null,
      }),
    ).toBe("Plain");
  });

  it("says Agent when nothing is known yet", () => {
    expect(agentChipLabel(null, null)).toBe("Agent");
  });

  it("shows a remembered model's id before the catalog loads", () => {
    expect(
      agentChipLabel(null, { providerInstanceId: "claude", model: "m2", reasoningEffort: null }),
    ).toBe("m2");
  });
});
