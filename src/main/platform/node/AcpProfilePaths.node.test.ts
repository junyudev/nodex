import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpNativeStorageScope } from "./AcpProfilePaths";
import { acpProviderConfiguration } from "../../agent-runtime/AcpProviderConfiguration";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("disabling preserves the canonical native identity while removing resolved credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-disabled-profile-"));
  roots.push(root);
  const physical = join(root, "profile");
  await mkdir(physical);
  const alias = join(root, "alias");
  await symlink(physical, alias);
  const instance: AcpAgentInstanceConfig = {
    id: "claude-profile",
    agentDefinitionId: "claude-acp",
    displayName: "Work",
    enabled: true,
    source: { kind: "local", executable: "agent", args: [] },
    credentials: { kind: "isolated-home", home: root },
    proxy: "isolated",
    customModels: [],
    environment: [
      { name: "CLAUDE_CONFIG_DIR", value: alias, sensitive: false },
      { name: "LOG_LEVEL", value: "warn", sensitive: false },
      { name: "API_KEY", value: null, sensitive: true },
    ],
  };
  const configured = (enabled: boolean) =>
    acpProviderConfiguration({
      instance: { ...instance, enabled },
      homeDirectory: root,
      inheritedEnvironment: {},
      environment: enabled ? { CLAUDE_CONFIG_DIR: alias, API_KEY: "resolved-secret" } : {},
    });
  const active = configured(true);
  const disabled = configured(false);
  const activeScope = await acpNativeStorageScope(active.environment);
  expect(await acpNativeStorageScope(disabled.environment)).toBe(activeScope);
  expect(JSON.parse(activeScope)).toContainEqual(["CLAUDE_CONFIG_DIR", await realpath(physical)]);
  expect(disabled.enabled).toBe(false);
  expect(disabled.environment).toContainEqual({
    name: "LOG_LEVEL",
    value: "warn",
    sensitive: false,
  });
  expect(disabled.environment.some(({ sensitive }) => sensitive)).toBe(false);
  expect(active.environment).toContainEqual({
    name: "API_KEY",
    value: "resolved-secret",
    sensitive: true,
  });
});
it("recognizes physical profile aliases and excludes token values from native storage identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-profile-"));
  roots.push(root);
  const physical = join(root, "physical");
  await mkdir(physical);
  await symlink(physical, join(root, "alias"));
  const scope = (home: string, secret: string) =>
    acpNativeStorageScope([
      { name: "HOME", value: home, sensitive: false },
      { name: "XDG_CONFIG_HOME", value: join(home, ".config"), sensitive: false },
      { name: "API_KEY", value: secret, sensitive: true },
    ]);
  expect(await scope(physical, "old-token")).toBe(await scope(join(root, "alias"), "new-token"));
  expect(await scope(physical, "old-token")).not.toBe(
    await scope(join(root, "another"), "old-token"),
  );
});
