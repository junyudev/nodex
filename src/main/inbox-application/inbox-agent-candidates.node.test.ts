import { describe, expect, it } from "vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { inboxAgentCandidates, inboxDefaultChatCandidate } from "./inbox-agent-candidates";
import { renderInboxOrchestration } from "./inbox-orchestration";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const effort = (levels: readonly string[], currentValue: string) => ({
  id: "reasoningEffort",
  label: "Effort",
  type: "select" as const,
  currentValue,
  options: levels.map((id) => ({ id, label: id })),
});

const codex: Provider = {
  instanceId: "codex",
  displayName: "Codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T11:00:00.000Z",
  usageLimits: {
    checkedAt: "2026-10-26T11:30:00.000Z",
    windows: [
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 20,
        resetsAt: hoursFromNow(120),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  },
  models: [
    { slug: "gpt-6-mini", name: "GPT-6 Mini", isCustom: false, capabilities: {} },
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          effort(["medium", "high", "xhigh"], "medium"),
          {
            id: "serviceTier",
            label: "Speed",
            type: "select",
            options: [
              { id: "default", label: "Standard" },
              { id: "fast", label: "Fast" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const claude: Provider = {
  ...codex,
  instanceId: "claude:work",
  displayName: "Claude",
  driver: "claudeAgent",
  // The weekly window is two-thirds spent with most of the week still to go.
  usageLimits: {
    checkedAt: "2026-10-26T08:00:00.000Z",
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 70,
        resetsAt: hoursFromNow(130),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  },
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [{ ...effort(["low", "high", "max"], "high"), id: "effort" }],
      },
    },
  ],
};

describe("what a suggestion may run chats on", () => {
  it("offers each usable Agent's models with their efforts, speeds, guide notes and budget", () => {
    const [openai, anthropic] = inboxAgentCandidates(
      [codex, claude, { ...codex, instanceId: "off", enabled: false }],
      {
        now: NOW,
        useModelGuide: true,
      },
    );
    expect(openai?.models[0]).toMatchObject({
      model: "gpt-6.1-sol",
      efforts: ["medium", "high", "xhigh"],
      default_effort: "medium",
      speeds: ["fast"],
    });
    expect(openai?.models[0]?.guide).toMatch(/backend/);
    expect(openai?.budget).toEqual([
      { label: "Weekly", kind: "weekly", left_percent: 80, resets_in_hours: 120, pace: "steady" },
    ]);
    expect(anthropic?.models[0]?.guide).toMatch(/UI and UX/);
    // A reading four hours old says so, since the window may have moved since.
    expect(anthropic?.budget).toEqual([
      expect.objectContaining({ left_percent: 30, pace: "tight", read_hours_ago: 4 }),
    ]);
  });

  it("leaves the guide out when the user turns it off", () => {
    const [openai] = inboxAgentCandidates([codex], { now: NOW, useModelGuide: false });
    expect(openai?.models.every((model) => model.guide === undefined)).toBe(true);
  });

  it("names the Inbox's own chat Agent as the suggestion's default", () => {
    expect(
      inboxDefaultChatCandidate([codex], {
        instanceId: "codex",
        model: null,
        reasoningEffort: null,
        serviceTier: null,
      }),
    ).toEqual({ instance_id: "codex", model: "gpt-6.1-sol", effort: "medium" });
  });
});

describe("how a planned chat's Agent is told to run the work", () => {
  it("writes the plan, then each part with its exact delegate_task target", () => {
    const text = renderInboxOrchestration([codex, claude], {
      plan: "Settle the API contract first, then build the UI on it.",
      delegates: [
        {
          work: "The onboarding API and its migrations",
          agent: {
            instanceId: "codex",
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
            serviceTier: null,
          },
        },
      ],
    });
    expect(text).toContain("How to run this work:\nSettle the API contract first");
    expect(text).toContain(
      'target: {"providerInstanceId":"codex","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"xhigh"}]} (Codex · GPT-6.1 Sol · xhigh)',
    );
    expect(text).not.toContain("unavailable");
  });

  it("still hands over a part whose target cannot run now, saying so", () => {
    const text = renderInboxOrchestration([codex], {
      plan: null,
      delegates: [
        {
          work: "Visual polish",
          agent: {
            instanceId: "claude:gone",
            model: "claude-opus-5-5",
            reasoningEffort: null,
            serviceTier: null,
          },
        },
      ],
    });
    expect(text).toContain('{"providerInstanceId":"claude:gone","model":"claude-opus-5-5"}');
    expect(text).toContain("unavailable when the chat started");
  });

  it("lets a chat's own Agent run a part through its own subagents", () => {
    const part = {
      work: "Benchmark the scoring",
      agent: {
        instanceId: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "xhigh",
        serviceTier: null,
      },
    };
    expect(renderInboxOrchestration([codex], { plan: null, delegates: [part] }, "codex")).toContain(
      "your own subagents may run it",
    );
    expect(
      renderInboxOrchestration([codex], { plan: null, delegates: [part] }, "claude:work"),
    ).not.toContain("subagents");
  });

  it("writes nothing for a chat with no plan", () => {
    expect(renderInboxOrchestration([codex], { plan: null, delegates: [] })).toBeNull();
  });
});
