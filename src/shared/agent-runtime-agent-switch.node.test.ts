import { describe, expect, it } from "vite-plus/test";
import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import {
  agentRuntimeAgentSwitchRefusal,
  agentRuntimePendingSelection,
  agentRuntimeSelectionRefusal,
} from "./agent-runtime-agent-switch";

type Projection = Parameters<typeof agentRuntimeAgentSwitchRefusal>[0];
const session = (status: string, handoff = true) => ({
  id: "session",
  status,
  capabilities: { sessions: { supportsProviderSwitchingViaHandoff: handoff } },
});
const finished = {
  thread: {
    id: "thread",
    activeProviderThreadId: "provider-thread",
    modelSelection: { instanceId: "codex", model: "gpt" },
  },
  runs: [{ id: "run", status: "completed", providerThreadId: "provider-thread" }],
  providerSessions: [],
  providerThreads: [
    {
      id: "provider-thread",
      appThreadId: "thread",
      providerInstanceId: "codex",
      providerSessionId: "detached-session",
      nativeThreadRef: { driver: "codex", nativeId: "native", strength: "strong" },
    },
  ],
} as unknown as Projection;
const withRuns = (status: string): Projection => ({
  ...finished,
  runs: [{ ...finished.runs[0]!, status } as AgentSnapshot["projection"]["runs"][number]],
});

describe("Agent switching in a started chat", () => {
  it("lets a finished chat continue on another Agent after its process detached", () => {
    expect(agentRuntimeAgentSwitchRefusal(finished)).toBeNull();
  });

  it("follows a live provider session's capability, including while its reply runs", () => {
    const running = withRuns("running");
    expect(
      agentRuntimeAgentSwitchRefusal({
        ...running,
        providerSessions: [session("running")],
        providerThreads: [{ ...finished.providerThreads[0]!, providerSessionId: "session" }],
      } as unknown as Projection),
    ).toBeNull();
    expect(
      agentRuntimeAgentSwitchRefusal({
        ...running,
        providerSessions: [session("ready", false)],
        providerThreads: [{ ...finished.providerThreads[0]!, providerSessionId: "session" }],
      } as unknown as Projection),
    ).toMatch(/can't continue on another Agent/u);
  });

  it("waits for a starting reply's session and refuses a chat without native history", () => {
    expect(agentRuntimeAgentSwitchRefusal(withRuns("starting"))).toMatch(/Wait for the current/u);
    expect(
      agentRuntimeAgentSwitchRefusal({
        ...finished,
        providerThreads: [{ ...finished.providerThreads[0]!, nativeThreadRef: null }],
      } as unknown as Projection),
    ).toMatch(/can't continue on another Agent/u);
    expect(agentRuntimeAgentSwitchRefusal({ ...finished, runs: [] })).toBeNull();
  });

  it("applies the chat's Agent rule to other Agents and the provider's model rule within one", () => {
    const current = { instanceId: "codex", model: "gpt" };
    const providers = [
      { instanceId: "codex", requiresNewThreadForModelChange: false },
      { instanceId: "pinned", requiresNewThreadForModelChange: true },
    ];
    const refusal = "Wait for the current reply to start, then choose another Agent.";
    expect(
      agentRuntimeSelectionRefusal({
        current,
        next: { instanceId: "claude", model: "sonnet" },
        agentSwitchRefusal: refusal,
        providers,
      }),
    ).toBe(refusal);
    expect(
      agentRuntimeSelectionRefusal({
        current,
        next: { instanceId: "codex", model: "gpt-mini" },
        agentSwitchRefusal: refusal,
        providers,
      }),
    ).toBeNull();
    expect(
      agentRuntimeSelectionRefusal({
        current: { instanceId: "pinned", model: "a" },
        next: { instanceId: "pinned", model: "b" },
        agentSwitchRefusal: null,
        providers,
      }),
    ).toMatch(/keeps its model/u);
    expect(
      agentRuntimeSelectionRefusal({
        current: { instanceId: "pinned", model: "a" },
        next: { instanceId: "pinned", model: "a" },
        agentSwitchRefusal: null,
        providers,
      }),
    ).toBeNull();
  });

  it("carries only a choice that differs from what the chat last ran, in any option order", () => {
    const observed = {
      instanceId: "codex",
      model: "gpt",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const reordered = { ...observed, options: [...observed.options].reverse() };
    expect(agentRuntimePendingSelection(observed, reordered)).toBeNull();
    expect(agentRuntimePendingSelection(observed, undefined)).toBeNull();
    const claude = { instanceId: "claude", model: "sonnet" };
    expect(agentRuntimePendingSelection(observed, claude)).toBe(claude);
    const lower = { ...observed, options: [{ id: "reasoningEffort", value: "low" }] };
    expect(agentRuntimePendingSelection(observed, lower)).toBe(lower);
  });
});
