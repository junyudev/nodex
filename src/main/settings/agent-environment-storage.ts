import { syncDirectorySync } from "../platform/node/filesystem-durability";
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
  AgentEnvironmentValueSchema,
  type AgentEnvironmentInput,
  type AgentEnvironmentVariable,
} from "../../shared/agent-environment";
import type { SecretEncryptionAdapter } from "../platform/SecretEncryption";
export const storedAgentEnvironmentSchema = (name: z.ZodType<string>) =>
  z.discriminatedUnion("sensitive", [
    z.strictObject({ name, sensitive: z.literal(false), value: AgentEnvironmentValueSchema }),
    z.strictObject({ name, sensitive: z.literal(true), secretRef: z.uuid() }),
  ]);
export type StoredAgentEnvironment = z.output<ReturnType<typeof storedAgentEnvironmentSchema>>;

interface EnvironmentInstance<E> {
  readonly id: string;
  readonly environment: readonly E[];
}
const SecretPayloadSchema = z
  .object({ instanceId: z.string(), name: z.string(), value: AgentEnvironmentValueSchema })
  .strict();

export interface AgentEnvironmentStorage {
  readonly backend: string;
  readonly settingsPath: string;
  readonly hostHomeDirectory?: string;
  readonly secretEncryption?: SecretEncryptionAdapter;
}

const secretDirectory = (source: AgentEnvironmentStorage) =>
  path.join(path.dirname(source.settingsPath), "agent-secrets", source.backend);
const secretPath = (source: AgentEnvironmentStorage, ref: string) =>
  path.join(secretDirectory(source), ref);

function encryption(source: AgentEnvironmentStorage): SecretEncryptionAdapter {
  if (!source.secretEncryption?.isAvailable())
    throw new Error("Secure storage is unavailable. Unlock your system keychain and try again.");
  return source.secretEncryption;
}

function ensureSecretDirectory(source: AgentEnvironmentStorage): void {
  const directory = secretDirectory(source);
  for (const entry of [path.dirname(directory), directory]) {
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    if (!lstatSync(entry).isDirectory() || lstatSync(entry).isSymbolicLink())
      throw new Error("Invalid Agent secret directory.");
  }
}

function saveSecret(
  source: AgentEnvironmentStorage,
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
    throw new Error("Could not encrypt the Agent environment value.");
  }
  ensureSecretDirectory(source);
  const ref = randomUUID();
  const descriptor = openSync(secretPath(source, ref), "wx", 0o600);
  try {
    writeFileSync(descriptor, ciphertext);
    fsyncSync(descriptor);
  } catch {
    removeSecret(source, ref);
    throw new Error("Could not save the Agent environment value.");
  } finally {
    closeSync(descriptor);
  }
  // Flush directory entries before a durable settings document can refer to them.
  for (const directory of [secretDirectory(source), path.dirname(secretDirectory(source))]) {
    try {
      syncDirectorySync(directory);
    } catch {
      /* Directory fsync is unavailable on some host filesystems. */
    }
  }
  return ref;
}

function readSecret(
  source: AgentEnvironmentStorage,
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
      "A saved Agent environment secret is unavailable. Replace it in Agent settings.",
    );
  }
}

function removeSecret(source: AgentEnvironmentStorage, ref: string): void {
  try {
    unlinkSync(secretPath(source, ref));
  } catch {
    /* Orphaned ciphertext cannot be used without a settings reference. */
  }
}

const references = (instances: readonly EnvironmentInstance<StoredAgentEnvironment>[]) =>
  new Set(
    instances.flatMap(({ environment }) =>
      environment.flatMap((variable) => (variable.sensitive ? [variable.secretRef] : [])),
    ),
  );
export interface AgentSecretChanges {
  readonly stage: (
    source: AgentEnvironmentStorage,
    id: string,
    name: string,
    value: string,
  ) => string;
  readonly retire: (source: AgentEnvironmentStorage, ref: string) => void;
}

/** A settings write owns both the staged references and when old references can be retired. */
export function withAgentSecretChanges<T>(publish: (changes: AgentSecretChanges) => T): T {
  const staged: (() => void)[] = [];
  const retired: (() => void)[] = [];
  let result: T;
  try {
    result = publish({
      stage: (source, id, name, value) => {
        const ref = saveSecret(source, id, name, value);
        staged.push(() => removeSecret(source, ref));
        return ref;
      },
      retire: (source, ref) => retired.push(() => removeSecret(source, ref)),
    });
  } catch (cause) {
    staged.forEach((discard) => discard());
    throw cause;
  }
  retired.forEach((discard) => discard());
  return result;
}

export function writeAgentEnvironments<T extends EnvironmentInstance<AgentEnvironmentInput>>(
  source: AgentEnvironmentStorage,
  instances: readonly T[],
  previous: readonly EnvironmentInstance<StoredAgentEnvironment>[],
  publish: (
    next: Array<Omit<T, "environment"> & { environment: StoredAgentEnvironment[] }>,
  ) => void,
): void {
  withAgentSecretChanges(({ stage, retire }) => {
    const next = instances.map((instance) => ({
      ...instance,
      environment: instance.environment.map((variable) => {
        if (!variable.sensitive) return variable;
        if (variable.value !== null) {
          return {
            name: variable.name,
            sensitive: true as const,
            secretRef: stage(source, instance.id, variable.name, variable.value),
          };
        }
        const old = previous
          .find(({ id }) => id === instance.id)
          ?.environment.find(({ name }) => name === variable.name);
        if (!old?.sensitive) throw new Error("Enter a value for the new secret.");
        return old;
      }),
    }));
    const retained = references(next);
    for (const ref of references(previous)) if (!retained.has(ref)) retire(source, ref);
    publish(next);
  });
}

export function presentAgentEnvironment(
  environment: readonly StoredAgentEnvironment[],
): AgentEnvironmentVariable[] {
  return environment.map((variable) =>
    variable.sensitive ? { name: variable.name, sensitive: true, value: null } : variable,
  );
}
export function resolveAgentEnvironment(
  source: AgentEnvironmentStorage,
  instance: EnvironmentInstance<StoredAgentEnvironment>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    instance.environment.map((variable) => [
      variable.name,
      variable.sensitive
        ? readSecret(source, instance.id, variable.name, variable.secretRef)
        : variable.value,
    ]),
  );
}

/** Rebind ciphertext to the migrated Profile identity and namespace. */
export function migrateAgentSecret(
  changes: AgentSecretChanges,
  previous: { source: AgentEnvironmentStorage; id: string; name: string; ref: string },
  next: { source: AgentEnvironmentStorage; id: string; name: string } | null,
): string | undefined {
  if (
    next &&
    previous.source.backend === next.source.backend &&
    previous.id === next.id &&
    previous.name === next.name
  )
    return previous.ref;
  changes.retire(previous.source, previous.ref);
  if (!next) return undefined;
  const value = readSecret(previous.source, previous.id, previous.name, previous.ref);
  return changes.stage(next.source, next.id, next.name, value);
}
