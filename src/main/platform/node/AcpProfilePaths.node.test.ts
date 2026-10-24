import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpNativeStorageScope, acpProviderStorageScopes } from "./AcpProfilePaths";
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
  const scopes = (environment: typeof active.environment) =>
    acpProviderStorageScopes({
      environment,
      homeDirectory: root,
      platform: process.platform,
    });
  expect(await scopes(disabled.environment)).toEqual(await scopes(active.environment));
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

const projectScopes = async (
  root: string,
  options: {
    readonly agentIdentity?: string;
    readonly isolatedHome?: string;
    readonly variables?: Readonly<Record<string, string>>;
    readonly inheritedEnvironment?: Readonly<Record<string, string>>;
    readonly platform?: string;
  } = {},
) => {
  const instance: AcpAgentInstanceConfig = {
    id: "profile",
    agentDefinitionId: options.agentIdentity ?? "unknown-agent",
    displayName: "Agent",
    enabled: true,
    source: { kind: "local", executable: "claude-agent-acp", args: [] },
    credentials: options.isolatedHome
      ? { kind: "isolated-home", home: options.isolatedHome }
      : { kind: "inherit-host-profile" },
    proxy: "isolated",
    customModels: [],
    environment: Object.entries(options.variables ?? {}).map(([name, value]) => ({
      name,
      value,
      sensitive: false,
    })),
  };
  const provider = acpProviderConfiguration({
    instance,
    homeDirectory: root,
    inheritedEnvironment: { HOME: root, ...options.inheritedEnvironment },
    environment: {},
  });
  return acpProviderStorageScopes({
    environment: provider.environment,
    homeDirectory: root,
    platform: options.platform ?? process.platform,
  });
};

it("shares an unknown Agent's credentials despite unrelated toolchain and cache directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-credential-scope-"));
  roots.push(root);
  const first = await projectScopes(root, {
    variables: { CARGO_HOME: join(root, "cargo-one") },
    inheritedEnvironment: { XDG_CACHE_HOME: join(root, "cache-one") },
  });
  const second = await projectScopes(root, {
    variables: { CARGO_HOME: join(root, "cargo-two") },
    inheritedEnvironment: { XDG_CACHE_HOME: join(root, "cache-two") },
  });
  expect(first.nativeStorageScope).not.toBe(second.nativeStorageScope);
  expect(first.credentialStorageScopes).toEqual(second.credentialStorageScopes);
  expect(first.credentialStorageScopes).toContain(await realpath(root));
  const isolated = await projectScopes(root, { isolatedHome: join(root, "isolated") });
  expect(
    isolated.credentialStorageScopes.some((claim) => first.credentialStorageScopes.includes(claim)),
  ).toBe(false);
});

it("retains a shared home claim across unknown and declared Agent identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-mixed-identity-"));
  roots.push(root);
  const unknown = await projectScopes(root);
  const known = await projectScopes(root, { agentIdentity: "claude-agent-acp" });
  expect(known.nativeStorageScope).toBe(unknown.nativeStorageScope);
  expect(known.credentialStorageScopes).toEqual(unknown.credentialStorageScopes);
  expect(known.credentialStorageScopes).toContain(join(await realpath(root), ".claude"));
});

it("retains a shared default credential root across labels and different homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-cross-home-"));
  roots.push(root);
  const firstHome = join(root, "first");
  const unknown = await projectScopes(root, { isolatedHome: firstHome });
  const known = await projectScopes(root, {
    agentIdentity: "claude-agent-acp",
    isolatedHome: join(root, "second"),
    variables: { CLAUDE_CONFIG_DIR: join(firstHome, ".claude") },
  });
  const sharedRoot = join(await realpath(root), "first", ".claude");
  expect(known.nativeStorageScope).not.toBe(unknown.nativeStorageScope);
  expect(unknown.credentialStorageScopes).toContain(sharedRoot);
  expect(known.credentialStorageScopes).toContain(sharedRoot);
});

it.each([
  { agentIdentity: "claude-acp", variable: "CLAUDE_CONFIG_DIR", defaultPath: ".claude" },
  { agentIdentity: "claude-agent-acp", variable: "CLAUDE_CONFIG_DIR", defaultPath: ".claude" },
  { agentIdentity: "codex-acp", variable: "CODEX_HOME", defaultPath: ".codex" },
])(
  "coordinates $agentIdentity's explicit native credential root across isolated homes",
  async ({ agentIdentity, variable, defaultPath }) => {
    const root = await mkdtemp(join(tmpdir(), "nodex-acp-known-credentials-"));
    roots.push(root);
    const credentialRoot = join(root, "first", defaultPath);
    await mkdir(credentialRoot, { recursive: true });
    const alias = join(root, "credential-alias");
    await symlink(credentialRoot, alias);
    const first = await projectScopes(root, { agentIdentity, isolatedHome: join(root, "first") });
    const second = await projectScopes(root, {
      agentIdentity,
      isolatedHome: join(root, "second"),
      variables: { [variable]: alias },
    });
    expect(first.nativeStorageScope).not.toBe(second.nativeStorageScope);
    const sharedRoot = await realpath(credentialRoot);
    expect(first.credentialStorageScopes).toContain(sharedRoot);
    expect(second.credentialStorageScopes).toContain(sharedRoot);
    const separate = await projectScopes(root, {
      agentIdentity,
      isolatedHome: join(root, "second"),
      variables: { [variable]: join(root, "separate-credentials") },
    });
    expect(
      separate.credentialStorageScopes.some((claim) =>
        first.credentialStorageScopes.includes(claim),
      ),
    ).toBe(false);
  },
);

it.each(["opencode", "opencode-v2"])(
  "coordinates %s credentials by its data root independently of configuration and cache",
  async (agentIdentity) => {
    const root = await mkdtemp(join(tmpdir(), "nodex-acp-opencode-credentials-"));
    roots.push(root);
    const dataHome = join(root, "shared-data");
    const scope = (home: string, suffix: string) =>
      projectScopes(root, {
        agentIdentity,
        variables: { OPENCODE_CONFIG_DIR: join(root, `config-${suffix}`) },
        inheritedEnvironment: {
          HOME: home,
          XDG_DATA_HOME: dataHome,
          XDG_CACHE_HOME: join(root, `cache-${suffix}`),
        },
      });
    const first = await scope(join(root, "first-home"), "one");
    const second = await scope(join(root, "second-home"), "two");
    expect(first.nativeStorageScope).not.toBe(second.nativeStorageScope);
    const sharedRoot = join(await realpath(root), "shared-data", "opencode");
    expect(first.credentialStorageScopes).toContain(sharedRoot);
    expect(second.credentialStorageScopes).toContain(sharedRoot);
  },
);

it("uses the Windows user profile for an unknown Agent's credential scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-windows-credentials-"));
  roots.push(root);
  const first = await projectScopes(root, {
    platform: "win32",
    inheritedEnvironment: { USERPROFILE: root, HOME: join(root, "shell-one") },
  });
  const second = await projectScopes(root, {
    platform: "win32",
    inheritedEnvironment: { USERPROFILE: root, HOME: join(root, "shell-two") },
  });
  expect(first.credentialStorageScopes).toEqual(second.credentialStorageScopes);
  expect(first.credentialStorageScopes).toContain(await realpath(root));
});
