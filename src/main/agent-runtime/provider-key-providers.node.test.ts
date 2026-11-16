import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, isModelOn, spendsNodexCredit } from "../../shared/model-policy";
import type { ProviderKeyConnection } from "../../shared/provider-keys";
import { providerKeyProviders } from "./provider-key-providers";

it("declares isolated bundled Claude providers with their own models and credentials", () => {
  const connection: ProviderKeyConnection = {
    id: "id-1",
    preset: "custom",
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
  const providers = providerKeyProviders({
    home: "profile",
    environment: {
      PATH: "/bin",
      HTTPS_PROXY: "https://proxy.example",
      HOME: "/home",
      ANTHROPIC_API_KEY: "other-credential",
      OPENAI_API_KEY: "other-credential",
      CLAUDE_CONFIG_DIR: "other-home",
    },
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
  expect(Object.fromEntries(provider.environment.map(({ name, value }) => [name, value]))).toEqual({
    PATH: "/bin",
    HTTPS_PROXY: "https://proxy.example",
    HOME: "/home",
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
