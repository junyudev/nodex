import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, isModelOn, spendsNodexCredit } from "../../shared/model-policy";
import type { ProviderKeyConnection } from "../../shared/provider-keys";
import { parse } from "smol-toml";
import { codexAppServerArgs } from "../../../packages/agent-runtime/src/provider/codexLaunchArgs";
import { providerKeyComponentDemand, providerKeyProviders } from "./provider-key-providers";
import { CODEX_DEFAULT_INSTRUCTIONS } from "./codex-default-instructions";
import { providerKeyCodexCatalog } from "./provider-key-codex-catalog";

it("declares isolated bundled Claude providers with their own models and credentials", () => {
  const connection: ProviderKeyConnection = {
    id: "id-1",
    preset: "custom",
    agent: "claudeAgent",
    endpoint: null,
    baseUrl: "https://gateway.example/",
    displayName: "Gateway",
    enabled: true,
    keyHint: "cret",
    models: [
      { id: "primary", name: "Primary" },
      { id: "flash", name: "Flash" },
    ],
  };
  const home = join("profile", "account", "keys", "id-1", "claude");
  const { providers, catalogs } = providerKeyProviders({
    home: "profile",
    connections: [
      connection,
      { ...connection, id: "missing" },
      { ...connection, id: "off", enabled: false },
    ],
    keys: new Map([
      ["id-1", Redacted.make("test-secret")],
      ["off", Redacted.make("off-secret")],
    ]),
  });
  expect(catalogs).toEqual([]);
  const instanceId = "key_custom_id-1";
  const provider = providers[instanceId]!;
  expect(provider).toMatchObject({
    displayName: "Gateway",
    enabled: true,
    driver: "claudeAgent",
    modelAllowlist: ["primary", "flash"],
    config: {
      binaryPath: "",
      isolated: true,
      homePath: home,
      customModels: [
        { slug: "primary", name: "Primary" },
        { slug: "flash", name: "Flash" },
      ],
    },
  });
  // Only the connection's own variables: execution supplies the host's, without its credentials.
  expect(Object.fromEntries(provider.environment.map(({ name, value }) => [name, value]))).toEqual({
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: "https://gateway.example",
    ANTHROPIC_AUTH_TOKEN: "test-secret",
    ANTHROPIC_MODEL: "primary",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "primary",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "primary",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "primary",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  expect(provider.environment.filter(({ sensitive }) => sensitive).map(({ name }) => name)).toEqual(
    ["ANTHROPIC_AUTH_TOKEN"],
  );
  expect(spendsNodexCredit({ ...provider, instanceId })).toBe(false);
  expect(isModelOn(DEFAULT_MODEL_POLICY, { ...provider, instanceId }, "primary")).toBe(true);
  for (const id of ["missing", "off"]) {
    expect(providers[`key_custom_${id}`]).toMatchObject({ enabled: false, environment: [] });
  }
});

it("launches Codex with the connection's catalog, private credentials, and quick reviewer", () => {
  const connection = {
    id: "deepseek-1",
    preset: "deepseek",
    agent: "codex",
    endpoint: "international",
    baseUrl: null,
    displayName: "DeepSeek's Models",
    enabled: true,
    keyHint: "",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek Pro" },
      { id: "deepseek-flash", name: "DeepSeek Flash" },
    ],
  } satisfies ProviderKeyConnection;
  const home = join("profile with spaces", "account", "keys", connection.id, "codex");
  const componentUnavailable = {
    reason: "installing",
    message: "Codex is still installing.",
  } as const;
  const { providers, catalogs } = providerKeyProviders({
    home: "profile with spaces",
    codexBinary: "/bundled/codex",
    codexUnavailable: componentUnavailable,
    codexSearchPath: "/bundled/codex-path:/bin",
    connections: [
      connection,
      { ...connection, id: "missing" },
      { ...connection, id: "off", enabled: false },
    ],
    keys: new Map([
      [connection.id, Redacted.make("test-secret")],
      ["off", Redacted.make("off-secret")],
    ]),
  });
  const provider = providers["key_deepseek_deepseek-1"];
  expect(provider).toMatchObject({
    driver: "codex",
    enabled: true,
    componentUnavailable,
    modelAllowlist: ["deepseek-v4-pro", "deepseek-flash"],
    config: { setupMode: "existing", isolated: true, homePath: home, binaryPath: "/bundled/codex" },
  });
  if (provider?.driver !== "codex") throw new Error("Expected a Codex declaration");

  expect(catalogs).toHaveLength(1);
  const overrides = codexAppServerArgs(provider.config.launchArgs)
    .slice(1)
    .filter((arg) => arg !== "-c");
  expect(parse(overrides.join("\n"))).toMatchObject({
    model_provider: "key_connection",
    model_providers: {
      key_connection: {
        name: "DeepSeek's Models",
        base_url: "https://api.deepseek.com",
        wire_api: "responses",
        env_key: "CODEX_PROVIDER_API_KEY",
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
    cli_auth_credentials_store: "ephemeral",
    sqlite_home: home,
    model_catalog_json: catalogs[0]!.path,
    model: "deepseek-v4-pro",
    review_model: "deepseek-flash",
    web_search: "disabled",
    features: {
      guardianv2: false,
      guardianv2_decisions_comparison: false,
      guardianv3: false,
      memories: false,
      apps: false,
      standalone_web_search: false,
    },
    shell_environment_policy: { exclude: ["CODEX_PROVIDER_API_KEY"] },
  });
  expect(provider.config.launchArgs).not.toContain("test-secret");
  expect(catalogs[0]!.contents).not.toContain("test-secret");
  expect(provider.environment).toEqual([
    { name: "CODEX_HOME", value: home, sensitive: false },
    { name: "CODEX_SQLITE_HOME", value: home, sensitive: false },
    { name: "CODEX_PROVIDER_API_KEY", value: "test-secret", sensitive: true },
    { name: "PATH", value: "/bundled/codex-path:/bin", sensitive: false },
  ]);
  for (const id of ["missing", "off"]) {
    expect(providers[`key_deepseek_${id}`]).toMatchObject({ enabled: false, environment: [] });
  }
});

it("preserves provider model metadata and a metadata-only change reloads Codex", () => {
  const models = [
    {
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      contextWindow: 1_048_576,
      reasoningEfforts: ["low", "high", "max", "future-level", "low", ""],
      defaultReasoningEffort: "high",
      images: true,
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek Pro",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "max",
    },
  ];
  const catalog = providerKeyCodexCatalog("codex", "deepseek", models)!;
  expect(JSON.parse(catalog.contents).models).toMatchObject([
    {
      slug: "deepseek-flash",
      // DeepSeek documents how Codex should drive its models.
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      input_modalities: ["text", "image"],
      default_reasoning_level: "high",
      supported_reasoning_levels: ["low", "high", "max", "future-level"].map((effort) => ({
        effort,
      })),
      auto_review_model_override: "deepseek-flash",
    },
    {
      slug: "deepseek-v4-pro",
      input_modalities: ["text"],
      default_reasoning_level: "high",
      auto_review_model_override: "deepseek-flash",
    },
  ]);
  expect(providerKeyCodexCatalog("codex", "deepseek", models)?.path).toBe(catalog.path);
  const updated = [{ ...models[0]!, contextWindow: 500_000 }, models[1]!];
  expect(providerKeyCodexCatalog("codex", "deepseek", updated)?.path).not.toBe(catalog.path);
});

it("offers no invented reasoning levels for an unknown model", () => {
  const catalog = providerKeyCodexCatalog("codex", "custom", [{ id: "model", name: "Model" }])!;
  const [model] = JSON.parse(catalog.contents).models;
  expect(model).toMatchObject({
    // Codex's own defaults for a model it doesn't know, with its own instructions.
    context_window: 272_000,
    shell_type: "unified_exec",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    model_messages: { instructions_template: CODEX_DEFAULT_INSTRUCTIONS },
    input_modalities: ["text"],
    supported_reasoning_levels: [],
    auto_review_model_override: "model",
  });
  expect(model.default_reasoning_level).toBeUndefined();

  const catalogWithDefault = providerKeyCodexCatalog("codex", "custom", [
    { id: "model", name: "Model", defaultReasoningEffort: "low" },
  ])!;
  expect(JSON.parse(catalogWithDefault.contents).models[0]).toMatchObject({
    default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low" }],
  });
});

it("requests components only for the Agents of enabled API key connections", () => {
  const codex = { agent: "codex", enabled: true } as const;
  const claude = { agent: "claudeAgent", enabled: true } as const;
  expect(providerKeyComponentDemand([{ ...codex, enabled: false }])).toEqual({
    codex: false,
    claudeCode: false,
  });
  expect(providerKeyComponentDemand([codex, { ...claude, enabled: false }])).toEqual({
    codex: true,
    claudeCode: false,
  });
  expect(providerKeyComponentDemand([claude])).toEqual({ codex: false, claudeCode: true });
  expect(providerKeyComponentDemand([codex, claude])).toEqual({ codex: true, claudeCode: true });
});
