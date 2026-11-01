import { describe, expect, test } from "vite-plus/test";
import type { ConversationAgent } from "../../../shared/conversation-identity";
import type { AgentRuntimeProviderLabel } from "./agent-runtime-delegated-tasks";
import {
  agentIdentitySpokenText,
  agentIdentityText,
  presentAgentIdentity,
} from "./agent-identity-presentation";

const labels = new Map<string, AgentRuntimeProviderLabel>([
  ["codex", { label: "Codex", kind: "codex", models: new Map([["gpt-6.1-sol", "GPT-6.1-Sol"]]) }],
  [
    "claude_work",
    { label: "Claude", kind: "claude", models: new Map([["claude-opus-5-5", "Claude Opus 5.5"]]) },
  ],
  [
    "opencode_free",
    {
      label: "OpenCode",
      kind: "opencode",
      models: new Map([["openai/gpt-6.1-sol", "GPT-6.1-Sol"]]),
    },
  ],
]);

const agent = (overrides: Partial<ConversationAgent>): ConversationAgent => ({
  kind: null,
  providerInstanceId: null,
  model: null,
  effort: null,
  ...overrides,
});

describe("Agent identity presentation", () => {
  test("lets the mark name the Agent in rows, spells it in cards, and adds effort to settings", () => {
    const sol = presentAgentIdentity(
      agent({ kind: "codex", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "xhigh" }),
      labels,
    );
    expect(sol).toEqual({
      kind: "codex",
      agentName: "Codex",
      modelName: "GPT-6.1 Sol",
      effortName: "Extra High",
    });
    expect(agentIdentityText(sol, "model")).toBe("GPT-6.1 Sol");
    expect(agentIdentityText(sol, "agent")).toBe("Codex · GPT-6.1 Sol");
    expect(agentIdentityText(sol, "settings")).toBe("GPT-6.1 Sol · Extra High");
    expect(agentIdentitySpokenText(sol, "model")).toBe("Codex · GPT-6.1 Sol");
    expect(agentIdentitySpokenText(sol, "settings")).toBe("Codex · GPT-6.1 Sol · Extra High");
  });

  test("marks the harness, not the model's maker", () => {
    const viaOpenCode = presentAgentIdentity(
      agent({ providerInstanceId: "opencode_free", model: "openai/gpt-6.1-sol" }),
      labels,
    );
    expect(viaOpenCode.kind).toBe("opencode");
    expect(agentIdentityText(viaOpenCode, "agent")).toBe("OpenCode · GPT-6.1 Sol");
  });

  test("lets a model named after its Agent stand alone", () => {
    const opus = presentAgentIdentity(
      agent({ providerInstanceId: "claude_work", model: "claude-opus-5-5", effort: "high" }),
      labels,
    );
    expect(agentIdentityText(opus, "agent")).toBe("Claude Opus 5.5");
    expect(agentIdentityText(opus, "settings")).toBe("Claude Opus 5.5 · High");
  });

  test("names the harness itself before its configuration loads, and nothing when unknown", () => {
    const unconfigured = presentAgentIdentity(agent({ kind: "claude" }), new Map());
    expect(agentIdentityText(unconfigured, "model")).toBe("Claude Code");
    expect(agentIdentityText(unconfigured, "agent")).toBe("Claude Code");
    expect(agentIdentityText(presentAgentIdentity(agent({}), new Map()), "agent")).toBeNull();
    expect(presentAgentIdentity(agent({ kind: "acp" }), new Map()).agentName).toBeNull();
  });
});
