import { expect, it } from "vite-plus/test";
import type { AcpAgentInstanceConfig } from "../../shared/acp-agent-settings";
import { acpProviderConfiguration } from "./AcpProviderConfiguration";
const instance: AcpAgentInstanceConfig = {
  id: "agent",
  agentDefinitionId: "unknown-agent",
  displayName: "Agent",
  enabled: true,
  source: {
    kind: "local",
    executable: "agent-command",
    args: ["--acp", "quoted argument", "$(literal)"],
  },
  environment: [{ name: "API_KEY", sensitive: true, value: null }],
  credentials: { kind: "isolated-home", home: "/isolated" },
  proxy: "isolated",
  customModels: ["custom"],
};
it("projects arbitrary local commands with explicit secrets and isolated profile paths", () => {
  const result = acpProviderConfiguration({
    instance,
    inheritedEnvironment: {
      PATH: "/bin",
      HOME: "/host",
      APPDATA: "/host/app",
      XDG_CONFIG_HOME: "/host/config",
      HTTPS_PROXY: "host-proxy",
      NODE_OPTIONS: "--require unsafe",
      HOST_SECRET: "private",
    },
    environment: { API_KEY: "key" },
    homeDirectory: "/host",
  });
  expect(result.enabled).toBe(true);
  expect(result.config).toMatchObject({
    source: "local",
    commandPath: "agent-command",
    commandArgs: ["--acp", "quoted argument", "$(literal)"],
    inheritEnvironment: false,
    customModels: ["custom"],
  });
  const env = Object.fromEntries(result.environment!.map(({ name, value }) => [name, value]));
  expect(env).toMatchObject({
    HOME: "/isolated",
    PATH: "/bin",
    XDG_CONFIG_HOME: "/isolated/.config",
    APPDATA: "/isolated/AppData/Roaming",
    API_KEY: "key",
  });
  for (const key of ["HOST_SECRET", "NODE_OPTIONS", "HTTPS_PROXY"])
    expect(env[key]).toBeUndefined();
  expect(result.environment).toContainEqual({ name: "API_KEY", value: "key", sensitive: true });
});
it("pins registry identity while independently preserving inherited host profile and proxy", () => {
  const result = acpProviderConfiguration({
    instance: {
      ...instance,
      source: {
        kind: "registry",
        agentId: "qoder",
        distribution: "npx",
        installationId: "receipt-v1",
      },
      credentials: { kind: "inherit-host-profile" },
      proxy: "inherit-host",
    },
    inheritedEnvironment: { HOME: "/host", XDG_DATA_HOME: "/data", HTTPS_PROXY: "proxy" },
    environment: {},
    homeDirectory: "/fallback",
  });
  expect(result.config).toMatchObject({
    source: "registry",
    agentId: "qoder",
    distribution: "npx",
    installationId: "receipt-v1",
    inheritEnvironment: false,
  });
  expect(Object.fromEntries(result.environment!.map(({ name, value }) => [name, value]))).toEqual({
    HOME: "/host",
    XDG_DATA_HOME: "/data",
    HTTPS_PROXY: "proxy",
  });
});
