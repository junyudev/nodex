import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, it } from "vite-plus/test";
import { legacyAgentInstanceId } from "../../shared/agents/legacy-identity";
import {
  antigravityProfile,
  claudeProfile,
  openCodeProfile,
} from "../../shared/agents/profile.test-fixtures";
import { antigravityAgent } from "../../shared/agents/antigravity";
import {
  agentProfileInput,
  agentProfilesFor,
  createAgentProfile,
  parseAgentProfilesUpdate,
  type AgentProfileInput,
} from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import { openCodeProfileDirectory } from "../agent-backend/opencode/OpenCodeProfileProvider";
import type { SecretEncryptionAdapter } from "../platform/SecretEncryption";
import {
  getAgentProfiles,
  getAgentProfileLaunchConfiguration,
  migrateProfileAgentProfiles,
  updateAgentProfiles,
} from "./application-settings-persistence";
import { readStoredAgentProfiles, writeAgentProfiles } from "./agent-profile-store";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-agent-profiles-"));
  roots.push(root);
  const key = randomBytes(32);
  const secretEncryption: SecretEncryptionAdapter = {
    isAvailable: () => true,
    encryptString: (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
  return {
    root,
    hostHomeDirectory: root,
    environment: {},
    settingsPath: path.join(root, "config.toml"),
    secretEncryption,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = ReturnType<typeof fixture>;
const read = <Driver extends ProfileAgentDriver>(source: Fixture, driver: Driver) =>
  agentProfilesFor(getAgentProfiles(source), driver);
const save = (source: Fixture, driver: ProfileAgentDriver, instances: AgentProfileInput[]) => {
  updateAgentProfiles({ driver, instances }, source);
  return read(source, driver);
};
const document = (source: Fixture) =>
  parse(readFileSync(source.settingsPath, "utf8")).server as Record<string, unknown>;
const secretDir = ({ root }: Fixture, driver: string) => path.join(root, "agent-secrets", driver);
const secret = (name: string, value: string | null) => ({ name, value, sensitive: true as const });
const configWithKey = (
  apiKey: string | null,
  authMethod: "gemini-api-key" | "oauth-personal" = "gemini-api-key",
) => ({
  ...agentProfileInput(antigravityProfile()),
  settings: { apiKey, authMethod, gcpProject: "", gcpLocation: "" },
});

it.each([
  { profile: claudeProfile(), name: "ANTHROPIC_AUTH_TOKEN" },
  { profile: openCodeProfile(), name: "OPENCODE_SERVER_PASSWORD" },
])(
  "stages, redacts, retains and retires environment secrets for $profile.driver",
  ({ profile, name }) => {
    const source = fixture();
    const { driver, id } = profile;
    const input = {
      ...agentProfileInput(profile),
      environment: [secret(name, "test-only-secret"), secret("EMPTY", "")],
    };
    const [saved] = save(source, driver, [input]);
    expect(saved?.environment).toEqual([secret(name, null), secret("EMPTY", null)]);
    const directory = secretDir(source, driver);
    const refs = readdirSync(directory);
    expect(refs).toHaveLength(2);
    expect(document(source)).toHaveProperty("agent_instances");
    expect(readFileSync(source.settingsPath, "utf8")).not.toContain("test-only-secret");
    for (const ref of refs) {
      const file = path.join(directory, ref);
      expect(readFileSync(file).includes(Buffer.from("test-only-secret"))).toBe(false);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    save(source, driver, [agentProfileInput(saved!)]);
    expect(readdirSync(directory)).toEqual(refs);
    expect(getAgentProfileLaunchConfiguration(source, driver, id).environment).toEqual({
      [name]: "test-only-secret",
      EMPTY: "",
    });
    expect(() =>
      save(source, driver, [{ ...agentProfileInput(saved!), id: "different-owner" }]),
    ).toThrow("Enter a value");
    save(source, driver, []);
    expect(readdirSync(directory)).toEqual([]);
    expect(read(source, driver)).toEqual([]);
  },
);

it("rejects duplicate routing IDs across drivers and leaves the other driver enabled", () => {
  const source = fixture();
  const claude = claudeProfile();
  expect(() =>
    save(source, "opencode", [agentProfileInput(openCodeProfile({ id: claude.id }))]),
  ).toThrow("Duplicate Agent profile identity");
  const openCode = openCodeProfile({ enabled: false });
  save(source, "opencode", [agentProfileInput(openCode)]);
  expect(read(source, "claudeAgent")).toEqual([claude]);
  expect(read(source, "opencode")).toEqual([openCode]);
  expect(() => getAgentProfileLaunchConfiguration(source, openCode.driver, openCode.id)).toThrow(
    "unavailable or disabled",
  );
});

it("normalizes both path fields against the host home and keeps Claude custom model traits", () => {
  const source = fixture();
  const model = {
    id: "gateway/private-opus",
    displayName: "Private Opus",
    traits: { fastMode: true, contextWindows: ["1m"] },
  };
  const claude = claudeProfile({
    settings: { configDirectory: "~/claude-work", customModels: [model] },
  });
  save(source, claude.driver, [agentProfileInput(claude)]);
  expect(read(source, claude.driver)[0]?.settings).toEqual({
    configDirectory: path.join(source.root, "claude-work"),
    customModels: [model],
  });
  expect(() =>
    save(source, claude.driver, [
      agentProfileInput({
        ...claude,
        settings: { ...claude.settings, customModels: [model, model] },
      }),
    ]),
  ).toThrow("Invalid Claude Code settings");
  const openCode = openCodeProfile({
    settings: { profileDirectory: "~/opencode-work", serverUrl: null },
  });
  save(source, openCode.driver, [
    agentProfileInput(openCode),
    agentProfileInput(openCodeProfile({ id: "second-account" })),
  ]);
  const [custom, managed] = read(source, openCode.driver);
  expect(openCodeProfileDirectory(custom!, source.settingsPath)).toBe(
    path.join(source.root, "opencode-work"),
  );
  expect(openCodeProfileDirectory(managed!, source.settingsPath)).toBe(
    path.join(source.root, "agents", "opencode", "second-account"),
  );
});

it.each([
  [
    "claudeAgent",
    {
      ...agentProfileInput(claudeProfile()),
      environment: [secret("CLAUDE_CONFIG_DIR", "override")],
    },
  ],
  [
    "claudeAgent",
    { ...agentProfileInput(claudeProfile()), settings: { configDirectory: "relative-folder" } },
  ],
  [
    "opencode",
    { ...agentProfileInput(openCodeProfile()), environment: [secret("XDG_DATA_HOME", "override")] },
  ],
  [
    "opencode",
    {
      ...agentProfileInput(openCodeProfile()),
      settings: { serverUrl: "https://user:password@server.example" },
    },
  ],
  [
    "opencode",
    { ...agentProfileInput(openCodeProfile()), settings: { serverUrl: "file:///tmp/server" } },
  ],
  ["antigravity", { ...configWithKey("test"), environment: [] }],
  ["antigravity", { ...configWithKey("test"), settings: { authMethod: "unrecognized" } }],
  ["antigravity", agentProfileInput(claudeProfile())],
])("rejects invalid %s updates", (driver, profile) => {
  expect(() => parseAgentProfilesUpdate({ driver, instances: [profile] })).toThrow();
});

it("starts Antigravity with one profile that uses agy on this computer, and only one can", () => {
  const source = fixture();
  expect(read(source, "antigravity")).toEqual([
    expect.objectContaining({
      id: antigravityAgent.profile.initialId,
      enabled: true,
      settings: expect.objectContaining({ authMethod: "computer" }),
    }),
  ]);
  const computer = agentProfileInput(antigravityProfile());
  // A new profile beside it signs in on its own.
  const second = createAgentProfile(antigravityAgent, "antigravity-second", [computer]);
  expect(second.settings.authMethod).toBe("oauth-personal");
  expect(() =>
    save(source, "antigravity", [
      computer,
      { ...agentProfileInput(second), settings: { ...second.settings, authMethod: "computer" } },
    ]),
  ).toThrow("Only one Antigravity profile can use agy on this computer.");
  expect(save(source, "antigravity", [computer, agentProfileInput(second)])).toHaveLength(2);
});

it("keeps a saved Antigravity key through edits and clears it when a method stops reading it", () => {
  const source = fixture();
  const profile = configWithKey("first-key");
  save(source, "antigravity", [profile]);
  expect(read(source, "antigravity")[0]).toMatchObject({
    savedSecrets: ["apiKey"],
    settings: { apiKey: null },
  });
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("first-key");
  const directory = secretDir(source, "antigravity");
  const original = readdirSync(directory);
  save(source, "antigravity", [{ ...configWithKey(null), enabled: false }]);
  expect(() => getAgentProfileLaunchConfiguration(source, "antigravity", profile.id)).toThrow(
    "disabled",
  );
  save(source, "antigravity", [configWithKey(null)]);
  expect(readdirSync(directory)).toEqual(original);
  expect(getAgentProfileLaunchConfiguration(source, "antigravity", profile.id).secrets.apiKey).toBe(
    "first-key",
  );
  save(source, "antigravity", [configWithKey("next-key")]);
  expect(readdirSync(directory)).not.toEqual(original);
  save(source, "antigravity", [configWithKey("")]);
  expect(readdirSync(directory)).toEqual([]);
  save(source, "antigravity", [configWithKey("remove-me")]);
  save(source, "antigravity", [configWithKey("unused-key", "oauth-personal")]);
  expect(read(source, "antigravity")[0]?.savedSecrets).toEqual([]);
  expect(getAgentProfileLaunchConfiguration(source, "antigravity", profile.id).secrets).toEqual({});
  expect(readdirSync(directory)).toEqual([]);
  save(source, "antigravity", [configWithKey("remove-profile")]);
  save(source, "antigravity", []);
  expect(readdirSync(directory)).toEqual([]);
});

it.each([
  { old: configWithKey("original"), replacement: configWithKey("replacement") },
  {
    old: { ...agentProfileInput(openCodeProfile()), environment: [secret("API_KEY", "original")] },
    replacement: {
      ...agentProfileInput(openCodeProfile()),
      environment: [secret("API_KEY", "replacement")],
    },
  },
])("rolls back staged secrets for $old.driver if publication fails", ({ old, replacement }) => {
  const source = fixture();
  save(source, old.driver, [old]);
  const previous = readStoredAgentProfiles(document(source).agent_instances);
  const directory = secretDir(source, old.driver);
  const refs = readdirSync(directory);
  expect(() =>
    writeAgentProfiles(source, { driver: old.driver, instances: [replacement] }, previous, () => {
      throw new Error("publish failed");
    }),
  ).toThrow("publish failed");
  expect(readdirSync(directory)).toEqual(refs);
  expect(getAgentProfileLaunchConfiguration(source, old.driver, old.id)).toEqual(
    expect.objectContaining(
      old.driver === "antigravity"
        ? { secrets: { apiKey: "original" } }
        : { environment: { API_KEY: "original" } },
    ),
  );
});

it("rejects an oversized document without retiring old references or retaining staged secrets", () => {
  const source = fixture();
  const base = agentProfileInput(claudeProfile());
  const input = { ...base, environment: [secret("TOKEN", "original")] };
  const [original] = save(source, base.driver, [input]);
  const before = readFileSync(source.settingsPath);
  const large = [
    secret("TOKEN", "new-token"),
    ...Array.from({ length: 40 }, (_, index) => ({
      name: `VALUE_${index}`,
      sensitive: false as const,
      value: "a".repeat(32_768),
    })),
  ];
  expect(() => save(source, base.driver, [{ ...input, environment: large }])).toThrow(
    "Settings document exceeds",
  );
  expect(readFileSync(source.settingsPath)).toEqual(before);
  expect(read(source, base.driver)).toEqual([original]);
  expect(readdirSync(secretDir(source, base.driver))).toHaveLength(1);
});

function legacyRef(
  source: Fixture,
  namespace: string,
  instanceId: string,
  name: string,
  value: string,
) {
  const ref = randomUUID();
  const directory = secretDir(source, namespace);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, ref),
    source.secretEncryption.encryptString(JSON.stringify({ instanceId, name, value })),
  );
  return ref;
}

it.each([false, true])(
  "migrates all three legacy tables, including a previously re-keyed Profile (%s)",
  (rekeyed) => {
    const source = fixture();
    const storedId = (kind: "claude" | "opencode" | "antigravity", id: string) =>
      rekeyed ? legacyAgentInstanceId(kind, id) : id;
    const claudeId = storedId("claude", "claude-work");
    const openCodeId = storedId("opencode", "opencode-work");
    const antigravityId = storedId("antigravity", "antigravity-work");
    const oldClaudeRef = legacyRef(source, "claude", claudeId, "TOKEN", "claude-secret");
    const oldOpenCodeRef = legacyRef(source, "opencode", openCodeId, "PASSWORD", "opencode-secret");
    const oldKeyRef = legacyRef(
      source,
      "antigravity",
      antigravityId,
      "apiKey",
      "antigravity-secret",
    );
    const managed = path.join(source.root, "agents", "opencode", openCodeId);
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      source.settingsPath,
      stringify({
        server: {
          ...(rekeyed ? { agent_instance_identity_version: 1 } : {}),
          claude_agent_instances: [
            {
              id: claudeId,
              displayName: "Router",
              binaryPath: "claude",
              configDirectory: "",
              enabled: true,
              environment: [
                { name: "TOKEN", sensitive: true, secretRef: oldClaudeRef },
                { name: "INLINE_TOKEN", sensitive: true, value: "legacy-inline-secret" },
                { name: "BASE_URL", sensitive: false, value: "https://router.example" },
              ],
            },
          ],
          opencode_agent_instances: [
            {
              id: openCodeId,
              displayName: "Work",
              binaryPath: "opencode",
              enabled: true,
              environment: [{ name: "PASSWORD", sensitive: true, secretRef: oldOpenCodeRef }],
            },
            {
              id: storedId("opencode", "disabled-work"),
              displayName: "Off",
              binaryPath: "opencode",
              enabled: false,
            },
          ],
          antigravity_agent_instances: [
            {
              id: antigravityId,
              displayName: "Key",
              binaryPath: "",
              enabled: true,
              authMethod: "gemini-api-key",
              apiKeyRef: oldKeyRef,
              gcpProject: "",
              gcpLocation: "",
            },
          ],
        },
      }),
    );
    migrateProfileAgentProfiles(source);
    const id = legacyAgentInstanceId;
    expect(
      getAgentProfileLaunchConfiguration(source, "claudeAgent", id("claude", "claude-work"))
        .environment,
    ).toEqual({
      TOKEN: "claude-secret",
      INLINE_TOKEN: "legacy-inline-secret",
      BASE_URL: "https://router.example",
    });
    const openCode = getAgentProfileLaunchConfiguration(
      source,
      "opencode",
      id("opencode", "opencode-work"),
    );
    expect(openCodeProfileDirectory(openCode.profile, source.settingsPath)).toBe(managed);
    expect(openCode.environment).toEqual({ PASSWORD: "opencode-secret" });
    expect(read(source, "opencode")[1]).toMatchObject({
      id: id("opencode", "disabled-work"),
      enabled: false,
    });
    expect(
      getAgentProfileLaunchConfiguration(
        source,
        "antigravity",
        id("antigravity", "antigravity-work"),
      ).secrets,
    ).toEqual({ apiKey: "antigravity-secret" });
    expect(readdirSync(secretDir(source, "claude"))).toEqual([]);
    expect(readdirSync(secretDir(source, "antigravity"))).not.toContain(oldKeyRef);
    expect(Object.keys(document(source))).toEqual(["agent_instances"]);
    const published = readFileSync(source.settingsPath, "utf8");
    expect(published).not.toMatch(/(?:claude|opencode|antigravity|legacy-inline)-secret/u);
    migrateProfileAgentProfiles(source);
    expect(readFileSync(source.settingsPath, "utf8")).toBe(published);
  },
);

it("retains the legacy OpenCode directory even with no explicit profile settings", () => {
  const source = fixture();
  const home = path.join(source.root, "agents/opencode/opencode-default");
  mkdirSync(home, { recursive: true });
  migrateProfileAgentProfiles(source);
  expect(read(source, "opencode")[0]).toMatchObject({
    id: openCodeProfile().id,
    settings: { profileDirectory: home },
  });
});
