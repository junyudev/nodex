import { expect, test, describe, it } from "vite-plus/test";
import {
  fitNativeSelection,
  nativeSelectionsMatch,
  resolveNativeIntelligenceSelection,
} from "./native-intelligence-selection";
import type { NodexModelPricing } from "../../shared/nodex-account";
import {
  formatNodexCreditPrice,
  hasNodexListPriceRow,
  nodexModelPriceRows,
  visibleNodexPriceColumns,
} from "./nodex-model-prices";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  agentRuntimeBinding,
  defaultAgentRuntimeModelSelection,
  requireAgentRuntimeModelSelection,
} from "./agent-runtime-model-selection";
import { agentRuntimeModelSelection } from "../../shared/agent-runtime-provider";
import { agentBindingKey, agentModelKey } from "./agent-model-selection";
import { AgentBackendBindingSchema } from "../../shared/schemas/agent-backend";

describe("native intelligence selection", () => {
  test("live native state never substitutes requested preferences for unobserved applied values", () => {
    expect(
      resolveNativeIntelligenceSelection(
        { model: "requested-model", effort: "high", fast: true, thinking: false },
        { model: null, effort: null, fast: null, thinking: null },
        false,
      ),
    ).toEqual({ model: "", effort: "default", fast: null, thinking: null });
  });

  test("draft inheritance uses resolved native state while explicit false choices remain explicit", () => {
    expect(
      resolveNativeIntelligenceSelection(
        { model: "default", effort: "default", fast: false, thinking: false },
        { model: "resolved-model", effort: "medium", fast: true, thinking: true },
        true,
      ),
    ).toEqual({ model: "resolved-model", effort: "medium", fast: false, thinking: false });
  });

  test("a different draft model does not borrow another model's default effort", () => {
    expect(
      resolveNativeIntelligenceSelection(
        { model: "next-model", effort: "default" },
        { model: "profile-model", effort: "high" },
        true,
      ),
    ).toMatchObject({ model: "next-model", effort: "default" });
  });

  test("live Context uses native model decoration while drafts preserve their unsent override", () => {
    const requested = { model: "default", effort: "default", context: "1m" } as const;
    const observed = { model: "gateway/private[200k]", effort: "high" };
    expect(resolveNativeIntelligenceSelection(requested, observed, false).context).toBe("200k");
    expect(resolveNativeIntelligenceSelection(requested, observed, true).context).toBe("1m");
    expect(
      resolveNativeIntelligenceSelection(requested, { model: null, effort: null }, false).context,
    ).toBeUndefined();
  });

  const capable = {
    value: "capable",
    name: "Capable",
    description: null,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    fastMode: true,
    adaptiveThinking: true,
    disableThinking: true,
    contextWindows: ["200k", "1m"],
  };
  const limited = {
    value: "limited",
    name: "Limited",
    description: null,
    reasoningEfforts: ["low", "medium", "high"],
    fastMode: false,
    adaptiveThinking: true,
    contextWindows: ["200k"],
  };

  test("preferences a model cannot honor are fitted for it and return on a capable model", () => {
    const intent = {
      model: "capable",
      effort: "max",
      fast: true,
      thinking: false,
      context: "1m",
    } as const;
    expect(fitNativeSelection({ ...intent, model: "limited" }, limited)).toEqual({
      model: "limited",
      effort: "high",
      fast: false,
    });
    expect(fitNativeSelection(intent, capable)).toEqual(intent);
  });

  test("effort falls back to the nearest lower advertised level, else the lowest, else the default", () => {
    const sparse = { ...limited, reasoningEfforts: ["medium", "xhigh"] };
    const fit = (effort: "low" | "high" | "max", target = sparse) =>
      fitNativeSelection({ model: target.value, effort }, target).effort;
    expect(fit("high")).toBe("medium");
    expect(fit("max")).toBe("xhigh");
    expect(fit("low")).toBe("medium");
    expect(fit("high", { ...limited, reasoningEfforts: [] })).toBe("default");
    expect(fitNativeSelection({ model: "limited", effort: "default" }, limited).effort).toBe(
      "default",
    );
  });

  test("thinking off bounds effort to the levels the model permits without thinking", () => {
    const bounded = { ...capable, disabledThinkingEfforts: ["low", "medium", "high"] };
    expect(
      fitNativeSelection({ model: "capable", effort: "max", thinking: false }, bounded),
    ).toMatchObject({ effort: "high", thinking: false });
  });

  test("an unknown model leaves intent for the runtime to resolve", () => {
    const intent = { model: "unlisted", effort: "max", fast: true } as const;
    expect(fitNativeSelection(intent, undefined)).toBe(intent);
  });

  test("an absent Fast override matches an explicit Fast off", () => {
    const selection = { model: "limited", effort: "high" } as const;
    expect(nativeSelectionsMatch(selection, { ...selection, fast: false })).toBe(true);
    expect(nativeSelectionsMatch(selection, { ...selection, fast: true })).toBe(false);
    expect(nativeSelectionsMatch(selection, { ...selection, effort: "low" })).toBe(false);
  });
});

describe("nodex model prices", () => {
  const LIST = { input: 5, cacheRead: 0.5, cacheWrite: null, output: 30 };
  const HALF = { input: 2.5, cacheRead: 0.25, cacheWrite: null, output: 15 };
  const CLAUDE = { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 };

  const offer = (
    id: string,
    reference: typeof LIST | typeof CLAUDE,
    effective = reference,
    multiplier: number | null = 1,
  ) => ({
    id,
    label: id,
    provider: "openai",
    reference,
    effective,
    multiplier,
  });
  const pricing = (...groups: NodexModelPricing["groups"]): NodexModelPricing => ({
    currency: "USD",
    perTokens: 1_000_000,
    notes: [],
    groups,
  });
  const group = (id: string, ...models: NodexModelPricing["groups"][number]["models"]) => ({
    id,
    label: id,
    description: null,
    available: true,
    models,
  });

  describe("nodexModelPriceRows", () => {
    it("leaves list-price rows unmarked and lets the header state ×1", () => {
      const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST))));
      expect(rows[0]?.rows[0]).toMatchObject({ multiplier: null, crossesOutReference: false });
      expect(hasNodexListPriceRow(rows)).toBe(true);
    });

    it("marks a rate on the only group and crosses out the list price nothing else shows", () => {
      const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST, HALF, 0.5))));
      expect(rows[0]?.rows[0]).toMatchObject({
        multiplier: 0.5,
        groupLabel: null,
        crossesOutReference: true,
      });
      expect(hasNodexListPriceRow(rows)).toBe(false);
    });

    it("names a separate group and spares the crossing out when a list row is right above", () => {
      const rows = nodexModelPriceRows(
        pricing(group("nodex", offer("sol", LIST)), group("saver", offer("sol", LIST, HALF, 0.5))),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rows).toMatchObject([
        { groupLabel: null, multiplier: null, crossesOutReference: false },
        { groupLabel: "saver", multiplier: 0.5, crossesOutReference: false },
      ]);
    });

    it("leaves out a model the server has no price for", () => {
      const unpriced = { input: null, cacheRead: null, cacheWrite: null, output: null };
      const rows = nodexModelPriceRows(
        pricing(
          group("nodex", offer("sol", LIST), { ...offer("luna", LIST), effective: unpriced }),
        ),
      );
      expect(rows.map(({ id }) => id)).toEqual(["sol"]);
    });

    it("claims no rate when no single factor explains the prices", () => {
      const uneven = { ...HALF, output: 30 };
      const rows = nodexModelPriceRows(pricing(group("nodex", offer("sol", LIST, uneven, null))));
      expect(rows[0]?.rows[0]).toMatchObject({ multiplier: null, crossesOutReference: true });
      // A crossed-out row isn't at list price, so the header makes no ×1 claim for it.
      expect(hasNodexListPriceRow(rows)).toBe(false);
    });
  });

  describe("visibleNodexPriceColumns", () => {
    it("drops a column no model has a price for", () => {
      const keys = (value: NodexModelPricing) =>
        visibleNodexPriceColumns(value).map(({ key }) => key);
      expect(keys(pricing(group("nodex", offer("sol", LIST))))).toEqual([
        "input",
        "cacheRead",
        "output",
      ]);
      expect(keys(pricing(group("nodex", offer("sol", LIST), offer("opus", CLAUDE))))).toEqual([
        "input",
        "cacheRead",
        "cacheWrite",
        "output",
      ]);
    });
  });

  describe("formatNodexCreditPrice", () => {
    it.each([
      [5, "125"],
      [0.5, "12.5"],
      [0.075, "1.88"],
      [30, "750"],
      [null, "—"],
    ])("formats %s USD at 25 credits per dollar as %s", (usd, expected) => {
      expect(formatNodexCreditPrice(usd, 25)).toBe(expected);
    });
  });
});

describe("nodex model selection", () => {
  const id = `nodex_codex_${"a".repeat(32)}`;
  const providers = [
    {
      instanceId: id,
      driver: "codex",
      source: "nodex",
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "gpt-6.1-sol", isDefault: true }],
    },
  ] as unknown as AgentRuntimeOperations["providers.read"]["output"];
  it("retains a managed Codex instance across picker keys, persistence and launch", () => {
    const binding = agentRuntimeBinding(providers[0]!);
    expect(AgentBackendBindingSchema.parse(binding)).toEqual(binding);
    expect(binding.instanceId).toBe(id);
    expect(agentBindingKey(binding)).not.toBe(
      agentBindingKey({ driver: "codex", instanceId: "codex" }),
    );
    expect(agentModelKey(binding, "gpt-6.1-sol")).not.toBe(
      agentModelKey({ driver: "codex", instanceId: "codex" }, "gpt-6.1-sol"),
    );
    expect(agentRuntimeModelSelection(binding, "gpt-6.1-sol")).toEqual({
      instanceId: id,
      model: "gpt-6.1-sol",
    });
  });
  it("retains a managed Claude instance while native configurations keep their own keys", () => {
    const instance = `nodex_claude_${"b".repeat(32)}`;
    const binding = agentRuntimeBinding({ driver: "claudeAgent", instanceId: instance });
    expect(binding.driver).toBe("claudeAgent");
    expect(binding.instanceId).toBe(instance);
    expect("local").not.toBe(instance);
  });
  it("never automatically selects prepaid models", () => {
    expect(defaultAgentRuntimeModelSelection(providers)).toBeNull();
    const native = { ...providers[0]!, source: undefined, instanceId: "codex" };
    expect(
      defaultAgentRuntimeModelSelection([providers[0]!, native] as typeof providers)?.instanceId,
    ).toBe("codex");
  });
  it("refuses unlisted models and retired instances without falling back", () => {
    expect(() =>
      requireAgentRuntimeModelSelection(providers, { instanceId: id, model: "unapproved" }),
    ).toThrow(/unavailable/u);
    expect(() =>
      requireAgentRuntimeModelSelection([], { instanceId: id, model: "gpt-6.1-sol" }),
    ).toThrow(/unavailable/u);
  });
});
