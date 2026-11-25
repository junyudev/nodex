import { describe, expect, test, it } from "vite-plus/test";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  agentRuntimeModelOptionMemoryAtom,
  agentRuntimeNewChatChoiceAtom,
  newChatChoiceStorageKey,
  rememberAgentModelOptions,
  rememberedAgentModelOptions,
  withAgentRuntimeComposerChoice,
} from "./agent-runtime-composer-choices";
import {
  applyRuntimeClaudeIntent,
  readRuntimeClaudeSelection,
  resolveRuntimeClaudeIntent,
  runtimeClaudeModelOption,
} from "./agent-runtime-model-intent";
import type { AgentRuntimeProvider } from "./agent-runtime-conversation-adapter";

describe("agent runtime composer choices", () => {
  const codex = { driver: "codex" as const, instanceId: "codex" };
  const claude = { driver: "claudeAgent" as const, instanceId: "work" };

  describe("Agent Runtime Composer choices", () => {
    test("keeps one choice per Composer, drops emptied ones and retains the newest", () => {
      const chat = agentRuntimeChoiceKey.chat("thread");
      const draft = agentRuntimeChoiceKey.draft("session", "project");
      const chosen = withAgentRuntimeComposerChoice({}, chat, {
        selection: { binding: claude, model: "sonnet" },
      });
      const both = withAgentRuntimeComposerChoice(chosen, draft, { interactionMode: "plan" });
      expect(both[chat]).toBe(chosen[chat]);
      expect(withAgentRuntimeComposerChoice(both, chat, { selection: undefined })).toEqual({
        [draft]: { interactionMode: "plan" },
      });
      let many = both;
      for (let index = 0; index < 300; index++)
        many = withAgentRuntimeComposerChoice(many, agentRuntimeChoiceKey.chat(`t${index}`), {
          interactionMode: "default",
        });
      expect(Object.keys(many)).toHaveLength(256);
      expect(many[agentRuntimeChoiceKey.chat("t299")]).toBeDefined();
      expect(many[chat]).toBeUndefined();
    });

    test("remembers each Agent model's last options separately", () => {
      const high = [{ id: "reasoningEffort", value: "high" }];
      let memory = rememberAgentModelOptions({}, { binding: codex, model: "gpt", options: high });
      memory = rememberAgentModelOptions(memory, { binding: claude, model: "sonnet" });
      expect(rememberedAgentModelOptions(memory, { binding: codex, model: "gpt" })).toEqual(high);
      expect(rememberedAgentModelOptions(memory, { binding: claude, model: "sonnet" })).toEqual([]);
      expect(
        rememberedAgentModelOptions(memory, { binding: codex, model: "mini" }),
      ).toBeUndefined();
    });

    test("restores every stored entry that still decodes", () => {
      const valid = { selection: { binding: codex, model: "gpt" } };
      expect(
        agentRuntimeComposerChoicesAtom.decode({
          good: valid,
          stale: { selection: { binding: { kind: "retired" }, model: "x" } },
        }),
      ).toEqual({ good: valid });
      expect(agentRuntimeComposerChoicesAtom.decode([valid])).toEqual({});
      expect(
        agentRuntimeModelOptionMemoryAtom.decode({
          codex: { gpt: [{ id: "reasoningEffort", value: "high" }], broken: "high" },
        }),
      ).toEqual({ codex: { gpt: [{ id: "reasoningEffort", value: "high" }] } });
    });

    test("restores a legacy hosted draft with its exact Runtime instance", () => {
      const runtimeInstanceId = "hosted_claude";
      expect(
        agentRuntimeComposerChoicesAtom.decode({
          chat: {
            selection: {
              binding: { kind: "claude", instanceConfigId: "original-profile", runtimeInstanceId },
              model: "sonnet",
            },
          },
        }),
      ).toEqual({
        chat: {
          selection: {
            binding: { driver: "claudeAgent", instanceId: runtimeInstanceId },
            model: "sonnet",
          },
        },
      });
    });

    test("each team Space remembers its own new chat choice; the personal Space keeps its own", () => {
      const team = (spaceId: string) => ({ kind: "team" as const, spaceId, memberId: "alice" });
      expect(
        newChatChoiceStorageKey({ kind: "personal", spaceId: "personal", memberId: null }),
      ).toBe("agent-runtime-new-chat-choice-v1");
      expect(newChatChoiceStorageKey(team("acme"))).toBe(
        JSON.stringify(["space", "acme", "alice", "agent-runtime-new-chat-choice-v1"]),
      );
      expect(newChatChoiceStorageKey(team("acme"))).not.toBe(newChatChoiceStorageKey(team("labs")));
      // A window's Space is fixed for its lifetime, so it keeps one definition.
      expect(agentRuntimeNewChatChoiceAtom()).toBe(agentRuntimeNewChatChoiceAtom());
    });

    test("forgets a remembered new chat choice only when it no longer decodes", () => {
      const remembered = {
        binding: claude,
        model: "sonnet",
        options: [{ id: "effort", value: "max" }],
      };
      expect(agentRuntimeNewChatChoiceAtom().decode(remembered)).toEqual(remembered);
      expect(
        agentRuntimeNewChatChoiceAtom().decode({ binding: { kind: "retired" }, model: "x" }),
      ).toBe(null);
      expect(agentRuntimeNewChatChoiceAtom().decode(null)).toBe(null);
    });
  });
});

describe("agent runtime model intent", () => {
  const binding = { driver: "claudeAgent" as const, instanceId: "claude" };
  const model = (slug: string, full: boolean): AgentRuntimeProvider["models"][number] => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: (full ? ["low", "medium", "high", "max"] : ["low", "medium"]).map((id) => ({
            id,
            label: id,
          })),
        },
        ...(full
          ? [
              { id: "fastMode", label: "Speed", type: "boolean" as const },
              { id: "ultracode", label: "Ultracode", type: "boolean" as const },
              { id: "thinking", label: "Thinking", type: "boolean" as const },
              {
                id: "contextWindow",
                label: "Context",
                type: "select" as const,
                options: [{ id: "1m", label: "1M" }],
              },
            ]
          : []),
      ],
    },
  });

  it("fits one model without destroying the intent restored on a later model switch", () => {
    const intent = {
      model: "full",
      effort: "max" as const,
      fast: true,
      thinking: false,
      context: "1m",
    };
    const bounded = applyRuntimeClaudeIntent(
      { binding, model: "small" },
      { ...intent, model: "small" },
      model("small", false),
    );
    expect(readRuntimeClaudeSelection(bounded)).toEqual({
      model: "small",
      effort: "medium",
      fast: false,
    });
    const retained = resolveRuntimeClaudeIntent(
      bounded,
      { ...intent, model: "small" },
      model("small", false),
    );
    const restored = applyRuntimeClaudeIntent(
      { binding, model: "full" },
      { ...retained, model: "full" },
      model("full", true),
    );
    expect(readRuntimeClaudeSelection(restored)).toEqual(intent);
  });

  it("accepts an external execution selection when old intent no longer explains it", () => {
    const applied = {
      binding,
      model: "full",
      options: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: false },
      ],
    };
    expect(
      resolveRuntimeClaudeIntent(
        applied,
        { model: "full", effort: "max", fast: true },
        model("full", true),
      ),
    ).toEqual({ model: "full", effort: "low", fast: false });
  });

  it("keeps unknown model intent for native resolution and preserves independent supported options", () => {
    const selection = {
      binding,
      model: "custom",
      options: [{ id: "independent", value: "chosen" }],
    };
    expect(
      applyRuntimeClaudeIntent(
        selection,
        { model: "custom", effort: "high", thinking: false },
        undefined,
      ).options,
    ).toEqual([
      { id: "independent", value: "chosen" },
      { id: "effort", value: "high" },
      { id: "thinking", value: false },
    ]);
  });

  it("carries Ultracode at any effort and keeps it for a model switch back", () => {
    const intent = { model: "full", effort: "low" as const, ultracode: true };
    const applied = applyRuntimeClaudeIntent(
      { binding, model: "full" },
      intent,
      model("full", true),
    );
    expect(applied.options).toEqual([
      { id: "effort", value: "low" },
      { id: "ultracode", value: true },
    ]);
    expect(readRuntimeClaudeSelection(applied)).toEqual(intent);

    const unsupported = applyRuntimeClaudeIntent(
      { binding, model: "small" },
      { ...intent, model: "small" },
      model("small", false),
    );
    expect(readRuntimeClaudeSelection(unsupported)).toEqual({
      model: "small",
      effort: "low",
      ultracode: false,
    });
    expect(
      resolveRuntimeClaudeIntent(unsupported, { ...intent, model: "small" }, model("small", false)),
    ).toEqual({ ...intent, model: "small" });
  });

  it("keeps Ultracode intent but runs without it while the account cannot use it", () => {
    const unavailable: AgentRuntimeProvider["models"][number] = {
      ...model("full", true),
      capabilities: {
        optionDescriptors: (model("full", true).capabilities?.optionDescriptors ?? []).map(
          (descriptor) =>
            descriptor.id === "ultracode" && descriptor.type === "boolean"
              ? { ...descriptor, unavailableReason: "Dynamic workflows are off." }
              : descriptor,
        ),
      },
    };
    expect(runtimeClaudeModelOption(unavailable)).toMatchObject({
      ultracode: false,
      ultracodeUnavailableReason: "Dynamic workflows are off.",
    });
    const intent = { model: "full", effort: "high" as const, ultracode: true };
    const applied = applyRuntimeClaudeIntent({ binding, model: "full" }, intent, unavailable);
    expect(readRuntimeClaudeSelection(applied).ultracode).toBe(false);
    expect(resolveRuntimeClaudeIntent(applied, intent, unavailable)).toEqual(intent);
  });
});
