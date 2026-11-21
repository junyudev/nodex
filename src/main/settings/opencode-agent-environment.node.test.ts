import { parse as parseToml } from "smol-toml";
import { AntigravityAgentSettingsUpdateSchema } from "../../shared/antigravity-agent-settings";
import {
  getAntigravityAgentSettings,
  getAntigravityLaunchConfiguration,
  updateAntigravityAgentSettings,
} from "./application-settings-persistence";
import {
  readStoredAntigravityInstances,
  writeAntigravityInstances,
} from "./antigravity-agent-environment";
import { afterEach, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultOpenCodeInstance,
  OpenCodeAgentSettingsUpdateSchema,
} from "../../shared/opencode-agent-settings";
import {
  getOpenCodeAgentSettings,
  getOpenCodeLaunchConfiguration,
  updateOpenCodeAgentSettings,
} from "./application-settings-persistence";
import { readStoredOpenCodeInstances, writeOpenCodeInstances } from "./opencode-agent-environment";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-opencode-settings-"));
  roots.push(root);
  return {
    root,
    environment: {},
    hostHomeDirectory: root,
    settingsPath: path.join(root, "config.toml"),
    secretEncryption: {
      isAvailable: () => true,
      encryptString: (text: string) => Buffer.from(Buffer.from(text).toString("base64")),
      decryptString: (bytes: Buffer) => Buffer.from(bytes.toString(), "base64").toString(),
    },
  };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const instance = () => ({ ...defaultOpenCodeInstance(), enabled: true });

it("enables OpenCode for unconfigured profiles and preserves an explicitly disabled instance", () => {
  const source = fixture();
  expect(getOpenCodeAgentSettings(source).instances[0]?.enabled).toBe(true);
  updateOpenCodeAgentSettings(
    { instances: [{ ...defaultOpenCodeInstance(), enabled: false }] },
    source,
  );
  expect(getOpenCodeAgentSettings(source).instances[0]?.enabled).toBe(false);
  expect(() => getOpenCodeLaunchConfiguration(source, "opencode-default")).toThrow(
    "unavailable or disabled",
  );
});

it("keeps managed profiles isolated by explicit instance identity and supports removing all instances", () => {
  const source = fixture();
  updateOpenCodeAgentSettings(
    { instances: [instance(), { ...instance(), id: "second-account" }] },
    source,
  );
  expect(getOpenCodeLaunchConfiguration(source, "opencode-default").profileDirectory).toBe(
    path.join(source.root, "agents/opencode/opencode-default"),
  );
  expect(getOpenCodeLaunchConfiguration(source, "second-account").profileDirectory).toBe(
    path.join(source.root, "agents/opencode/second-account"),
  );
  updateOpenCodeAgentSettings({ instances: [] }, source);
  expect(getOpenCodeAgentSettings(source).instances).toEqual([]);
  expect(() => getOpenCodeLaunchConfiguration(source, "opencode-default")).toThrow(
    "unavailable or disabled",
  );
});

it("redacts secrets, preserves saved markers and resolves exact profile configuration only at launch", () => {
  const source = fixture();
  const saved = updateOpenCodeAgentSettings(
    {
      instances: [
        {
          ...instance(),
          profileDirectory: "~/my-opencode",
          environment: [
            { name: "MOONSHOT_API_KEY", sensitive: true, value: "fixture-only-key" },
            { name: "OPENCODE_SERVER_PASSWORD", sensitive: true, value: "fixture-server-password" },
          ],
        },
      ],
    },
    source,
  );
  expect(saved.instances[0]?.profileDirectory).toBe(path.join(source.root, "my-opencode"));
  expect(saved.instances[0]?.environment).toEqual([
    { name: "MOONSHOT_API_KEY", sensitive: true, value: null },
    { name: "OPENCODE_SERVER_PASSWORD", sensitive: true, value: null },
  ]);
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("fixture-only-key");
  const refs = readdirSync(path.join(source.root, "agent-secrets/opencode"));
  updateOpenCodeAgentSettings(saved, source);
  expect(readdirSync(path.join(source.root, "agent-secrets/opencode"))).toEqual(refs);
  expect(getOpenCodeLaunchConfiguration(source, "opencode-default")).toMatchObject({
    profileDirectory: path.join(source.root, "my-opencode"),
    environment: {
      MOONSHOT_API_KEY: "fixture-only-key",
      OPENCODE_SERVER_PASSWORD: "fixture-server-password",
    },
  });
  expect(() =>
    updateOpenCodeAgentSettings(
      { instances: [{ ...saved.instances[0]!, id: "another-account" }] },
      source,
    ),
  ).toThrow("Enter a value");
});

it("retains the previous encrypted references if publishing settings fails", () => {
  const source = fixture();
  const saved = updateOpenCodeAgentSettings(
    {
      instances: [
        {
          ...instance(),
          environment: [{ name: "MOONSHOT_API_KEY", sensitive: true, value: "original-key" }],
        },
      ],
    },
    source,
  );
  const directory = path.join(source.root, "agent-secrets/opencode");
  const refs = readdirSync(directory);
  const previous = JSON.parse(JSON.stringify(saved.instances));
  const secretRef = refs[0];
  previous[0].environment = [{ name: "MOONSHOT_API_KEY", sensitive: true, secretRef }];
  expect(() =>
    writeOpenCodeInstances(
      source,
      {
        instances: [
          {
            ...instance(),
            environment: [{ name: "MOONSHOT_API_KEY", sensitive: true, value: "replacement-key" }],
          },
        ],
      },
      readStoredOpenCodeInstances(previous),
      () => {
        throw new Error("publish failed");
      },
    ),
  ).toThrow("publish failed");
  expect(readdirSync(directory)).toEqual(refs);
  expect(
    getOpenCodeLaunchConfiguration(source, "opencode-default").environment.MOONSHOT_API_KEY,
  ).toBe("original-key");
});

it("rejects credential-bearing server URLs and overrides of native profile paths", () => {
  for (const overrides of [
    { serverUrl: "https://user:password@server.example" },
    { serverUrl: "file:///tmp/server" },
    { environment: [{ name: "XDG_DATA_HOME", sensitive: false, value: "/tmp/shared" }] },
    { environment: [{ name: "OPENCODE_CONFIG_CONTENT", sensitive: false, value: "{}" }] },
  ])
    expect(
      OpenCodeAgentSettingsUpdateSchema.safeParse({ instances: [{ ...instance(), ...overrides }] })
        .success,
    ).toBe(false);
});

// Antigravity uses the same Profile secret transaction with one account key per instance.
it("starts Antigravity empty, redacts keys and preserves them through edits and disable", () => {
  const source = fixture();
  expect(getAntigravityAgentSettings(source)).toEqual({ instances: [] });
  const saved = updateAntigravityAgentSettings(
    {
      instances: [
        {
          id: "google-work",
          displayName: "Work",
          enabled: true,
          apiKey: "fixture-google-key",
          gcpProject: "project",
          gcpLocation: "us-central1",
          binaryPath: "",
        },
      ],
    },
    source,
  );
  expect(saved.instances[0]).toMatchObject({
    authMethod: "oauth-personal",
    apiKey: null,
    hasApiKey: true,
  });
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("fixture-google-key");
  const directory = path.join(source.root, "agent-secrets/antigravity");
  const refs = readdirSync(directory);
  const { hasApiKey: _saved, ...instance } = saved.instances[0]!;
  updateAntigravityAgentSettings(
    { instances: [{ ...instance, displayName: "Renamed", enabled: false }] },
    source,
  );
  expect(() => getAntigravityLaunchConfiguration(source, instance.id)).toThrow("disabled");
  expect(readdirSync(directory)).toEqual(refs);
  updateAntigravityAgentSettings({ instances: [instance] }, source);
  expect(getAntigravityLaunchConfiguration(source, instance.id).apiKey).toBe("fixture-google-key");
  updateAntigravityAgentSettings(
    { instances: [{ ...instance, apiKey: "replacement-key" }] },
    source,
  );
  expect(readdirSync(directory)).toHaveLength(1);
  expect(readdirSync(directory)).not.toEqual(refs);
  updateAntigravityAgentSettings({ instances: [{ ...instance, apiKey: "" }] }, source);
  expect(getAntigravityAgentSettings(source).instances[0]?.hasApiKey).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
  updateAntigravityAgentSettings({ instances: [{ ...instance, apiKey: "remove-me" }] }, source);
  updateAntigravityAgentSettings({ instances: [] }, source);
  expect(readdirSync(directory)).toEqual([]);
});

it("keeps Antigravity keys bound to an account and rolls back staged keys on failed publication", () => {
  const source = fixture();
  const instance = {
    id: "account",
    displayName: "Account",
    enabled: true,
    authMethod: "gemini-api-key" as const,
    apiKey: "original-key",
    gcpProject: "",
    gcpLocation: "",
    binaryPath: "",
  };
  updateAntigravityAgentSettings({ instances: [instance] }, source);
  const document = parseToml(readFileSync(source.settingsPath, "utf8")) as {
    server: { antigravity_agent_instances: unknown[] };
  };
  const previous = readStoredAntigravityInstances(document.server.antigravity_agent_instances);
  const directory = path.join(source.root, "agent-secrets/antigravity");
  const refs = readdirSync(directory);
  expect(() =>
    writeAntigravityInstances(
      source,
      { instances: [{ ...instance, apiKey: "staged-key" }] },
      previous,
      () => {
        throw new Error("publish failed");
      },
    ),
  ).toThrow("publish failed");
  expect(readdirSync(directory)).toEqual(refs);
  expect(getAntigravityLaunchConfiguration(source, "account").apiKey).toBe("original-key");
  expect(() => getAntigravityLaunchConfiguration(source, "other-account")).toThrow("unavailable");
  for (const instances of [
    [instance, instance],
    Array.from({ length: 33 }, (_, index) => ({ ...instance, id: `a${index}` })),
    [{ ...instance, authMethod: "ambient-google" }],
    [{ ...instance, environment: [] }],
    [{ ...instance, customModels: [] }],
  ])
    expect(AntigravityAgentSettingsUpdateSchema.safeParse({ instances }).success).toBe(false);
});
