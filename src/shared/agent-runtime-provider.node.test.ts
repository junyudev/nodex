import { createHash } from "node:crypto";
import { isProviderInstanceId } from "@nodex/agent-runtime/contracts";
import { AgentBackendBindingSchema } from "./schemas/agent-backend";
import { describe, expect, it } from "vite-plus/test";
import {
  agentRuntimeModelSelection,
  agentRuntimeProviderId,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
  readAgentRuntimeEffort,
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

  it.each(["antigravity", "claude", "opencode"] as const)(
    "routes a hosted %s profile using the host-generated instance ID",
    (kind) => {
      const runtimeInstanceId = agentRuntimeProviderId({ kind, instanceConfigId: "google-work" })!;
      expect(runtimeInstanceId).toMatch(/[A-Z]/u);
      expect(isProviderInstanceId(runtimeInstanceId)).toBe(true);
      const binding = AgentBackendBindingSchema.parse({
        kind,
        instanceConfigId: runtimeInstanceId,
        runtimeInstanceId,
      });
      expect(agentRuntimeModelSelection(binding, "host-model")?.instanceId).toBe(runtimeInstanceId);
      for (const invalid of ["", "A".repeat(65), "1-agent"]) {
        expect(
          AgentBackendBindingSchema.safeParse({ ...binding, runtimeInstanceId: invalid }).success,
        ).toBe(false);
        expect(agentRuntimeProviderId({ ...binding, runtimeInstanceId: invalid })).toBeNull();
      }
    },
  );

  it("requires an explicit configured native instance while retaining the canonical Codex instance", () => {
    expect(agentRuntimeProviderId({ kind: "codex" })).toBe("codex");
    const google = { kind: "antigravity" as const, instanceConfigId: "work" };
    expect(agentRuntimeProviderId(google)).toMatch(/^antigravity_/u);
    expect(agentRuntimeProviderId(google)).not.toBe(
      agentRuntimeProviderId({ ...google, kind: "opencode" }),
    );
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

  it("reaches a model whose catalog names Fast `priority`, and reads it back as Fast", () => {
    const tiers = [
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select" as const,
        options: [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast" },
        ],
      },
    ];
    const fast = applyAgentRuntimeOptionIntent(tiers, undefined, { serviceTier: "fast" });
    expect(fast).toEqual([{ id: "serviceTier", value: "priority" }]);
    expect(readAgentRuntimeServiceTier(fast)).toBe("fast");
    const standard = applyAgentRuntimeOptionIntent(tiers, fast, { serviceTier: null });
    expect(standard).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(readAgentRuntimeServiceTier(standard)).toBeNull();
  });

  it.each([
    { offered: ["priority", "ultrafast"], requested: "ultrafast", expected: "ultrafast" },
    { offered: ["priority"], requested: "ultrafast", expected: "priority" },
    { offered: ["ultrafast"], requested: "fast", expected: "default" },
    { offered: [], requested: "ultrafast", expected: "default" },
  ])(
    "fits $requested to $expected on a model offering $offered",
    ({ offered, requested, expected }) => {
      const descriptors: AgentRuntimeOptionDescriptor[] = offered.length
        ? [
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select",
              options: offered.map((id) => ({ id, label: id })),
            },
          ]
        : [];
      const options = applyAgentRuntimeOptionIntent(descriptors, undefined, {
        serviceTier: requested,
      });
      expect(options).toEqual([{ id: "serviceTier", value: expected }]);
      expect(applyAgentRuntimeOptionIntent(descriptors, options, {})).toEqual(options);
    },
  );

  it("names Standard on a model without speeds only to clear a faster one", () => {
    expect(applyAgentRuntimeOptionIntent([], undefined, { serviceTier: null })).toEqual([]);
    expect(
      applyAgentRuntimeOptionIntent([], [{ id: "serviceTier", value: "priority" }], {
        serviceTier: null,
      }),
    ).toEqual([]);
  });

  it("writes Claude effort under effort and keeps its other declared options", () => {
    expect(
      applyAgentRuntimeOptionIntent(
        claude,
        [
          { id: "thinking", value: false },
          { id: "fastMode", value: true },
        ],
        { reasoningEffort: "max" },
      ),
    ).toEqual([
      { id: "thinking", value: false },
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });

  it("preserves Antigravity's native thought-level choice through effort intent and handoff", () => {
    const descriptors: AgentRuntimeOptionDescriptor[] = [
      {
        id: "thought_level",
        label: "Thinking",
        type: "select",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    ];
    const options = applyAgentRuntimeOptionIntent(descriptors, undefined, {
      reasoningEffort: "high",
    });
    expect(options).toEqual([{ id: "thought_level", value: "high" }]);
    expect(readAgentRuntimeEffort(options)).toBe("high");
    expect(
      applyAgentRuntimeOptionIntent(descriptors, options, { reasoningEffort: "unavailable" }),
    ).toEqual([]);
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
