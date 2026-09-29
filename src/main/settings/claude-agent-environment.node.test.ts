import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import {
  defaultClaudeInstance,
  type UpdateClaudeAgentSettingsInput,
} from "../../shared/claude-agent-settings";
import type { SecretEncryptionAdapter } from "../platform/SecretEncryption";
import {
  getClaudeAgentSettings,
  getClaudeLaunchConfiguration,
  updateClaudeAgentSettings,
} from "./application-settings-persistence";
import { readStoredClaudeInstances, writeClaudeInstances } from "./claude-agent-environment";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-claude-env-"));
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
  return { root, environment: {}, settingsPath: path.join(root, "config.toml"), secretEncryption };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const configuration = (): UpdateClaudeAgentSettingsInput => ({
  instances: [
    {
      ...defaultClaudeInstance(),
      environment: [
        { name: "ANTHROPIC_BASE_URL", sensitive: false, value: "https://router.example" },
        { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "test-only-secret" },
        { name: "ANTHROPIC_API_KEY", sensitive: true, value: "" },
      ],
    },
  ],
});

it("encrypts secrets outside config, redacts reads, and resolves the exact launch environment", () => {
  const source = fixture();
  const saved = updateClaudeAgentSettings(configuration(), source);
  expect(saved.instances[0]?.environment).toEqual([
    { name: "ANTHROPIC_BASE_URL", sensitive: false, value: "https://router.example" },
    { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: null },
    { name: "ANTHROPIC_API_KEY", sensitive: true, value: null },
  ]);
  const config = readFileSync(source.settingsPath, "utf8");
  expect(config).not.toContain("test-only-secret");
  expect(config).toContain("secretRef");
  const directory = path.join(source.root, "agent-secrets/claude");
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    expect(readFileSync(file).includes(Buffer.from("test-only-secret"))).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(getClaudeLaunchConfiguration(source, "claude-default").environment).toEqual({
    ANTHROPIC_BASE_URL: "https://router.example",
    ANTHROPIC_AUTH_TOKEN: "test-only-secret",
    ANTHROPIC_API_KEY: "",
  });
  // Saving a redacted read retains both secret values, including the empty one.
  updateClaudeAgentSettings(saved, source);
  expect(getClaudeAgentSettings(source)).toEqual(saved);
  expect(readdirSync(directory)).toHaveLength(2);
  expect(
    getClaudeLaunchConfiguration(source, "claude-default").environment.ANTHROPIC_AUTH_TOKEN,
  ).toBe("test-only-secret");
});

it("replaces secrets with an explicit empty string and deletes only removed overrides", () => {
  const source = fixture();
  const saved = updateClaudeAgentSettings(configuration(), source);
  const instance = saved.instances[0]!;
  updateClaudeAgentSettings(
    {
      instances: [
        {
          ...instance,
          environment: [{ name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "" }],
        },
      ],
    },
    source,
  );
  expect(getClaudeLaunchConfiguration(source, instance.id).environment).toEqual({
    ANTHROPIC_AUTH_TOKEN: "",
  });
  expect(readdirSync(path.join(source.root, "agent-secrets/claude"))).toHaveLength(1);
  updateClaudeAgentSettings({ instances: [{ ...instance, environment: [] }] }, source);
  expect(getClaudeLaunchConfiguration(source, instance.id).environment).toEqual({});
  expect(readdirSync(path.join(source.root, "agent-secrets/claude"))).toEqual([]);
});

it("rejects unavailable encryption, invalid variables and secret reuse across instances without changing settings", () => {
  const source = fixture();
  const saved = updateClaudeAgentSettings(configuration(), source);
  const before = readFileSync(source.settingsPath);
  expect(() =>
    updateClaudeAgentSettings(configuration(), {
      ...source,
      secretEncryption: { ...source.secretEncryption, isAvailable: () => false },
    }),
  ).toThrow("Secure storage");
  expect(() =>
    updateClaudeAgentSettings({ instances: [{ ...saved.instances[0]!, id: "another" }] }, source),
  ).toThrow("Enter a value");
  for (const name of [
    "HOME",
    "Home",
    "CLAUDE_CONFIG_DIR",
    "claude_config_dir",
    "CLAUDECODE",
    "BAD-NAME",
  ]) {
    expect(() =>
      updateClaudeAgentSettings(
        {
          instances: [
            {
              ...defaultClaudeInstance(),
              environment: [{ name, value: "secret", sensitive: true }],
            },
          ],
        },
        source,
      ),
    ).toThrow("Invalid Claude environment");
  }
  expect(readFileSync(source.settingsPath)).toEqual(before);
  expect(readdirSync(path.join(source.root, "agent-secrets/claude"))).toHaveLength(2);
});

it("rolls back staged ciphertext when configuration publication fails", () => {
  const source = fixture();
  expect(() =>
    writeClaudeInstances(source, configuration(), readStoredClaudeInstances(undefined), () => {
      throw new Error("Disk full");
    }),
  ).toThrow("Disk full");
  expect(readdirSync(path.join(source.root, "agent-secrets/claude"))).toEqual([]);
  expect(getClaudeAgentSettings(source).instances[0]?.environment).toEqual([]);
});

it("rejects an oversized settings document and cleans staged secrets before publication", () => {
  const source = fixture();
  const saved = updateClaudeAgentSettings(configuration(), source);
  const before = readFileSync(source.settingsPath);
  const large = configuration();
  large.instances[0]!.environment.push(
    ...Array.from({ length: 40 }, (_, index) => ({
      name: `VALUE_${index}`,
      sensitive: false as const,
      value: "a".repeat(32_768),
    })),
  );
  expect(() => updateClaudeAgentSettings(large, source)).toThrow("Settings document exceeds");
  expect(readFileSync(source.settingsPath)).toEqual(before);
  expect(getClaudeAgentSettings(source)).toEqual(saved);
  expect(readdirSync(path.join(source.root, "agent-secrets/claude"))).toHaveLength(2);
});

it("isolates instances and reports missing secrets without falling back to inherited credentials", () => {
  const source = fixture();
  const first = configuration().instances[0]!;
  updateClaudeAgentSettings(
    {
      instances: [
        first,
        {
          ...defaultClaudeInstance(),
          id: "second",
          environment: [{ name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "second-secret" }],
        },
      ],
    },
    source,
  );
  expect(getClaudeLaunchConfiguration(source, "second").environment).toEqual({
    ANTHROPIC_AUTH_TOKEN: "second-secret",
  });
  expect(
    getClaudeLaunchConfiguration(source, "claude-default").environment.ANTHROPIC_AUTH_TOKEN,
  ).toBe("test-only-secret");
  rmSync(path.join(source.root, "agent-secrets/claude"), { recursive: true });
  expect(() => getClaudeLaunchConfiguration(source, "second")).toThrow(
    "Replace it in Agent settings",
  );
  expect(getClaudeAgentSettings(source).instances[1]?.environment).toEqual([
    { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: null },
  ]);
});
