import { describe, expect, test } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../../shared/inbox";
import { describeUsageMeter, runtimeUsageReading } from "@/lib/usage-meter";
import { inboxAgentLine } from "./inbox-agent-model";
import {
  describeInboxPlanning,
  inboxPlanningBudget,
  inboxPlanningModels,
  inboxPlanningNextChange,
  type InboxPlanningModel,
} from "./inbox-planning";
import { claudeProvider, codexProvider, inboxAgentsFixture } from "./inbox-agents.test-support";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type UsageWindow = NonNullable<Provider["usageLimits"]>["windows"][number];

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

const session = (usedPercent: number, resetsAt = NOW + 2 * HOUR): UsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: iso(resetsAt),
  windowDurationMins: 300,
});
const weekly = (id: string, usedPercent: number, resetsAt = NOW + 72 * HOUR): UsageWindow => ({
  id,
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: iso(resetsAt),
  windowDurationMins: 7 * 24 * 60,
});
const limits = (windows: readonly UsageWindow[], checkedAt = NOW - 5 * 60_000) => ({
  usageLimits: { checkedAt: iso(checkedAt), windows: [...windows] },
});

const model = (slug: string, name: string, isDefault = false) => ({
  slug,
  name,
  isCustom: false,
  ...(isDefault ? { isDefault } : {}),
  capabilities: {},
});

/** GPT-6.1 Sol runs at low effort unless told otherwise. */
const sol = {
  ...model("gpt-6.1-sol", "GPT-6.1 Sol", true),
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select" as const,
        currentValue: "low",
        options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
      },
    ],
  },
};

/** Codex offering GPT-6.1 Sol beside a model the guide does not cover. */
const codex = (windows: readonly UsageWindow[] = [session(20), weekly("secondary", 29)]) => ({
  ...codexProvider(),
  models: [sol, model("gpt-6-astra", "GPT-6 Astra")],
  ...limits(windows),
});

const claude = (windows: readonly UsageWindow[] = [session(10), weekly("seven_day", 38)]) => ({
  ...claudeProvider(),
  ...limits(windows),
});

/** OpenCode with its free models and a billed one, reporting no usage. */
const openCode = (): Provider => ({
  ...codexProvider(),
  instanceId: "opencode",
  displayName: "OpenCode",
  driver: "opencode",
  models: [
    model("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", true),
    model("opencode/deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free"),
    model("opencode/glm-5.3-flash-free", "GLM-5.3-Flash Free"),
  ],
});

const catalog = (providers: readonly Provider[]) => inboxAgentsFixture({ providers });

const lines = (models: readonly InboxPlanningModel[]) =>
  models.map((entry) => ({ title: entry.title, summary: entry.summary, budget: entry.budget }));

const budgetOf = (provider: Provider) =>
  inboxPlanningBudget(describeUsageMeter(runtimeUsageReading(provider, false), NOW), NOW);

const settings = (overrides: Partial<InboxSettings> = {}): InboxSettings => ({
  ...DEFAULT_INBOX_SETTINGS,
  ...overrides,
});

describe("what suggestions choose a new chat's model among", () => {
  test("each guide family an Agent offers, beside that Agent's weekly budget", () => {
    const models = inboxPlanningModels(catalog([codex(), claude(), openCode()]), true, NOW);
    expect(lines(models)).toEqual([
      {
        title: "GPT-6.1",
        summary: expect.stringMatching(/^Backend/),
        budget: { kind: "left", percent: 71, severity: "normal", window: null, readAgo: null },
      },
      {
        // A second Claude account is named, as the model menu names it.
        title: "Claude Opus 5.5 · Work",
        summary: expect.stringMatching(/^Frontend/),
        budget: { kind: "left", percent: 62, severity: "normal", window: null, readAgo: null },
      },
      // Free models spend no budget, whatever OpenCode reports.
      { title: "OpenCode free models", summary: expect.any(String), budget: { kind: "free" } },
    ]);
    expect(models.map((entry) => entry.kind)).toEqual(["codex", "claude", "opencode"]);
  });

  test("without the guide, each Agent once with only its budget", () => {
    const models = inboxPlanningModels(catalog([codex(), claude(), openCode()]), false, NOW);
    expect(lines(models)).toEqual([
      { title: "Codex", summary: null, budget: expect.objectContaining({ percent: 71 }) },
      { title: "Work", summary: null, budget: expect.objectContaining({ percent: 62 }) },
      { title: "OpenCode", summary: null, budget: { kind: "unknown" } },
    ]);
  });

  test("only families among the models a suggestion is actually offered", () => {
    // Main offers twelve models an Agent at most, so a thirteenth free model never reaches it.
    const crowded = {
      ...openCode(),
      models: [
        model("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", true),
        ...Array.from({ length: 11 }, (_, index) =>
          model(`openai/gpt-6.1-variant-${index}`, `GPT-6.1 Variant ${index}`),
        ),
        model("opencode/glm-5.3-flash-free", "GLM-5.3-Flash Free"),
      ],
    };
    const titles = inboxPlanningModels(catalog([crowded]), true, NOW).map((entry) => entry.title);
    expect(titles).toEqual(["GPT-6.1 · OpenCode"]);
  });

  test("only Agents that can take a chat now", () => {
    const disabled = { ...claude(), enabled: false };
    const empty = { ...openCode(), models: [] };
    const titles = inboxPlanningModels(catalog([codex(), disabled, empty]), true, NOW).map(
      (entry) => entry.title,
    );
    expect(titles).toEqual(["GPT-6.1"]);
  });
});

describe("what is left of an Agent's budget", () => {
  test("is the weekly window, even when a session window has less", () => {
    expect(budgetOf(codex([session(95), weekly("secondary", 40)]))).toEqual({
      kind: "left",
      percent: 60,
      severity: "normal",
      window: null,
      readAgo: null,
    });
  });

  test("takes the rail's warning colors as it runs low", () => {
    expect(budgetOf(codex([weekly("secondary", 75)]))).toMatchObject({ severity: "low" });
    expect(budgetOf(codex([weekly("secondary", 90)]))).toMatchObject({ severity: "critical" });
    expect(budgetOf(codex([weekly("secondary", 100)]))).toEqual({ kind: "spent", window: null });
  });

  test("names a window when the Agent has no weekly one", () => {
    const monthly: UsageWindow = {
      id: "primary",
      kind: "monthly",
      label: "Monthly",
      usedPercent: 10,
      resetsAt: iso(NOW + 200 * HOUR),
      windowDurationMins: 30 * 24 * 60,
    };
    expect(budgetOf(codex([monthly]))).toMatchObject({ percent: 90, window: "Monthly" });
  });

  test("never claims what it cannot know", () => {
    // The window reset after it was read, so its old share no longer describes the account.
    expect(budgetOf(codex([weekly("secondary", 90, NOW - HOUR)]))).toEqual({ kind: "reset" });
    expect(budgetOf(openCode())).toEqual({ kind: "unknown" });
    // An old reading still shows, marked as old.
    const old = { ...codex(), ...limits([weekly("secondary", 29)], NOW - 3 * HOUR) };
    expect(budgetOf(old)).toMatchObject({ percent: 71, readAgo: "3 h ago" });
  });

  test("leaves a Claude model's own week to the Agent's card", () => {
    const fable: UsageWindow = { ...weekly("seven_day_fable", 97), label: "Weekly · Fable" };
    expect(budgetOf(claude([weekly("seven_day", 38), fable]))).toMatchObject({ percent: 62 });
  });
});

test("the plan next changes when the first budget resets or its reading ages", () => {
  const planning = describeInboxPlanning(
    catalog([
      codex([weekly("secondary", 29, NOW + 72 * HOUR)]),
      claude([weekly("seven_day", 38, NOW + 5 * HOUR)]),
    ]),
    settings(),
    { kind: "automatic" },
    NOW,
  );
  // Codex was read five minutes ago, so its reading ages out first, before any window resets.
  expect(inboxPlanningNextChange(planning)).toBe(NOW - 5 * 60_000 + 30 * 60_000);
  expect(
    inboxPlanningNextChange(
      describeInboxPlanning(catalog([codex()]), settings(), { kind: "off" }, NOW),
    ),
  ).toBe(null);
});

describe("how the Inbox plans", () => {
  const agents = catalog([codex(), claude(), openCode()]);

  test("names the suggestion model at the effort suggestions run it", () => {
    const planning = describeInboxPlanning(agents, settings(), { kind: "automatic" }, NOW);
    expect(planning.kind === "suggests" && inboxAgentLine(planning.suggestedBy)).toBe(
      "Codex · GPT-6.1 Sol · High",
    );
    expect(planning).toMatchObject({ when: "automatic", models: { kind: "chosen", guide: true } });
  });

  test("keeps routing preferences as written, without surrounding space", () => {
    const planning = describeInboxPlanning(
      agents,
      settings({ instructions: "  Docs go to free models.\n" }),
      { kind: "on_request" },
      NOW,
    );
    expect(planning).toMatchObject({ when: "on_request", preferences: "Docs go to free models." });
  });

  test("runs every new chat on one model when suggestions only route", () => {
    const planning = describeInboxPlanning(
      agents,
      settings({ suggestionsChooseModels: false }),
      { kind: "automatic" },
      NOW,
    );
    expect(planning.kind === "suggests" && planning.models.kind).toBe("fixed");
  });

  test("says only what new chats run on when suggestions are off", () => {
    const planning = describeInboxPlanning(agents, settings(), { kind: "off" }, NOW);
    expect(planning.kind).toBe("off");
    expect(planning.kind === "off" && inboxAgentLine(planning.chat)).toBe(
      "Codex · GPT-6.1 Sol · Light",
    );
  });
});
