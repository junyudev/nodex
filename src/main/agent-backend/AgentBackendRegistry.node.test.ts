import { describe, expect, it } from "vite-plus/test";
import type { AcpAgentInstanceConfig } from "../../shared/types";
import { AgentBackendRegistryError, resolveAgentBackendBinding } from "./AgentBackendRegistry";

const instance = (overrides: Partial<AcpAgentInstanceConfig> = {}): AcpAgentInstanceConfig => ({
  id: "claude-work",
  agentDefinitionId: "claude-agent-acp",
  packageRoot: "/user-managed/claude-agent-acp",
  nodeExecutable: "/usr/bin/node",
  enabled: true,
  credentials: { kind: "inherit-host-profile" },
  proxy: "inherit-host",
  ...overrides,
});

describe("AgentBackendRegistry", () => {
  it("resolves the explicit native Codex binding without ACP configuration", () => {
    expect(resolveAgentBackendBinding({ kind: "codex" }, { acpAgents: { instances: [] } })).toEqual(
      {
        kind: "codex",
        binding: { kind: "codex" },
        displayName: "Codex",
      },
    );
  });

  it("resolves a supported ACP definition only through its enabled matching instance", () => {
    const resolved = resolveAgentBackendBinding(
      {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-work",
      },
      { acpAgents: { instances: [instance()] } },
    );

    expect(resolved).toMatchObject({
      kind: "acp",
      displayName: "Claude Agent",
      binding: {
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-work",
      },
      instance: { id: "claude-work", enabled: true },
    });
  });

  it.each([
    {
      label: "unsupported definition",
      binding: { kind: "acp", agentDefinitionId: "unknown", instanceConfigId: "claude-work" },
      instances: [instance()],
      reason: "definition-unavailable",
    },
    {
      label: "missing instance identity",
      binding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: null,
      },
      instances: [instance()],
      reason: "instance-required",
    },
    {
      label: "disabled instance",
      binding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-work",
      },
      instances: [instance({ enabled: false })],
      reason: "instance-disabled",
    },
    {
      label: "mismatched instance definition",
      binding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-work",
      },
      instances: [instance({ agentDefinitionId: "another-agent" })],
      reason: "instance-definition-mismatch",
    },
  ] as const)("fails closed for $label", ({ binding, instances, reason }) => {
    const result = resolveAgentBackendBinding(binding, {
      acpAgents: { instances: [...instances] },
    });

    expect(result).toBeInstanceOf(AgentBackendRegistryError);
    expect((result as AgentBackendRegistryError).reason).toBe(reason);
  });
});
