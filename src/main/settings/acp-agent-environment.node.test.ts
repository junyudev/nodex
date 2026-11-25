import { afterEach, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { isProviderInstanceId } from "@nodex/agent-runtime/contracts";
import {
  AcpAgentSettingsUpdateSchema,
  type AcpAgentInstanceInput,
} from "../../shared/acp-agent-settings";
import {
  getAcpAgentSettings,
  getAcpLaunchConfiguration,
  getAgentProfiles,
  getAgentRuntimeSettings,
  getInboxSettings,
  getModelPolicy,
  migrateProfileAgentProfiles,
  updateAcpAgentSettings,
} from "./application-settings-persistence";
import { readStoredAcpInstances, writeAcpInstances } from "./acp-agent-environment";
import { withAgentSecretChanges } from "./agent-environment-storage";
const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-acp-settings-"));
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
const instance = (): AcpAgentInstanceInput => ({
  id: "qoder-personal",
  agentDefinitionId: "qoder",
  displayName: "Qoder",
  enabled: true,
  source: {
    kind: "local",
    executable: "qodercli",
    args: ["--acp", "argument with spaces", "$(literal)"],
  },
  environment: [],
  credentials: { kind: "inherit-host-profile" },
  proxy: "isolated",
  customModels: [],
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("migrates local package settings without changing identity or requiring the old package to exist", () => {
  const source = fixture();
  writeFileSync(
    source.settingsPath,
    stringify({
      server: {
        acp_agent_instances: [
          {
            id: "packaged-main",
            agentDefinitionId: "packaged-agent",
            packageRoot: "/missing/package",
            nodeExecutable: "/missing/node",
            enabled: true,
            credentials: { kind: "isolated-home", home: "/old/home" },
            proxy: "inherit-host",
          },
        ],
      },
    }),
  );
  const migrated = getAcpAgentSettings(source);
  expect(migrated.instances[0]).toMatchObject({
    id: "packaged-main",
    agentDefinitionId: "packaged-agent",
    source: {
      kind: "local",
      executable: "/missing/node",
      args: [path.normalize("/missing/package/dist/index.js")],
    },
    credentials: { kind: "isolated-home", home: "/old/home" },
    proxy: "inherit-host",
  });
  updateAcpAgentSettings(migrated, source);
  expect(getAcpAgentSettings(source)).toEqual(migrated);
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("packageRoot");
});
it("repairs invalid routing IDs and keeps Profile choices, credentials and storage in place", () => {
  const source = fixture();
  const oldId = "0e09b4cb-93f2-4137-b171-43cd32579819";
  const home = path.join(source.root, oldId);
  mkdirSync(home);
  writeFileSync(path.join(home, "credential"), "native credential");
  const oldRef = withAgentSecretChanges(({ stage }) =>
    stage({ ...source, backend: "acp" }, oldId, "QODER_TOKEN", "local-secret"),
  );
  const valid = { ...instance(), id: "a-canonical-id" };
  const model = "provider-specific/model";
  const unrelatedException = JSON.stringify(["codex", oldId]);
  writeFileSync(
    source.settingsPath,
    stringify({
      server: {
        agent_instances: [],
        acp_agent_instances: [
          valid,
          {
            ...instance(),
            id: oldId,
            agentDefinitionId: `local-${oldId}`,
            credentials: { kind: "isolated-home", home },
            environment: [
              { name: "QODER_TOKEN", sensitive: true, secretRef: oldRef },
              { name: "QODER_CONFIG_DIR", sensitive: false, value: home },
            ],
          },
        ],
        inbox_chat_agent: oldId,
        inbox_chat_model: model,
        inbox_suggestion_agent: oldId,
        writing_model: { instanceId: oldId, model },
        title_model: { instanceId: oldId, model: "old-title-model" },
        model_policy: {
          nodexOff: false,
          exceptions: [JSON.stringify([oldId, model]), unrelatedException],
          agentsMayChooseCredit: false,
        },
      },
    }),
  );
  expect(() => getAcpAgentSettings(source)).toThrow("Invalid saved ACP Agent settings");

  migrateProfileAgentProfiles(source);

  const [unchanged, repaired] = getAcpAgentSettings(source).instances;
  expect(unchanged).toEqual(valid);
  expect(repaired?.id).not.toBe(oldId);
  expect(isProviderInstanceId(repaired?.id)).toBe(true);
  const id = repaired!.id;
  expect(repaired).toMatchObject({
    agentDefinitionId: `local-${oldId}`,
    credentials: { kind: "isolated-home", home },
    environment: [
      { name: "QODER_TOKEN", sensitive: true, value: null },
      { name: "QODER_CONFIG_DIR", sensitive: false, value: home },
    ],
  });
  expect(getAcpLaunchConfiguration(source, id).environment).toEqual({
    QODER_TOKEN: "local-secret",
    QODER_CONFIG_DIR: home,
  });
  expect(readFileSync(path.join(home, "credential"), "utf8")).toBe("native credential");
  expect(getInboxSettings(source)).toMatchObject({
    chatAgent: { instanceId: id, model },
    suggestionAgent: { instanceId: id },
  });
  expect(getAgentRuntimeSettings(source).writingModel).toEqual({ instanceId: id, model });
  expect(getModelPolicy(source).exceptions).toEqual([
    JSON.stringify([id, model]),
    unrelatedException,
  ]);
  const migrated = readFileSync(source.settingsPath, "utf8");
  expect(parse(migrated)).toMatchObject({
    server: { title_model: { instanceId: id, model: "old-title-model" } },
  });
  const directory = path.join(source.root, "agent-secrets/acp");
  const refs = readdirSync(directory);
  expect(refs).toHaveLength(1);
  expect(refs).not.toContain(oldRef);

  migrateProfileAgentProfiles(source);
  expect(readFileSync(source.settingsPath, "utf8")).toBe(migrated);
  expect(readdirSync(directory)).toEqual(refs);
});

it.each([undefined, 1])(
  "repairs old package rows during legacy Profile migration (%s)",
  (version) => {
    const source = fixture();
    const longId = `a${"b".repeat(64)}`;
    const oldIds = [longId, "agent/with punctuation"];
    writeFileSync(
      source.settingsPath,
      stringify({
        server: {
          ...(version ? { agent_instance_identity_version: version } : {}),
          acp_agent_instances: oldIds.map((id) => ({
            id,
            agentDefinitionId: "packaged-agent",
            packageRoot: "/old/package",
            nodeExecutable: "/old/node",
            enabled: false,
            credentials: { kind: "inherit-host-profile" },
            proxy: "isolated",
          })),
          inbox_suggestion_agent: longId,
          model_policy: {
            providersOff: ["nodex", longId],
            exceptions: [JSON.stringify([longId, "example-model"])],
            agentsMayChooseCredit: false,
          },
        },
      }),
    );
    migrateProfileAgentProfiles(source);
    const ids = getAcpAgentSettings(source).instances.map(({ id }) => id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(isProviderInstanceId)).toBe(true);
    expect(getInboxSettings(source).suggestionAgent.instanceId).toBe(ids[0]);
    expect(getModelPolicy(source)).toEqual({
      nodexOff: true,
      exceptions: [JSON.stringify([ids[0], "example-model"])],
      agentsMayChooseCredit: false,
    });
  },
);

it("rejects new ACP settings rows with invalid runtime IDs", () => {
  for (const id of ["0starts-with-digit", "a".repeat(65), "contains spaces", "contains/slash"])
    expect(
      AcpAgentSettingsUpdateSchema.safeParse({ instances: [{ ...instance(), id }] }).success,
    ).toBe(false);
  expect(
    AcpAgentSettingsUpdateSchema.safeParse({ instances: [{ ...instance(), id: "a".repeat(64) }] })
      .success,
  ).toBe(true);
});

it("encrypts each instance's secrets, retains redacted markers and preserves arguments exactly", () => {
  const source = fixture();
  const saved = updateAcpAgentSettings(
    {
      instances: [
        {
          ...instance(),
          environment: [{ name: "QODER_TOKEN", sensitive: true, value: "personal-secret" }],
        },
        {
          ...instance(),
          id: "qoder-work",
          environment: [{ name: "QODER_TOKEN", sensitive: true, value: "work-secret" }],
        },
      ],
    },
    source,
  );
  expect(saved.instances[0]?.environment[0]?.value).toBeNull();
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("personal-secret");
  const refs = readdirSync(path.join(source.root, "agent-secrets/acp"));
  updateAcpAgentSettings(saved, source);
  expect(readdirSync(path.join(source.root, "agent-secrets/acp"))).toEqual(refs);
  expect(getAcpLaunchConfiguration(source, "qoder-personal").environment.QODER_TOKEN).toBe(
    "personal-secret",
  );
  expect(getAcpLaunchConfiguration(source, "qoder-work").environment.QODER_TOKEN).toBe(
    "work-secret",
  );
  expect(saved.instances[0]?.source).toEqual(instance().source);
  expect(() =>
    updateAcpAgentSettings({ instances: [{ ...saved.instances[0]!, id: "new-id" }] }, source),
  ).toThrow("Enter a value");
});
it("rolls back staged ciphertext when settings publication fails", () => {
  const source = fixture();
  const saved = updateAcpAgentSettings(
    {
      instances: [
        { ...instance(), environment: [{ name: "API_KEY", sensitive: true, value: "old" }] },
      ],
    },
    source,
  );
  const directory = path.join(source.root, "agent-secrets/acp");
  const refs = readdirSync(directory);
  const previous = readStoredAcpInstances([
    {
      ...saved.instances[0],
      environment: [{ name: "API_KEY", sensitive: true, secretRef: refs[0] }],
    },
  ]);
  expect(() =>
    writeAcpInstances(
      source,
      {
        instances: [
          { ...instance(), environment: [{ name: "API_KEY", sensitive: true, value: "new" }] },
        ],
      },
      previous,
      () => {
        throw new Error("write failed");
      },
    ),
  ).toThrow("write failed");
  expect(readdirSync(directory)).toEqual(refs);
  expect(getAcpLaunchConfiguration(source, "qoder-personal").environment.API_KEY).toBe("old");
});
it("rejects identity reuse and managed profile overrides without losing saved state", () => {
  const source = fixture();
  const saved = updateAcpAgentSettings({ instances: [instance()] }, source);
  expect(() =>
    updateAcpAgentSettings(
      { instances: [{ ...instance(), agentDefinitionId: "another" }] },
      source,
    ),
  ).toThrow("identity");
  expect(getAcpAgentSettings(source)).toEqual(saved);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "APPDATA", "NODE_OPTIONS"])
    expect(
      AcpAgentSettingsUpdateSchema.safeParse({
        instances: [{ ...instance(), environment: [{ name, sensitive: false, value: "/tmp" }] }],
      }).success,
    ).toBe(false);
  updateAcpAgentSettings({ instances: [{ ...instance(), enabled: false }] }, source);
  expect(() => getAcpLaunchConfiguration(source, "qoder-personal")).toThrow("disabled");
});

it("connects built-in Agents only as themselves", () => {
  const source = fixture();
  for (const duplicate of [
    { ...instance(), agentDefinitionId: "antigravity-acp" },
    {
      ...instance(),
      agentDefinitionId: "qoder",
      source: { kind: "registry" as const, agentId: "claude-acp", distribution: "auto" as const },
    },
  ])
    expect(() => updateAcpAgentSettings({ instances: [duplicate] }, source)).toThrow(
      "is built into Nodex",
    );
  expect(getAcpAgentSettings(source).instances).toEqual([]);
});

it("turns saved duplicates of built-in Agents into the built-in Agent and releases their secrets", () => {
  const source = fixture();
  const kept = instance();
  updateAcpAgentSettings(
    {
      instances: [
        kept,
        {
          ...instance(),
          id: "agy-terminal",
          agentDefinitionId: "agy",
          displayName: "Google Antigravity",
          source: { kind: "local", executable: "/usr/local/bin/agy", args: ["acp"] },
          environment: [{ name: "AGY_TOKEN", sensitive: true, value: "agy-secret" }],
        },
      ],
    },
    source,
  );
  const secrets = path.join(source.root, "agent-secrets/acp");
  expect(readdirSync(secrets)).toHaveLength(1);
  // Saved before built-in Agents claimed their Registry identities.
  const saved = parse(readFileSync(source.settingsPath, "utf8")) as {
    server: { agent_instances: unknown[]; acp_agent_instances: Record<string, unknown>[] };
  };
  saved.server.agent_instances = [];
  saved.server.acp_agent_instances = [
    ...saved.server.acp_agent_instances.map((entry) =>
      entry.id === "agy-terminal" ? { ...entry, agentDefinitionId: "antigravity-acp" } : entry,
    ),
    {
      id: "claude-package",
      agentDefinitionId: "claude-agent-acp",
      packageRoot: "/missing/package",
      nodeExecutable: "/missing/node",
      enabled: true,
      credentials: { kind: "inherit-host-profile" },
      proxy: "inherit-host",
    },
  ];
  writeFileSync(source.settingsPath, stringify(saved));

  migrateProfileAgentProfiles(source);
  expect(getAcpAgentSettings(source).instances.map(({ id }) => id)).toEqual([kept.id]);
  expect(readdirSync(secrets)).toEqual([]);
  expect(getAgentProfiles(source).filter(({ driver }) => driver === "antigravity")).toEqual([
    expect.objectContaining({
      displayName: "Google Antigravity",
      enabled: true,
      binaryPath: "",
      settings: expect.objectContaining({ authMethod: "computer" }),
    }),
  ]);
});

it("keeps saved native profile identity stable while permitting tokens and executable upgrades", () => {
  const source = fixture();
  const configured = {
    ...instance(),
    environment: [{ name: "AGENT_CONFIG_DIR", sensitive: false as const, value: "/profiles/one" }],
  };
  updateAcpAgentSettings({ instances: [configured] }, source);
  expect(() =>
    updateAcpAgentSettings(
      {
        instances: [
          { ...configured, credentials: { kind: "isolated-home", home: "/profiles/other" } },
        ],
      },
      source,
    ),
  ).toThrow("profile location");
  expect(() =>
    updateAcpAgentSettings(
      {
        instances: [
          {
            ...configured,
            environment: [{ name: "AGENT_CONFIG_DIR", sensitive: false, value: "/profiles/two" }],
          },
        ],
      },
      source,
    ),
  ).toThrow("profile location");
  const changed = {
    ...configured,
    displayName: "Renamed",
    source: { kind: "local" as const, executable: "/new/agent", args: ["--acp"] },
    customModels: ["new-model"],
    environment: [
      ...configured.environment,
      { name: "API_KEY", sensitive: true as const, value: "new-key" },
    ],
  };
  expect(updateAcpAgentSettings({ instances: [changed] }, source).instances[0]?.displayName).toBe(
    "Renamed",
  );
  expect(
    AcpAgentSettingsUpdateSchema.safeParse({
      instances: [
        {
          ...instance(),
          environment: [{ name: "AGENT_CONFIG_DIR", sensitive: true, value: "/hidden/profile" }],
        },
      ],
    }).success,
  ).toBe(false);
});

it("rejects malformed stored profile paths before a native scope can be inferred", () => {
  for (const environment of [
    [{ name: "AGENT_CONFIG_DIR", sensitive: false, value: "relative/profile" }],
    [
      {
        name: "AGENT_CONFIG_DIR",
        sensitive: true,
        secretRef: "7546d7ee-62d4-4ae2-b8a9-ae447de7f7fb",
      },
    ],
  ])
    expect(() => readStoredAcpInstances([{ ...instance(), environment }])).toThrow("Invalid saved");
});
