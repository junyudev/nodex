import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  agentRuntimeModelSelection,
  agentRuntimeProviderId,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
  type AgentRuntimeOptionDescriptor,
} from "./agent-runtime-provider";

describe("Agent Runtime provider identity", () => {
  it("encodes the complete configured identity as one bounded provider slug", () => {
    const id = "配置 / 🔑 ".repeat(10).trim();
    const binding = { kind: "claude" as const, instanceConfigId: id };
    const expected = createHash("sha256")
      .update(JSON.stringify([binding.kind, id]))
      .digest("base64url");
    const actual = agentRuntimeProviderId(binding)!;
    expect(actual).toBe(`claude_${expected}`);
    expect(actual).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
    expect(agentRuntimeProviderId({ kind: "opencode", instanceConfigId: id })).not.toBe(actual);
    expect(agentRuntimeProviderId({ ...binding, instanceConfigId: `${id}!` })).not.toBe(actual);
  });

  it("requires an explicit configured native instance while retaining the canonical Codex instance", () => {
    expect(agentRuntimeProviderId({ kind: "codex" })).toBe("codex");
    expect(
      agentRuntimeProviderId({ kind: "acp", agentDefinitionId: "agent", instanceConfigId: null }),
    ).toBeNull();
    expect(agentRuntimeProviderId({ kind: "claude", instanceConfigId: " padded" })).toBeNull();
    expect(
      agentRuntimeModelSelection({ kind: "claude", instanceConfigId: "instance" }, " model ", [
        { id: "effort", value: "high" },
      ]),
    ).toEqual({
      instanceId: agentRuntimeProviderId({ kind: "claude", instanceConfigId: "instance" }),
      model: "model",
      options: [{ id: "effort", value: "high" }],
    });
  });
});

describe("Agent Runtime model option intent", () => {
  const codex: AgentRuntimeOptionDescriptor[] = [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        { id: "fast", label: "Fast" },
      ],
    },
  ];
  const claude: AgentRuntimeOptionDescriptor[] = [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({ id, label: id })),
    },
    { id: "thinking", label: "Thinking", type: "boolean" },
    { id: "fastMode", label: "Speed", type: "boolean" },
  ];

  it("writes Codex effort and speed under reasoningEffort and serviceTier", () => {
    expect(
      applyAgentRuntimeOptionIntent(codex, undefined, {
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    ).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ]);
    const standard = applyAgentRuntimeOptionIntent(codex, [{ id: "serviceTier", value: "fast" }], {
      serviceTier: null,
    });
    expect(standard).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(readAgentRuntimeServiceTier(standard)).toBeNull();
    expect(readAgentRuntimeServiceTier([{ id: "serviceTier", value: "fast" }])).toBe("fast");
  });

  it("writes Claude effort under effort and keeps its other declared options", () => {
    expect(
      applyAgentRuntimeOptionIntent(
        claude,
        [
          { id: "thinking", value: false },
          { id: "fastMode", value: true },
        ],
        { reasoningEffort: "max", serviceTier: "fast" },
      ),
    ).toEqual([
      { id: "thinking", value: false },
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });

  it("never carries another provider's ids or values a model does not offer", () => {
    expect(
      applyAgentRuntimeOptionIntent(
        codex,
        [
          { id: "effort", value: "max" },
          { id: "reasoningEffort", value: "xhigh" },
        ],
        {},
      ),
    ).toEqual([]);
    expect(
      applyAgentRuntimeOptionIntent(codex, [{ id: "reasoningEffort", value: "low" }], {
        reasoningEffort: "ultra",
      }),
    ).toEqual([]);
  });
});
