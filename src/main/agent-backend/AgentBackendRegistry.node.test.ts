import { describe, expect, it } from "vite-plus/test";
import type { AcpAgentInstanceConfig } from "../../shared/types";
import { AgentBackendRegistryError, resolveAgentBackendBinding } from "./AgentBackendRegistry";

const instance = (overrides: Partial<AcpAgentInstanceConfig> = {}): AcpAgentInstanceConfig => ({
  id: "claude-work",
  agentDefinitionId: "claude-agent-acp",
  displayName: "Claude Agent",
  source: {
    kind: "local",
    executable: "/usr/bin/node",
    args: ["/user-managed/claude-agent-acp/dist/index.js"],
  },
  environment: [],
  customModels: [],
  enabled: true,
  credentials: { kind: "inherit-host-profile" },
  proxy: "inherit-host",
  ...overrides,
});

describe("AgentBackendRegistry", () => {
  it("resolves the explicit native Codex binding without ACP configuration", () => {
    expect(
      resolveAgentBackendBinding(
        { kind: "codex" },
        {
          openCodeAgents: { instances: [] },
          claudeAgents: { instances: [] },
          acpAgents: { instances: [] },
        },
      ),
    ).toEqual({
      kind: "codex",
      binding: { kind: "codex" },
      displayName: "Codex",
    });
  });

  it("resolves a supported ACP definition only through its enabled matching instance", () => {
    const resolved = resolveAgentBackendBinding(
      {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-work",
      },
      {
        openCodeAgents: { instances: [] },
        claudeAgents: { instances: [] },
        acpAgents: { instances: [instance()] },
      },
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

  it("accepts arbitrary ACP Agents and keeps instances with identical model names distinct", () => {
    const settings = {
      openCodeAgents: { instances: [] },
      claudeAgents: { instances: [] },
      acpAgents: {
        instances: [
          instance({ id: "qoder-personal", agentDefinitionId: "qoder", displayName: "Personal" }),
          instance({ id: "qoder-work", agentDefinitionId: "qoder", displayName: "Work" }),
        ],
      },
    };
    for (const id of ["qoder-personal", "qoder-work"]) {
      const result = resolveAgentBackendBinding(
        { kind: "acp", agentDefinitionId: "qoder", instanceConfigId: id },
        settings,
      );
      expect(result).toMatchObject({
        kind: "acp",
        binding: { instanceConfigId: id },
        instance: { id },
      });
    }
  });

  it.each([
    {
      label: "different definition",
      binding: { kind: "acp", agentDefinitionId: "unknown", instanceConfigId: "claude-work" },
      instances: [instance()],
      reason: "instance-definition-mismatch",
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
      openCodeAgents: { instances: [] },
      claudeAgents: { instances: [] },
      acpAgents: { instances: [...instances] },
    });

    expect(result).toBeInstanceOf(AgentBackendRegistryError);
    expect((result as AgentBackendRegistryError).reason).toBe(reason);
  });
});
