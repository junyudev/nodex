import { describe, expect, test } from "vite-plus/test";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  agentRuntimeModelOptionMemoryAtom,
  rememberAgentModelOptions,
  rememberedAgentModelOptions,
  withAgentRuntimeComposerChoice,
} from "./agent-runtime-composer-choices";

const codex = { kind: "codex" as const };
const claude = { kind: "claude" as const, instanceConfigId: "work" };

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
    expect(rememberedAgentModelOptions(memory, { binding: codex, model: "mini" })).toBeUndefined();
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
});
