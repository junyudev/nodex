import { expect, it } from "vite-plus/test";
import { managedNodexProviders, projectManagedNodexCatalog } from "./managed-providers";
import { modelAccessFixture } from "./model-access-fixture";

const identity = {
  issuer: "https://clerk.nodex.jyu.app",
  subject: "alice",
  email: null,
  name: null,
  imageUrl: null,
};
const input = {
  home: "/profile",
  codexBinary: "/runtime/codex",
  environment: {
    HOME: "/user",
    CODEX_HOME: "/user/.codex",
    CLAUDE_CONFIG_DIR: "/user/.claude",
    OPENAI_API_KEY: "native-openai",
    ANTHROPIC_AUTH_TOKEN: "native-claude",
    PATH: "/bin",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  },
  managed: { identity, access: modelAccessFixture },
};
it("declares only the four managed models with private per-account homes and credentials", () => {
  const providers = managedNodexProviders(input);
  expect(Object.keys(providers)).toHaveLength(2);
  expect(
    Object.values(providers)
      .flatMap((provider) => provider.modelAllowlist)
      .sort((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6.1-sol"]);
  for (const provider of Object.values(providers)) {
    expect(provider.source).toBe("nodex");
    const environment = Object.fromEntries(
      provider.environment!.map((entry) => [entry.name, entry.value]),
    );
    // Agent tools keep the user's shell: home, proxy and SSH agent stay; provider state does not.
    expect(environment).toMatchObject({
      HOME: "/user",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    expect(environment.CODEX_HOME ?? environment.CLAUDE_CONFIG_DIR).toMatch(
      /^\/profile\/account\/models\//u,
    );
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(provider)).not.toContain("native-openai");
    expect(JSON.stringify(provider)).not.toContain("native-claude");
    expect(JSON.stringify(provider.config)).not.toContain("synthetic-gateway-key");
  }
  const codex = Object.values(providers).find((provider) => provider.driver === "codex")!;
  expect(codex.config).toMatchObject({ isolated: true, setupMode: "existing" });
  const token = codex.environment!.find((entry) => entry.name === "NODEX_GATEWAY_API_KEY")!;
  expect(token).toMatchObject({ sensitive: true, value: "synthetic-gateway-key" });
});
it("ignores gateway catalog expansion and mismatched protocols", () => {
  const providers = managedNodexProviders({
    ...input,
    managed: {
      identity,
      access: {
        ...modelAccessFixture,
        models: [
          { id: "gpt-6.1-sol", label: "Wrong", protocol: "anthropic" },
          { id: "extra", label: "Extra", protocol: "openai" },
        ],
      },
    },
  });
  expect(providers).toEqual({});
});
it("retains no signed-out providers and never reuses another account's runtime identity or home", () => {
  expect(managedNodexProviders({ ...input, managed: null })).toEqual({});
  const alice = managedNodexProviders(input);
  const bob = managedNodexProviders({
    ...input,
    managed: { ...input.managed, identity: { ...identity, subject: "bob" } },
  });
  expect(Object.keys(bob).some((id) => Object.hasOwn(alice, id))).toBe(false);
  expect(Object.values(bob)[0]!.config).not.toEqual(Object.values(alice)[0]!.config);
});

it("filters retired and other-account catalogs even when their replies arrive late", () => {
  const catalog = Object.entries(managedNodexProviders(input)).map(([instanceId, provider]) => ({
    instanceId,
    source: provider.source,
    models: [],
  })) as unknown as import("@nodex/agent-runtime/contracts").AgentRuntimeOperations["providers.read"]["output"];
  expect(projectManagedNodexCatalog(catalog, null)).toEqual([]);
  expect(
    projectManagedNodexCatalog(catalog, {
      ...input.managed,
      identity: { ...identity, subject: "bob" },
    }),
  ).toEqual([]);
  expect(projectManagedNodexCatalog(catalog, input.managed)).toEqual(catalog);
});
