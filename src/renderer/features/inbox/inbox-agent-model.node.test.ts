import { describe, expect, test } from "vite-plus/test";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { resolveInboxModel, type InboxChatAgent } from "../../../shared/inbox";
import {
  chooseInboxModel,
  describeInboxAgent,
  inboxAgentLine,
  inboxAgentPickerModel,
  inboxAgentShortLine,
} from "./inbox-agent-model";
import {
  CLAUDE_INSTANCE,
  CLAUDE_INSTANCE_ID,
  codexProvider,
  inboxAgentsFixture,
} from "./inbox-agents.test-support";

const codex = (overrides: Partial<InboxChatAgent> = {}): InboxChatAgent => ({
  instanceId: "codex",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  ...overrides,
});

describe("what an Inbox chat runs on", () => {
  test("names the Agent, the catalog default model and that model's own effort", () => {
    const catalog = inboxAgentsFixture();
    const shown = describeInboxAgent(catalog, codex());
    expect(inboxAgentLine(shown)).toBe("Codex · GPT-6 Astra · Medium");
    // Exactly what Main freezes from the same catalog: no options, so the model's defaults apply.
    const resolved = resolveInboxModel(catalog.providers, codex(), "chat");
    expect(resolved.kind === "ready" && resolved.selection).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
    });
  });

  test("shows a chosen effort and speed only where the model offers them", () => {
    const catalog = inboxAgentsFixture();
    const chosen = codex({ reasoningEffort: "high", serviceTier: "fast" });
    expect(inboxAgentLine(describeInboxAgent(catalog, chosen))).toBe(
      "Codex · GPT-6 Astra · High · Fast",
    );
    const resolved = resolveInboxModel(catalog.providers, chosen, "chat");
    expect(resolved.kind === "ready" && resolved.selection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ]);
    // The light model offers neither, so it runs at its own defaults.
    const light = { ...chosen, model: "gpt-6-luna" };
    expect(inboxAgentLine(describeInboxAgent(catalog, light))).toBe("Codex · GPT-6 Luna");
  });

  test("names the Agent beside its mark only when the name says more", () => {
    const catalog = inboxAgentsFixture();
    expect(inboxAgentShortLine(describeInboxAgent(catalog, codex()))).toBe("GPT-6 Astra · Medium");
    expect(
      inboxAgentShortLine(describeInboxAgent(catalog, codex({ instanceId: CLAUDE_INSTANCE_ID }))),
    ).toBe("Work · Opus 5.5 · High");
    expect(inboxAgentShortLine(describeInboxAgent(catalog, codex({ model: "retired" })))).toBe(
      "Codex · Model unavailable",
    );
  });

  test("names a configured Claude account and its effort", () => {
    const catalog = inboxAgentsFixture();
    const shown = describeInboxAgent(catalog, codex({ instanceId: CLAUDE_INSTANCE_ID }));
    expect(shown.kind).toBe("claude");
    expect(inboxAgentLine(shown)).toBe("Work · Opus 5.5 · High");
  });

  test("says when the choice cannot run instead of naming another model", () => {
    const catalog = inboxAgentsFixture();
    expect(describeInboxAgent(catalog, codex({ model: "retired-model" }))).toMatchObject({
      status: "unavailable",
      agent: "Codex",
      detail: "Model unavailable",
    });
    expect(
      describeInboxAgent(
        inboxAgentsFixture({ providers: [{ ...codexProvider(), enabled: false }] }),
        codex(),
      ),
    ).toMatchObject({ status: "unavailable", detail: "Unavailable" });
  });

  test("waits for a first catalog read without declaring the choice unavailable", () => {
    const shown = describeInboxAgent(
      inboxAgentsFixture({ state: "loading", providers: [] }),
      codex(),
    );
    expect(shown).toMatchObject({ status: "checking", agent: "Codex", detail: "Loading…" });
  });

  test("shows suggestions on their own economical model and effort, which no chat choice moves", () => {
    const catalog = inboxAgentsFixture();
    const sol = {
      ...codexProvider().models[0]!,
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      isDefault: false,
    };
    const withSol = {
      ...catalog,
      providers: [{ ...codexProvider(), models: [...codexProvider().models, sol] }],
    };
    const chosen = codex({ reasoningEffort: "high" });
    expect(inboxAgentLine(describeInboxAgent(withSol, chosen, "suggestion"))).toBe(
      "Codex · GPT-6.1 Sol · High",
    );
    expect(inboxAgentLine(describeInboxAgent(withSol, chosen, "chat"))).toBe(
      "Codex · GPT-6 Astra · High",
    );
  });
});

describe("choosing in the Inbox's model menu", () => {
  test("lists every configured Agent's models and marks the resolved default", () => {
    const picker = inboxAgentPickerModel(inboxAgentsFixture(), codex());
    expect(picker.entries.map((entry) => `${entry.label}:${entry.model.id}`)).toEqual([
      "Codex:gpt-6-astra",
      "Codex:gpt-6-luna",
      "Work:claude-opus-5-5",
    ]);
    expect(picker.selected).toEqual({ binding: { kind: "codex" }, model: "gpt-6-astra" });
    expect(picker.reasoningEffort).toBe("medium");
  });

  test("offers suggestions only on Agents that can write them", () => {
    const binding = { kind: "opencode", instanceConfigId: "work" } as const;
    const opencode = {
      ...codexProvider(),
      instanceId: agentRuntimeProviderId(binding)!,
      driver: "opencode",
      displayName: "OpenCode",
    };
    const catalog = inboxAgentsFixture({
      providers: [codexProvider(), opencode],
      instances: [{ binding, label: "OpenCode" }],
    });
    const labels = (purpose: "chat" | "suggestion") =>
      new Set(inboxAgentPickerModel(catalog, codex(), purpose).entries.map((entry) => entry.label));
    expect(labels("suggestion")).toEqual(new Set(["Codex"]));
    expect(labels("chat")).toEqual(new Set(["Codex", "OpenCode"]));
  });

  test("keeps the effort and speed the next model also offers and drops the rest", () => {
    const catalog = inboxAgentsFixture();
    const chosen = codex({ reasoningEffort: "high", serviceTier: "fast" });
    expect(
      chooseInboxModel(catalog, chosen, { binding: CLAUDE_INSTANCE, model: "claude-opus-5-5" }),
    ).toEqual({
      instanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      serviceTier: null,
    });
    expect(
      chooseInboxModel(catalog, chosen, { binding: { kind: "codex" }, model: "gpt-6-luna" }),
    ).toEqual(codex({ model: "gpt-6-luna" }));
  });
});
