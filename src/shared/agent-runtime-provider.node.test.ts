import vectors from "../../tests/fixtures/agent-identity-vectors.json";
import { decodeLegacyAgentBinding } from "./agents/legacy-identity";
import { AgentBackendBindingSchema } from "./schemas/agent-backend";
import { describe, expect, it } from "vite-plus/test";
import {
  agentRuntimeModelSelection,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
  readAgentRuntimeEffort,
  type AgentRuntimeOptionDescriptor,
} from "./agent-runtime-provider";

describe("Agent Runtime provider identity", () => {
  it.each(vectors)("preserves the instance ID for $kind $configId", (vector) => {
    const binding = decodeLegacyAgentBinding({
      kind: vector.kind,
      instanceConfigId: vector.configId,
      agentDefinitionId: vector.definitionId,
    });
    expect(binding).toEqual({ driver: vector.driver, instanceId: vector.instanceId });
    expect(AgentBackendBindingSchema.safeParse(binding).success).toBe(true);
  });

  it("routes an unfamiliar driver with its exact instance ID", () => {
    const binding = AgentBackendBindingSchema.parse({
      driver: "futureAgent",
      instanceId: "future_work",
    });
    expect(agentRuntimeModelSelection(binding, " model ")).toEqual({
      instanceId: "future_work",
      model: "model",
    });
    expect(AgentBackendBindingSchema.safeParse({ ...binding, instanceId: " padded" }).success).toBe(
      false,
    );
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
