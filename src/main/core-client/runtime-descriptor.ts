import { lstatSync, readFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import type { components } from "@nodex/core-protocol";
import { decodeBoundedJson } from "./codec";
import type { CoreRuntimeDescriptor } from "./types";

const RUNTIME_DIRECTORY_MODE = 0o700;
const PRIVATE_ENTRY_MODE = 0o600;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_AUTH_BYTES = 128;
const AUTH_PATTERN = /^[a-f0-9]{64}$/;

export interface CoreRuntimeConnection {
  readonly descriptor: CoreRuntimeDescriptor;
  readonly authCapability: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: Readonly<Record<string, unknown>>, key: string): string => {
  const field = value[key];
  if (typeof field === "string" && field.length > 0) return field;
  throw new Error(`Core runtime descriptor has invalid ${key}`);
};

const assertOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void => {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
};

type StoreFormat = components["schemas"]["StoreFormatIdentity"];
type Manifest = components["schemas"]["CoreCompatibilityManifest"];

const parseStoreFormat = (value: unknown, label: string): StoreFormat => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, ["lineage", "version", "schema_fingerprint"], label);
  const format = {
    lineage: requireString(value, "lineage"),
    version: requireInteger(value, "version", 1),
    schema_fingerprint: requireString(value, "schema_fingerprint"),
  };
  if (!/^[a-f0-9]{64}$/u.test(format.schema_fingerprint)) {
    throw new Error(`${label} has an invalid schema fingerprint`);
  }
  return format;
};

const storeFormatKey = (format: StoreFormat): string =>
  `${format.lineage}\u0000${format.version.toString().padStart(10, "0")}\u0000${format.schema_fingerprint}`;

const sameStoreFormat = (left: StoreFormat, right: StoreFormat): boolean =>
  left.lineage === right.lineage &&
  left.version === right.version &&
  left.schema_fingerprint === right.schema_fingerprint;

const assertCanonicalStoreFormats = (formats: readonly StoreFormat[], label: string): void => {
  let previous: string | undefined;
  for (const format of formats) {
    const key = storeFormatKey(format);
    if (previous !== undefined && previous >= key) {
      throw new Error(`${label} is not canonical and unique`);
    }
    previous = key;
  }
};

const parseVersionRange = (
  value: unknown,
  label: string,
): components["schemas"]["VersionRange"] => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, ["min", "max"], label);
  const range = {
    min: requireInteger(value, "min", 1),
    max: requireInteger(value, "max", 1),
  };
  if (range.min > range.max) throw new Error(`${label} is inverted`);
  return range;
};

const parseManifest = (value: unknown): Manifest => {
  if (!isRecord(value)) throw new Error("Core compatibility manifest must be an object");
  assertOnlyKeys(
    value,
    ["manifest_version", "transport", "event_versions", "modules", "store"],
    "Core compatibility manifest",
  );
  const modules = value.modules;
  if (!Array.isArray(modules)) throw new Error("Core manifest modules must be an array");
  const parsedModules = modules.map((entry, index) => {
    if (!isRecord(entry)) throw new Error("Core manifest Module entry is invalid");
    assertOnlyKeys(entry, ["module", "versions"], "Core manifest Module entry");
    const module = requireString(entry, "module") as components["schemas"]["ModuleName"];
    if (module !== CORE_CLIENT_REQUIREMENTS.modules[index]?.module) {
      throw new Error("Core manifest Modules are incomplete or not canonical");
    }
    return {
      module,
      versions: parseVersionRange(entry.versions, `Core manifest ${module} versions`),
    };
  });
  if (parsedModules.length !== CORE_CLIENT_REQUIREMENTS.modules.length) {
    throw new Error("Core manifest Modules are incomplete");
  }
  if (!isRecord(value.store)) throw new Error("Core manifest Store support is invalid");
  assertOnlyKeys(value.store, ["readable", "migratable", "current"], "Core Store support");
  const readable = value.store.readable;
  const migratable = value.store.migratable;
  if (!Array.isArray(readable) || !Array.isArray(migratable)) {
    throw new Error("Core Store support lists are invalid");
  }
  const manifest: Manifest = {
    manifest_version: requireInteger(value, "manifest_version", 1),
    transport: parseVersionRange(value.transport, "Core transport range"),
    event_versions: parseVersionRange(value.event_versions, "Core event range"),
    modules: parsedModules,
    store: {
      readable: readable.map((entry, index) =>
        parseStoreFormat(entry, `Core readable Store format ${index}`),
      ),
      migratable: migratable.map((entry, index) =>
        parseStoreFormat(entry, `Core migratable Store format ${index}`),
      ),
      current: parseStoreFormat(value.store.current, "Core current Store format"),
    },
  };
  if (manifest.manifest_version !== 1) {
    throw new Error("Core compatibility manifest version is unsupported");
  }
  assertCanonicalStoreFormats(manifest.store.readable, "Core readable Store formats");
  assertCanonicalStoreFormats(manifest.store.migratable, "Core migratable Store formats");
  if (
    manifest.store.readable.some((format) =>
      manifest.store.migratable.some((candidate) => sameStoreFormat(format, candidate)),
    )
  ) {
    throw new Error("Core readable and migratable Store formats overlap");
  }
  return manifest;
};

const canonicalManifestDigest = (manifest: Manifest): string =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

const assertRuntimeCompatibility = (descriptor: CoreRuntimeDescriptor): void => {
  const { manifest } = descriptor;
  const transportCompatible =
    manifest.transport.min <= CORE_CLIENT_REQUIREMENTS.transport.max &&
    CORE_CLIENT_REQUIREMENTS.transport.min <= manifest.transport.max;
  const eventCompatible =
    manifest.event_versions.min <= CORE_CLIENT_REQUIREMENTS.event_version &&
    CORE_CLIENT_REQUIREMENTS.event_version <= manifest.event_versions.max;
  const modulesCompatible = CORE_CLIENT_REQUIREMENTS.modules.every((required) => {
    const offered = manifest.modules.find((entry) => entry.module === required.module);
    return (
      offered !== undefined &&
      offered.versions.min <= required.contract_version &&
      required.contract_version <= offered.versions.max
    );
  });
  const storeCompatible = CORE_CLIENT_REQUIREMENTS.accepted_store_formats.some(
    (format) =>
      format.lineage === descriptor.actual_store_format.lineage &&
      format.version === descriptor.actual_store_format.version &&
      format.schema_fingerprint === descriptor.actual_store_format.schema_fingerprint,
  );
  if (transportCompatible && eventCompatible && modulesCompatible && storeCompatible) return;
  throw new Error(
    `CoreCompatibilityError: transport=${manifest.transport.min}..${manifest.transport.max}, event=${manifest.event_versions.min}..${manifest.event_versions.max}, store=${descriptor.actual_store_format.lineage}:v${descriptor.actual_store_format.version}, pid=${descriptor.pid}, nonce=${descriptor.start_nonce}`,
  );
};

const requireInteger = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum = 0,
): number => {
  const field = value[key];
  if (typeof field === "number" && Number.isSafeInteger(field) && field >= minimum) {
    return field;
  }
  throw new Error(`Core runtime descriptor has invalid ${key}`);
};

const assertOwned = (stats: Stats, label: string): void => {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || stats.uid === currentUid) return;
  throw new Error(`${label} is not owned by the current user`);
};

const assertMode = (stats: Stats, expected: number, label: string): void => {
  if (process.platform === "win32") return;
  const actual = stats.mode & 0o777;
  if (actual === expected) return;
  throw new Error(`${label} has mode ${actual.toString(8)}; expected ${expected.toString(8)}`);
};

const inspectEntry = (entryPath: string, expectedMode: number, label: string): Stats => {
  const stats = lstatSync(entryPath);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  assertOwned(stats, label);
  assertMode(stats, expectedMode, label);
  return stats;
};

export const parseCoreRuntimeDescriptor = (
  value: unknown,
  expectedSocketPath: string,
  platform: NodeJS.Platform = process.platform,
): CoreRuntimeDescriptor => {
  if (!isRecord(value)) throw new Error("Core runtime descriptor must be an object");

  assertOnlyKeys(
    value,
    [
      "manifest",
      "manifest_digest",
      "artifact",
      "actual_store_format",
      "pid",
      "start_nonce",
      "endpoint",
      "profile_id",
      "store_epoch",
      "readiness_generation",
    ],
    "Core runtime descriptor",
  );
  if (!isRecord(value.artifact)) throw new Error("Core artifact identity is invalid");
  assertOnlyKeys(value.artifact, ["sha256", "build_id"], "Core artifact identity");

  const descriptor: CoreRuntimeDescriptor = {
    manifest: parseManifest(value.manifest),
    manifest_digest: requireString(value, "manifest_digest"),
    artifact: {
      sha256: requireString(value.artifact, "sha256"),
      build_id: requireString(value.artifact, "build_id"),
    },
    actual_store_format: parseStoreFormat(value.actual_store_format, "Core actual Store format"),
    pid: requireInteger(value, "pid", 1),
    start_nonce: requireString(value, "start_nonce"),
    endpoint: requireString(value, "endpoint"),
    profile_id: requireString(value, "profile_id"),
    store_epoch: requireString(value, "store_epoch"),
    readiness_generation: requireInteger(value, "readiness_generation", 1),
  };
  if (!/^[a-f0-9]{64}$/u.test(descriptor.artifact.sha256)) {
    throw new Error("Core artifact digest is invalid");
  }
  if (descriptor.artifact.build_id.length > 128) {
    throw new Error("Core artifact build ID is invalid");
  }
  if (!/^[a-f0-9]{32}$/u.test(descriptor.start_nonce)) {
    throw new Error("Core runtime start nonce is invalid");
  }
  if (descriptor.profile_id.length > 512 || descriptor.store_epoch.length > 512) {
    throw new Error("Core runtime identity exceeds its bound");
  }
  if (canonicalManifestDigest(descriptor.manifest) !== descriptor.manifest_digest) {
    throw new Error("Core runtime manifest digest does not match its canonical manifest");
  }
  if (!sameStoreFormat(descriptor.actual_store_format, descriptor.manifest.store.current)) {
    throw new Error("Core actual Store format does not match the manifest current format");
  }
  if (platform === "win32") {
    if (!/^\\\\\.\\pipe\\nodex-core-[a-f0-9]{32}$/u.test(descriptor.endpoint)) {
      throw new Error("Core runtime descriptor has an invalid local pipe endpoint");
    }
  } else if (!path.isAbsolute(descriptor.endpoint) || descriptor.endpoint !== expectedSocketPath) {
    throw new Error("Core runtime descriptor points outside the fixed runtime socket");
  }
  assertRuntimeCompatibility(descriptor);
  return descriptor;
};

const parseDescriptor = (bytes: Uint8Array, expectedSocketPath: string): CoreRuntimeDescriptor =>
  parseCoreRuntimeDescriptor(
    decodeBoundedJson<unknown>(bytes, MAX_DESCRIPTOR_BYTES, "Core runtime descriptor"),
    expectedSocketPath,
  );

export const readCoreRuntimeConnection = (nodexHome: string): CoreRuntimeConnection => {
  if (!path.isAbsolute(nodexHome)) throw new Error("Nodex home must be absolute");

  const runtimeDirectory = path.join(nodexHome, "run/core");
  const descriptorPath = path.join(runtimeDirectory, "core.json");
  const authPath = path.join(runtimeDirectory, "core.auth");
  const socketPath = path.join(runtimeDirectory, "core.sock");
  const runtimeStats = inspectEntry(
    runtimeDirectory,
    RUNTIME_DIRECTORY_MODE,
    "Core runtime directory",
  );
  if (!runtimeStats.isDirectory()) throw new Error("Core runtime path is not a directory");

  const descriptorStats = inspectEntry(
    descriptorPath,
    PRIVATE_ENTRY_MODE,
    "Core runtime descriptor",
  );
  if (!descriptorStats.isFile()) throw new Error("Core runtime descriptor is not a file");
  if (descriptorStats.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Core runtime descriptor is oversized");
  }

  const authStats = inspectEntry(authPath, PRIVATE_ENTRY_MODE, "Core auth capability");
  if (!authStats.isFile()) throw new Error("Core auth capability is not a file");
  if (authStats.size > MAX_AUTH_BYTES) throw new Error("Core auth capability is oversized");

  if (process.platform !== "win32") {
    const socketStats = inspectEntry(socketPath, PRIVATE_ENTRY_MODE, "Core socket");
    if (!socketStats.isSocket()) throw new Error("Core socket path is not a Unix socket");
  }

  const descriptor = parseDescriptor(readFileSync(descriptorPath), socketPath);
  const authCapability = readFileSync(authPath, "utf8").trim();
  if (!AUTH_PATTERN.test(authCapability)) {
    throw new Error("Core auth capability has an invalid format");
  }
  return { descriptor, authCapability };
};
