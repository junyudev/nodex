import { describe, expect, test } from "vite-plus/test";
import { describeWritingModel, writingModelPicker } from "./writing-model";
import {
  CLAUDE_INSTANCE,
  CLAUDE_INSTANCE_ID,
  claudeProvider,
  codexProvider,
} from "@/features/inbox/inbox-agents.test-support";

const luna = { instanceId: "codex", model: "gpt-6-luna" };
const instances = [{ binding: CLAUDE_INSTANCE, label: "Work" }];
const catalogOf = (
  providers: ReturnType<typeof codexProvider>[],
  state: "loading" | "ready" | "error" = "ready",
) => ({ providers, state, instances });
const offModel = (provider: ReturnType<typeof codexProvider>, slug: string) => ({
  ...provider,
  models: provider.models.map((model) =>
    model.slug === slug
      ? { ...model, policy: { on: false, switchOn: false, spendsCredit: false } }
      : model,
  ),
});

describe("what Settings says titles chats", () => {
  test("no choice follows each chat, whatever the catalog holds", () => {
    expect(describeWritingModel(catalogOf([], "loading"), null)).toEqual({
      status: "ready",
      kind: null,
      line: "Automatic",
    });
  });

  test("a usable choice names its model and Agent", () => {
    expect(describeWritingModel(catalogOf([codexProvider()]), luna)).toEqual({
      status: "ready",
      kind: "codex",
      line: "GPT-6 Luna",
    });
    const named = describeWritingModel(catalogOf([claudeProvider()]), {
      instanceId: CLAUDE_INSTANCE_ID,
      model: claudeProvider().models[0]!.slug,
    });
    expect(named.line.startsWith("Work · ")).toBe(true);
  });

  test("a choice that cannot run says so instead of being replaced", () => {
    const off = offModel(codexProvider(), "gpt-6-luna");
    expect(describeWritingModel(catalogOf([off]), luna)).toEqual({
      status: "unavailable",
      kind: "codex",
      line: "GPT-6 Luna · Off",
    });
    expect(describeWritingModel(catalogOf([]), luna)).toEqual({
      status: "unavailable",
      kind: null,
      line: "gpt-6-luna · Unavailable",
    });
    expect(
      describeWritingModel(catalogOf([{ ...codexProvider(), enabled: false }]), luna).status,
    ).toBe("unavailable");
    expect(
      describeWritingModel(catalogOf([{ ...codexProvider(), supportsTextGeneration: false }]), luna)
        .status,
    ).toBe("unavailable");
  });

  test("an unread or unprobed catalog cannot call the choice unavailable", () => {
    expect(describeWritingModel(catalogOf([], "loading"), luna).status).toBe("checking");
    expect(describeWritingModel(catalogOf([], "error"), luna)).toEqual({
      status: "checking",
      kind: null,
      line: "gpt-6-luna",
    });
    expect(
      describeWritingModel(catalogOf([{ ...codexProvider(), installed: false, models: [] }]), luna)
        .status,
    ).toBe("checking");
  });
});

describe("what the writing model picker offers", () => {
  const listed = (entries: ReturnType<typeof writingModelPicker>["entries"]) =>
    entries.map((entry) => entry.model.id);

  test("Agents that cannot generate text are not offered", () => {
    const acp = { ...codexProvider(), instanceId: "acp", supportsTextGeneration: false };
    const { entries } = writingModelPicker(catalogOf([acp]), null);
    expect(entries).toEqual([]);
  });

  test("off models are left out unless they are the saved choice", () => {
    const off = offModel(codexProvider(), "gpt-6-luna");
    expect(listed(writingModelPicker(catalogOf([off]), null).entries)).toEqual(["gpt-6-astra"]);
    expect(listed(writingModelPicker(catalogOf([off]), luna).entries)).toEqual([
      "gpt-6-astra",
      "gpt-6-luna",
    ]);
  });

  test("the saved choice is selected", () => {
    expect(writingModelPicker(catalogOf([codexProvider()]), luna).selected).toEqual({
      binding: { kind: "codex" },
      model: "gpt-6-luna",
    });
  });
});
