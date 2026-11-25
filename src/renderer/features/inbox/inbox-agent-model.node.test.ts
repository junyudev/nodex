import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_INBOX_AGENT_CHOICE,
  resolveInboxModel,
  type InboxAgentChoice,
} from "../../../shared/inbox";
import {
  chooseInboxChatOptions,
  chooseInboxModel,
  describeInboxAgent,
  inboxAgentLine,
  inboxAgentPickerModel,
  inboxAgentShortLine,
  pinInboxAgentChoice,
} from "./inbox-agent-model";
import {
  CLAUDE_INSTANCE,
  CLAUDE_INSTANCE_ID,
  claudeProvider,
  codexProvider,
  inboxAgentsFixture,
} from "./inbox-agents.test-support";

const codex = (overrides: Partial<InboxAgentChoice> = {}): InboxAgentChoice => ({
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

  test("fits a saved Ultrafast choice to Fast on a model offering priority", () => {
    const catalog = inboxAgentsFixture();
    const priorityCatalog = {
      ...catalog,
      providers: catalog.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({
          ...model,
          capabilities: model.capabilities && {
            ...model.capabilities,
            optionDescriptors: model.capabilities.optionDescriptors?.map((option) =>
              option.id === "serviceTier" && option.type === "select"
                ? {
                    ...option,
                    options: option.options.map((tier) =>
                      tier.id === "fast" ? { ...tier, id: "priority" } : tier,
                    ),
                  }
                : option,
            ),
          },
        })),
      })),
    };
    const chosen = codex({ reasoningEffort: "high", serviceTier: "ultrafast" });
    expect(inboxAgentLine(describeInboxAgent(priorityCatalog, chosen))).toBe(
      "Codex · GPT-6 Astra · High · Fast",
    );
    expect(inboxAgentPickerModel(priorityCatalog, chosen)).toMatchObject({
      serviceTier: "fast",
      serviceTierName: "Fast",
    });
    expect(
      chooseInboxModel(priorityCatalog, chosen, {
        binding: { driver: "codex", instanceId: "codex" },
        model: "gpt-6-astra",
      }).serviceTier,
    ).toBe("fast");
    const resolved = resolveInboxModel(priorityCatalog.providers, chosen, "chat");
    expect(resolved.kind === "ready" && resolved.selection.options).toContainEqual({
      id: "serviceTier",
      value: "priority",
    });
  });

  test("shows the catalog name when Ultrafast can run", () => {
    const provider = codexProvider();
    const catalog = inboxAgentsFixture({
      providers: [
        {
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            capabilities: {
              ...model.capabilities,
              optionDescriptors: model.capabilities?.optionDescriptors?.map((descriptor) =>
                descriptor.id === "serviceTier" && descriptor.type === "select"
                  ? {
                      ...descriptor,
                      options: [...descriptor.options, { id: "ultrafast", label: "Ultrafast" }],
                    }
                  : descriptor,
              ),
            },
          })),
        },
      ],
    });
    const shown = describeInboxAgent(catalog, codex({ serviceTier: "ultrafast" }));
    expect(shown).toMatchObject({ serviceTier: "ultrafast", serviceTierName: "Ultrafast" });
    expect(inboxAgentLine(shown)).toBe("Codex · GPT-6 Astra · Medium · Ultrafast");
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
    expect(shown.kind).toBe("claudeAgent");
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

  test("keeps checking an Agent whose first status check has not answered yet", () => {
    const settling = {
      ...codexProvider(),
      status: "error" as const,
      auth: { status: "unknown" as const },
      message: "Timed out while checking Codex app-server provider status.",
      models: [],
    };
    expect(
      describeInboxAgent(inboxAgentsFixture({ providers: [settling] }), codex()),
    ).toMatchObject({ status: "checking", agent: "Codex", detail: "Checking models…" });
  });

  test("suggestions default to their own economical model and steady effort until chosen", () => {
    const catalog = inboxAgentsFixture();
    const sol = {
      ...codexProvider().models[0]!,
      slug: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      isDefault: false,
    };
    const withSol = {
      ...catalog,
      providers: [{ ...codexProvider(), models: [...codexProvider().models, sol] }],
    };
    expect(inboxAgentLine(describeInboxAgent(withSol, codex(), "suggestion"))).toBe(
      "Codex · GPT-6.2 Sol · High",
    );
    expect(inboxAgentLine(describeInboxAgent(withSol, codex(), "chat"))).toBe(
      "Codex · GPT-6 Astra · Medium",
    );
    expect(
      inboxAgentLine(describeInboxAgent(withSol, codex({ reasoningEffort: "low" }), "suggestion")),
    ).toBe("Codex · GPT-6.2 Sol · Light");
  });

  test("suggestions on Claude default to Sonnet, and to the catalog default without it", () => {
    const sonnet = {
      ...claudeProvider().models[0]!,
      slug: "claude-sonnet-5-5",
      name: "Sonnet 5.5",
      isDefault: false,
    };
    const claude = codex({ instanceId: CLAUDE_INSTANCE_ID });
    const withSonnet = inboxAgentsFixture({
      providers: [{ ...claudeProvider(), models: [...claudeProvider().models, sonnet] }],
    });
    expect(inboxAgentShortLine(describeInboxAgent(withSonnet, claude, "suggestion"))).toBe(
      "Work · Sonnet 5.5 · High",
    );
    expect(inboxAgentShortLine(describeInboxAgent(withSonnet, claude, "chat"))).toBe(
      "Work · Opus 5.5 · High",
    );
    expect(
      inboxAgentShortLine(describeInboxAgent(inboxAgentsFixture(), claude, "suggestion")),
    ).toBe("Work · Opus 5.5 · High");
  });

  test("an effort the model does not offer runs at the model's own, as the Inbox says", () => {
    const catalog = inboxAgentsFixture();
    // Suggestions ask Claude for medium, which this Opus does not offer. Left unset, a utility
    // generation would pick its own effort while the Inbox showed the model's.
    const opus = codex({ instanceId: CLAUDE_INSTANCE_ID });
    const resolved = resolveInboxModel(catalog.providers, opus, "suggestion");
    expect(resolved.kind === "ready" && resolved.selection.options).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(inboxAgentLine(describeInboxAgent(catalog, opus, "suggestion"))).toBe(
      "Work · Opus 5.5 · High",
    );
  });
});

describe("choosing in the Inbox's model menu", () => {
  test("an effort set on Nodex's default keeps the model it runs on, so it stops following", () => {
    const catalog = inboxAgentsFixture();
    const suggestion = chooseInboxChatOptions(
      pinInboxAgentChoice(catalog, DEFAULT_INBOX_AGENT_CHOICE, "suggestion"),
      { reasoningEffort: "medium" },
    );
    expect(suggestion).toEqual(codex({ model: "gpt-6-astra", reasoningEffort: "medium" }));
    // A chosen choice is already the person's, and nothing to pin waits for the catalog.
    expect(pinInboxAgentChoice(catalog, codex(), "chat")).toEqual(codex());
    expect(
      pinInboxAgentChoice(
        inboxAgentsFixture({ providers: [] }),
        DEFAULT_INBOX_AGENT_CHOICE,
        "chat",
      ),
    ).toBe(DEFAULT_INBOX_AGENT_CHOICE);
  });

  test("reads a GPT model's version apart from its variant without renaming the model", () => {
    const sol = {
      ...codexProvider().models[0]!,
      slug: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      isDefault: false,
    };
    const catalog = inboxAgentsFixture({
      providers: [{ ...codexProvider(), models: [...codexProvider().models, sol] }],
    });
    const chosen = codex({ model: "gpt-6.1-sol" });
    expect(inboxAgentLine(describeInboxAgent(catalog, chosen))).toBe(
      "Codex · GPT-6.1 Sol · Medium",
    );
    const entry = inboxAgentPickerModel(catalog, chosen).entries.find(
      (candidate) => candidate.model.id === "gpt-6.1-sol",
    );
    expect(entry?.model.displayName).toBe("GPT-6.1 Sol");
    expect(entry?.selection).toEqual({
      binding: { driver: "codex", instanceId: "codex" },
      model: "gpt-6.1-sol",
    });
  });

  test("lists every configured Agent's models and marks the resolved default", () => {
    const picker = inboxAgentPickerModel(inboxAgentsFixture(), codex());
    expect(picker.entries.map((entry) => `${entry.label}:${entry.model.id}`)).toEqual([
      "Codex:gpt-6-astra",
      "Codex:gpt-6-luna",
      "Work:claude-opus-5-5",
    ]);
    expect(picker.selected).toEqual({
      binding: { driver: "codex", instanceId: "codex" },
      model: "gpt-6-astra",
    });
    expect(picker.reasoningEffort).toBe("medium");
  });

  test("offers suggestions only on Agents that can write them", () => {
    const binding = { driver: "opencode", instanceId: "work" } as const;
    const opencode = {
      ...codexProvider(),
      instanceId: binding.instanceId!,
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
      chooseInboxModel(catalog, chosen, {
        binding: { driver: "codex", instanceId: "codex" },
        model: "gpt-6-luna",
      }),
    ).toEqual(codex({ model: "gpt-6-luna" }));
  });
});
