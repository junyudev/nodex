import { basename } from "node:path";

import {
  compareBuildVersions,
  normalizeAppleBuildVersion,
  normalizeReleaseVersion,
  tagForReleaseVersion,
  type ReleaseChannel,
} from "./model";
import type { MacArchitecture } from "./bundle";

export interface SparkleFileIdentity {
  readonly bytes: number;
  readonly edSignature: string;
  readonly name: string;
  readonly sha256: string;
  readonly url: string;
}

export interface SparkleDeltaIdentity extends SparkleFileIdentity {
  readonly fromBuildVersion: string;
  readonly fromVersion: string;
  readonly toBuildVersion: string;
  readonly toVersion: string;
}

export interface SparkleArchitectureUpdateManifest {
  readonly architecture: MacArchitecture;
  readonly channel: ReleaseChannel;
  readonly appcast: {
    readonly bytes: number;
    readonly feedPath: string;
    readonly name: string;
    readonly sha256: string;
  };
  readonly deltas: readonly SparkleDeltaIdentity[];
  readonly full: SparkleFileIdentity;
  readonly schemaVersion: 2;
  readonly sourceSha: string;
  readonly tag: string;
  readonly target: {
    readonly buildVersion: string;
    readonly bundleId: "app.jyu.nodex";
    readonly packageProvenanceSchema: 5;
    readonly teamIdentifier: string;
    readonly version: string;
  };
}

export const NODEX_MACOS_TEAM_IDENTIFIER = "8HGUT3HC4Z";

const SHA256 = /^[a-f0-9]{64}$/u;
const ED_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void => {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an unsupported shape.`);
  }
};

const requireSafeName = (value: unknown, label: string): string => {
  if (typeof value !== "string" || basename(value) !== value || value === "." || value === "..") {
    throw new Error(`${label} must be a safe asset name.`);
  }
  return value;
};

const requireSha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return value;
};

const requireBytes = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive byte count.`);
  }
  return value as number;
};

const requireSignature = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !ED_SIGNATURE.test(value)) {
    throw new Error(`${label} must be an Ed25519 signature.`);
  }
  return value;
};

const immutableReleaseUrl = (value: unknown, tag: string, name: string): string => {
  if (typeof value !== "string") throw new Error("Sparkle asset URL must be a string.");
  const parsed = new URL(value);
  const expectedPath = `/junyudev/nodex/releases/download/${tag}/${encodeURIComponent(name)}`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.pathname !== expectedPath
  ) {
    throw new Error(`Sparkle asset URL must use the immutable ${tag} release path.`);
  }
  return parsed.toString();
};

const parseFile = (value: unknown, tag: string, label: string): SparkleFileIdentity => {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  assertExactKeys(value, ["bytes", "edSignature", "name", "sha256", "url"], label);
  const name = requireSafeName(value.name, `${label} name`);
  return {
    bytes: requireBytes(value.bytes, `${label} bytes`),
    edSignature: requireSignature(value.edSignature, `${label} signature`),
    name,
    sha256: requireSha256(value.sha256, `${label} sha256`),
    url: immutableReleaseUrl(value.url, tag, name),
  };
};

const parseDelta = (value: unknown, tag: string): SparkleDeltaIdentity => {
  if (!isRecord(value)) throw new Error("Sparkle delta is invalid.");
  assertExactKeys(
    value,
    [
      "bytes",
      "edSignature",
      "fromBuildVersion",
      "fromVersion",
      "name",
      "sha256",
      "toBuildVersion",
      "toVersion",
      "url",
    ],
    "Sparkle delta",
  );
  const file = parseFile(
    {
      bytes: value.bytes,
      edSignature: value.edSignature,
      name: value.name,
      sha256: value.sha256,
      url: value.url,
    },
    tag,
    "Sparkle delta",
  );
  const fromVersion = normalizeReleaseVersion(String(value.fromVersion));
  const toVersion = normalizeReleaseVersion(String(value.toVersion));
  const fromBuildVersion = normalizeAppleBuildVersion(String(value.fromBuildVersion));
  const toBuildVersion = normalizeAppleBuildVersion(String(value.toBuildVersion));
  if (compareBuildVersions(fromBuildVersion, toBuildVersion) >= 0) {
    throw new Error("Sparkle delta version range is invalid.");
  }
  return {
    ...file,
    fromBuildVersion,
    fromVersion,
    toBuildVersion,
    toVersion,
  };
};

export function parseSparkleArchitectureUpdateManifest(
  value: unknown,
): SparkleArchitectureUpdateManifest {
  if (!isRecord(value)) throw new Error("Sparkle architecture update manifest is invalid.");
  const legacyStable = value.schemaVersion === 1;
  assertExactKeys(
    value,
    [
      "architecture",
      ...(legacyStable ? [] : ["channel"]),
      "appcast",
      "deltas",
      "full",
      "schemaVersion",
      "sourceSha",
      "tag",
      "target",
    ],
    "Sparkle architecture update manifest",
  );
  const channel = legacyStable ? "stable" : value.channel;
  if (
    (!legacyStable && value.schemaVersion !== 2) ||
    (value.architecture !== "arm64" && value.architecture !== "x64") ||
    (channel !== "stable" && channel !== "nightly")
  ) {
    throw new Error("Sparkle architecture update manifest version or architecture is invalid.");
  }
  if (typeof value.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(value.sourceSha)) {
    throw new Error("Sparkle architecture source SHA is invalid.");
  }
  if (!isRecord(value.target) || !isRecord(value.appcast) || !Array.isArray(value.deltas)) {
    throw new Error("Sparkle architecture update manifest target or assets are invalid.");
  }
  assertExactKeys(
    value.target,
    ["buildVersion", "bundleId", "packageProvenanceSchema", "teamIdentifier", "version"],
    "Sparkle update target",
  );
  const version = normalizeReleaseVersion(String(value.target.version));
  const tag = tagForReleaseVersion(version);
  const targetBuildVersion = normalizeAppleBuildVersion(String(value.target.buildVersion));
  if (
    value.tag !== tag ||
    value.target.bundleId !== "app.jyu.nodex" ||
    value.target.packageProvenanceSchema !== 5 ||
    value.target.teamIdentifier !== NODEX_MACOS_TEAM_IDENTIFIER
  ) {
    throw new Error("Sparkle update target identity is invalid.");
  }
  assertExactKeys(value.appcast, ["bytes", "feedPath", "name", "sha256"], "Sparkle appcast");
  const expectedAppcastName = `Nodex-${version}-appcast-${value.architecture}.xml`;
  const appcastName = requireSafeName(value.appcast.name, "Sparkle appcast name");
  if (
    appcastName !== expectedAppcastName ||
    value.appcast.feedPath !== `updates/${channel}/${value.architecture}/appcast.xml`
  ) {
    throw new Error("Sparkle appcast projection identity is invalid.");
  }
  const full = parseFile(value.full, tag, "Sparkle full update");
  if (full.name !== `Nodex-${version}-${value.architecture}.zip`) {
    throw new Error("Sparkle full update name is invalid.");
  }
  const deltas = value.deltas.map((delta) => parseDelta(delta, tag));
  const deltaNames = deltas.map(({ name }) => name);
  if (
    new Set(deltaNames).size !== deltaNames.length ||
    deltas.some(
      (delta) =>
        delta.toVersion !== version ||
        delta.toBuildVersion !== targetBuildVersion ||
        delta.name !== `Nodex-${delta.fromVersion}-to-${version}-${value.architecture}.delta`,
    )
  ) {
    throw new Error("Sparkle delta set does not match its target release.");
  }
  return {
    architecture: value.architecture,
    channel,
    appcast: {
      bytes: requireBytes(value.appcast.bytes, "Sparkle appcast bytes"),
      feedPath: value.appcast.feedPath,
      name: appcastName,
      sha256: requireSha256(value.appcast.sha256, "Sparkle appcast sha256"),
    },
    deltas,
    full,
    schemaVersion: 2,
    sourceSha: value.sourceSha,
    tag,
    target: {
      buildVersion: targetBuildVersion,
      bundleId: "app.jyu.nodex",
      packageProvenanceSchema: 5,
      teamIdentifier: value.target.teamIdentifier,
      version,
    },
  };
}
