import { antigravityProfile } from "../../shared/agents/profile.test-fixtures";
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
        { driver: "codex", instanceId: "codex" },
        {
          agentProfiles: [],
          acpAgents: { instances: [] },
        },
      ),
    ).toEqual({
      kind: "codex",
      binding: { driver: "codex", instanceId: "codex" },
      displayName: "Codex",
    });
  });

  it("resolves Antigravity only through its own enabled profile", () => {
    const binding = { driver: "antigravity" as const, instanceId: "work" };
    const profile = antigravityProfile({ id: binding.instanceId, displayName: "Work account" });
    const settings = {
      agentProfiles: [profile],
      acpAgents: { instances: [] },
    };
    expect(resolveAgentBackendBinding(binding, settings)).toMatchObject({
      kind: "profile",
      displayName: "Work account",
      binding,
    });
    expect(
      resolveAgentBackendBinding(binding, {
        ...settings,
        agentProfiles: [{ ...profile, enabled: false }],
      }),
    ).toMatchObject({ reason: "instance-disabled" });
    expect(
      resolveAgentBackendBinding({ ...binding, instanceId: "missing" }, settings),
    ).toMatchObject({ reason: "instance-unavailable" });
  });

  it("resolves a supported ACP definition only through its enabled matching instance", () => {
    const resolved = resolveAgentBackendBinding(
      { driver: "acpRegistry", instanceId: "claude-work" },
      {
        agentProfiles: [],
        acpAgents: { instances: [instance()] },
      },
    );

    expect(resolved).toMatchObject({
      kind: "acp",
      displayName: "Claude Agent",
      binding: { driver: "acpRegistry", instanceId: "claude-work" },
      instance: { id: "claude-work", agentDefinitionId: "claude-agent-acp", enabled: true },
    });
  });

  it("accepts arbitrary ACP Agents and keeps instances with identical model names distinct", () => {
    const settings = {
      agentProfiles: [],
      acpAgents: {
        instances: [
          instance({ id: "qoder-personal", agentDefinitionId: "qoder", displayName: "Personal" }),
          instance({ id: "qoder-work", agentDefinitionId: "qoder", displayName: "Work" }),
        ],
      },
    };
    for (const id of ["qoder-personal", "qoder-work"]) {
      const result = resolveAgentBackendBinding(
        { driver: "acpRegistry", instanceId: id },
        settings,
      );
      expect(result).toMatchObject({
        kind: "acp",
        binding: { instanceId: id },
        instance: { id },
      });
    }
  });

  it.each([
    {
      label: "unknown driver with an ACP profile's ID",
      binding: { driver: "futureAgent", instanceId: "claude-work" },
      instances: [instance()],
      reason: "unsupported-driver",
    },
    {
      label: "removed instance",
      binding: { driver: "acpRegistry", instanceId: "missing" },
      instances: [instance()],
      reason: "instance-unavailable",
    },
    {
      label: "disabled instance",
      binding: { driver: "acpRegistry", instanceId: "claude-work" },
      instances: [instance({ enabled: false })],
      reason: "instance-disabled",
    },
  ] as const)("fails closed for $label", ({ binding, instances, reason }) => {
    const result = resolveAgentBackendBinding(binding, {
      agentProfiles: [],
      acpAgents: { instances: [...instances] },
    });

    expect(result).toBeInstanceOf(AgentBackendRegistryError);
    expect((result as AgentBackendRegistryError).reason).toBe(reason);
  });
});
