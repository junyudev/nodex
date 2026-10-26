import { expect, it } from "vitest";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { ConfigLayerSource } from "@nodex/codex-app-server-protocol/v2/ConfigLayerSource";
import { pluginAppPolicy } from "./PluginAppPolicy";
const config = (
  name?: ConfigLayerSource,
  key = "apps.connector_test.enabled",
  apps: unknown = { connector_test: { enabled: false } },
): ConfigReadResponse =>
  ({
    config: { apps },
    origins: name ? { [key]: { name, version: "v1" } } : {},
    layers: [
      {
        name: { type: "user", file: "/config.toml", profile: null },
        version: "v1",
        config: {},
        disabledReason: null,
      },
    ],
  }) as ConfigReadResponse;
it("allows user/default app switches while protecting managed, profile, project and session origins", () => {
  for (const name of [
    undefined,
    { type: "user", file: "/config.toml", profile: null },
    { type: "system", file: "/etc/config.toml" },
  ] as const)
    expect(pluginAppPolicy(config(name), "connector_test").editable).toBe(true);
  for (const name of [
    { type: "enterpriseManaged", id: "org", name: "Org" },
    { type: "mdm", domain: "app", key: "config" },
    { type: "project", dotCodexFolder: "/repo/.codex" },
    { type: "sessionFlags" },
    { type: "user", file: "/config.toml", profile: "work" },
  ] as const)
    expect(pluginAppPolicy(config(name), "connector_test").editRestriction?.code).toBe(
      "policy_denied",
    );
  expect(pluginAppPolicy(config(), "connector_test", true).editable).toBe(false);
  expect(pluginAppPolicy(null, "connector_test").editRestriction?.code).toBe(
    "inventory_unavailable",
  );
});
it("applies default restrictions and cannot bypass connector alias policy", () => {
  const managed = { type: "enterpriseManaged", id: "org", name: "Org" } as const;
  expect(
    pluginAppPolicy(
      config(managed, "apps._default.enabled", { _default: { enabled: false } }),
      "connector_test",
    ).editable,
  ).toBe(false);
  expect(pluginAppPolicy(config(managed), "asdk_app_test").editable).toBe(false);
  expect(pluginAppPolicy(config(), "asdk_app_test").configKey).toBe("connector_test");
});
