import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CLAUDE_ENVIRONMENT_LIMIT,
  ClaudeAgentInstanceFields,
  ClaudeAgentSettingsUpdateSchema,
  ClaudeEnvironmentNameSchema,
  ClaudeEnvironmentValueSchema,
  defaultClaudeInstance,
  type ClaudeAgentSettings,
  type UpdateClaudeAgentSettingsInput,
} from "../../shared/claude-agent-settings";
import type { SecretEncryptionAdapter } from "../platform/SecretEncryption";

const StoredEnvironmentSchema = z.discriminatedUnion("sensitive", [
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(false),
      value: ClaudeEnvironmentValueSchema,
    })
    .strict(),
  z
    .object({
      name: ClaudeEnvironmentNameSchema,
      sensitive: z.literal(true),
      secretRef: z.string().uuid(),
    })
    .strict(),
]);
const StoredInstancesSchema = z
  .array(
    z
      .object({
        ...ClaudeAgentInstanceFields,
        configDirectory: ClaudeAgentInstanceFields.configDirectory.refine(
          (value) => value === "" || path.isAbsolute(value),
        ),
        environment: z
          .array(StoredEnvironmentSchema)
          .max(CLAUDE_ENVIRONMENT_LIMIT)
          .default([])
          .refine((values) => new Set(values.map(({ name }) => name)).size === values.length),
      })
      .strict(),
  )
  .max(32)
  .refine((instances) => new Set(instances.map(({ id }) => id)).size === instances.length);
type StoredInstances = z.infer<typeof StoredInstancesSchema>;
const SecretPayloadSchema = z
  .object({ instanceId: z.string(), name: z.string(), value: ClaudeEnvironmentValueSchema })
  .strict();

export interface ClaudeEnvironmentStorage {
  readonly settingsPath: string;
  readonly hostHomeDirectory?: string;
  readonly secretEncryption?: SecretEncryptionAdapter;
}

export function readStoredClaudeInstances(value: unknown): StoredInstances {
  const result = StoredInstancesSchema.safeParse(value ?? [defaultClaudeInstance()]);
  if (!result.success) throw new Error("Invalid saved Claude Code settings.");
  return result.data;
}

export const presentClaudeInstances = (instances: StoredInstances): ClaudeAgentSettings => ({
  instances: instances.map((instance) => ({
    ...instance,
    environment: instance.environment.map((variable) =>
      variable.sensitive ? { name: variable.name, sensitive: true, value: null } : variable,
    ),
  })),
});

const secretDirectory = (source: ClaudeEnvironmentStorage) =>
  path.join(path.dirname(source.settingsPath), "agent-secrets", "claude");
const secretPath = (source: ClaudeEnvironmentStorage, ref: string) =>
  path.join(secretDirectory(source), ref);

function encryption(source: ClaudeEnvironmentStorage): SecretEncryptionAdapter {
  if (!source.secretEncryption?.isAvailable())
    throw new Error("Secure storage is unavailable. Unlock your system keychain and try again.");
  return source.secretEncryption;
}

function ensureSecretDirectory(source: ClaudeEnvironmentStorage): void {
  const directory = secretDirectory(source);
  for (const entry of [path.dirname(directory), directory]) {
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    if (!lstatSync(entry).isDirectory() || lstatSync(entry).isSymbolicLink())
      throw new Error("Invalid Claude secret directory.");
  }
}

function saveSecret(
  source: ClaudeEnvironmentStorage,
  instanceId: string,
  name: string,
  value: string,
): string {
  // Only ciphertext is ever staged on disk. Encryption failures must not expose input values.
  let ciphertext: Buffer;
  const codec = encryption(source);
  try {
    ciphertext = codec.encryptString(JSON.stringify({ instanceId, name, value }));
  } catch {
    throw new Error("Could not encrypt the Claude environment value.");
  }
  ensureSecretDirectory(source);
  const ref = randomUUID();
  const descriptor = openSync(secretPath(source, ref), "wx", 0o600);
  try {
    writeFileSync(descriptor, ciphertext);
    fsyncSync(descriptor);
  } catch {
    removeSecret(source, ref);
    throw new Error("Could not save the Claude environment value.");
  } finally {
    closeSync(descriptor);
  }
  // Flush directory entries before a durable settings document can refer to them.
  for (const directory of [secretDirectory(source), path.dirname(secretDirectory(source))]) {
    try {
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      /* Directory fsync is unavailable on some host filesystems. */
    }
  }
  return ref;
}

function readSecret(
  source: ClaudeEnvironmentStorage,
  instanceId: string,
  name: string,
  ref: string,
): string {
  const codec = encryption(source);
  try {
    const descriptor = openSync(secretPath(source, ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
      const payload = SecretPayloadSchema.parse(
        JSON.parse(codec.decryptString(readFileSync(descriptor))),
      );
      if (payload.instanceId !== instanceId || payload.name !== name) throw new Error();
      return payload.value;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new Error(
      "A saved Claude environment secret is unavailable. Replace it in Agent settings.",
    );
  }
}

function removeSecret(source: ClaudeEnvironmentStorage, ref: string): void {
  try {
    unlinkSync(secretPath(source, ref));
  } catch {
    /* Orphaned ciphertext cannot be used without a settings reference. */
  }
}

const references = (instances: StoredInstances) =>
  new Set(
    instances.flatMap(({ environment }) =>
      environment.flatMap((variable) => (variable.sensitive ? [variable.secretRef] : [])),
    ),
  );

/** Publish references last so failed writes leave the previous configuration usable. */
export function writeClaudeInstances(
  source: ClaudeEnvironmentStorage,
  input: UpdateClaudeAgentSettingsInput,
  previous: StoredInstances,
  publish: (next: StoredInstances) => void,
): void {
  const result = ClaudeAgentSettingsUpdateSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid Claude environment. Check names, duplicate variables and value limits.",
    );
  const normalized = result.data.instances.map((instance) => {
    const directory = instance.configDirectory;
    if (directory.startsWith("~/") && !source.hostHomeDirectory)
      throw new Error(
        "The host home directory is unavailable. Use an absolute Claude config path.",
      );
    const configDirectory = directory.startsWith("~/")
      ? path.resolve(source.hostHomeDirectory!, directory.slice(2))
      : directory;
    if (configDirectory && !path.isAbsolute(configDirectory))
      throw new Error("Claude config directory must be absolute or start with ~/.");
    return { ...instance, configDirectory };
  });
  const staged: string[] = [];
  let next: StoredInstances;
  try {
    next = normalized.map((instance) => ({
      ...instance,
      environment: instance.environment.map((variable) => {
        if (!variable.sensitive) return variable;
        const old = previous
          .find(({ id }) => id === instance.id)
          ?.environment.find(({ name }) => name === variable.name);
        if (variable.value === null) {
          if (!old?.sensitive) throw new Error("Enter a value for the new secret.");
          return old;
        }
        const secretRef = saveSecret(source, instance.id, variable.name, variable.value);
        staged.push(secretRef);
        return { name: variable.name, sensitive: true as const, secretRef };
      }),
    }));
    publish(next);
  } catch (cause) {
    for (const ref of staged) removeSecret(source, ref);
    throw cause;
  }
  const retained = references(next);
  for (const ref of references(previous)) if (!retained.has(ref)) removeSecret(source, ref);
}

/** Main-only launch read. Never expose the resolved environment through settings IPC. */
export function resolveClaudeLaunchConfiguration(
  source: ClaudeEnvironmentStorage,
  instances: StoredInstances,
  id: string,
) {
  const stored = instances.find((instance) => instance.id === id);
  if (!stored?.enabled) throw new Error("Claude instance is unavailable or disabled.");
  return {
    instance: presentClaudeInstances([stored]).instances[0]!,
    environment: Object.fromEntries(
      stored.environment.map((variable) => [
        variable.name,
        variable.sensitive
          ? readSecret(source, id, variable.name, variable.secretRef)
          : variable.value,
      ]),
    ),
  };
}
