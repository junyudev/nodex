import type { AgentSubagentOverviewItem } from "@nodex/agent-runtime/contracts";
import { describe, expect, test } from "vite-plus/test";
import type { AgentsMapChat } from "../../../shared/agents-map";
import { agentsClockIntervalMs } from "./agents-chat-status";

const chat = (overrides: Partial<AgentsMapChat>): AgentsMapChat => ({
  sessionId: "s",
  rootThreadId: "r",
  projectId: null,
  agent: null,
  state: "working",
  attention: null,
  line: null,
  queuePosition: null,
  startedAt: null,
  settledAt: null,
  outcome: null,
  unread: false,
  page: null,
  managed: false,
  subagentCount: { total: 0, live: 0 },
  subagents: null,
  ...overrides,
});

const subagents = (status: AgentSubagentOverviewItem["status"]) => ({
  active: {
    items: [{ status } as AgentSubagentOverviewItem],
    nextCursor: null,
    hasMore: false,
    totalCount: 1,
  },
  terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
});

describe("the Agents clock", () => {
  test("ticks every second while a chat or any of its subagents is working", () => {
    expect(agentsClockIntervalMs({ active: [chat({})], recent: [] })).toBe(1_000);
    // A chat waiting on its person can still have subagents at work, whose clocks run on.
    const waiting = chat({ state: "waiting", subagents: subagents("running") });
    expect(agentsClockIntervalMs({ active: [waiting], recent: [] })).toBe(1_000);
  });

  test("ticks slowly while only how long ago work ended changes, and not at all when empty", () => {
    const waiting = chat({ state: "waiting", subagents: subagents("waiting") });
    expect(agentsClockIntervalMs({ active: [waiting], recent: [] })).toBe(30_000);
    expect(agentsClockIntervalMs({ active: [], recent: [chat({ state: "settled" })] })).toBe(
      30_000,
    );
    expect(agentsClockIntervalMs({ active: [], recent: [] })).toBeNull();
    expect(agentsClockIntervalMs(null)).toBeNull();
  });
});
