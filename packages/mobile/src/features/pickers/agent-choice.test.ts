import type { AgentCatalog } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import { agentChipLabel, effectiveAgentChoice } from "./agent-choice";

const catalog: AgentCatalog = {
  providers: [
    {
      instanceId: "codex",
      label: "Codex",
      unavailableReason: null,
      models: [{ id: "m1", label: "Model One" }],
    },
    {
      instanceId: "claude",
      label: "Claude",
      unavailableReason: "Sign in to use this Agent",
      models: [{ id: "m2", label: "Model Two" }],
    },
  ],
  defaultChoice: { providerInstanceId: "codex", model: "m1" },
};

describe("effectiveAgentChoice", () => {
  it("uses the Host's default when the person chose nothing", () => {
    expect(effectiveAgentChoice(catalog, null)).toEqual(catalog.defaultChoice);
  });

  it("keeps the person's choice while it is offered", () => {
    const chosen = { providerInstanceId: "codex", model: "m1" };
    expect(effectiveAgentChoice(catalog, chosen)).toBe(chosen);
  });

  it("falls back when the model is gone or the Agent can't run", () => {
    expect(effectiveAgentChoice(catalog, { providerInstanceId: "codex", model: "gone" })).toEqual(
      catalog.defaultChoice,
    );
    expect(effectiveAgentChoice(catalog, { providerInstanceId: "claude", model: "m2" })).toEqual(
      catalog.defaultChoice,
    );
  });

  it("keeps the remembered choice until the catalog has loaded", () => {
    const chosen = { providerInstanceId: "claude", model: "m2" };
    expect(effectiveAgentChoice(null, chosen)).toBe(chosen);
  });
});

describe("agentChipLabel", () => {
  it("names the model", () => {
    expect(agentChipLabel(catalog, null)).toBe("Model One");
  });

  it("says Agent when nothing is known yet", () => {
    expect(agentChipLabel(null, null)).toBe("Agent");
  });

  it("shows a remembered model's id before the catalog loads", () => {
    expect(agentChipLabel(null, { providerInstanceId: "claude", model: "m2" })).toBe("m2");
  });
});
