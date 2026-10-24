import { afterEach, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import {
  AcpAgentSettingsUpdateSchema,
  type AcpAgentInstanceInput,
} from "../../shared/acp-agent-settings";
import {
  getAcpAgentSettings,
  getAcpLaunchConfiguration,
  updateAcpAgentSettings,
} from "./application-settings-persistence";
import { readStoredAcpInstances, writeAcpInstances } from "./acp-agent-environment";
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
            id: "claude-main",
            agentDefinitionId: "claude-agent-acp",
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
    id: "claude-main",
    agentDefinitionId: "claude-agent-acp",
    source: {
      kind: "local",
      executable: "/missing/node",
      args: ["/missing/package/dist/index.js"],
    },
    credentials: { kind: "isolated-home", home: "/old/home" },
    proxy: "inherit-host",
  });
  updateAcpAgentSettings(migrated, source);
  expect(getAcpAgentSettings(source)).toEqual(migrated);
  expect(readFileSync(source.settingsPath, "utf8")).not.toContain("packageRoot");
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
