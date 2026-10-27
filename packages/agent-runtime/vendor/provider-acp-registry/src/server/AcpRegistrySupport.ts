import {
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryManagedBinaryUninstallResult,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
  type AcpRegistryDistributionAvailability,
  type AcpRegistryInstallPreview,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { sha256 } from "@noble/hashes/sha2.js";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 20;
const REGISTRY_REQUEST_TIMEOUT = "30 seconds";
const ARCHIVE_REQUEST_TIMEOUT = "20 minutes";
const PACKAGE_INSTALL_TIMEOUT = "20 minutes";
const PACKAGE_QUERY_TIMEOUT = "30 seconds";

const BoundedAgentId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);
const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
// Versions become install directory names, so "." and ".." must not decode.
const BoundedVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
);
const BoundedDescription = Schema.String.check(Schema.isMaxLength(1_024));
const BoundedMetadata = Schema.String.check(Schema.isMaxLength(256));
const BoundedArgument = Schema.String.check(Schema.isMaxLength(1_024));
const PackageCommandName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/iu),
);
const isPackageCommandName = Schema.is(PackageCommandName);
const EXACT_RUNNER_VERSION = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  "iu",
);
const EXACT_UVX_PACKAGE = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`, "iu");
const NpxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_NPX_PACKAGE.test(value) || "ACP Registry npx packages must include an exact version.",
  ),
);
const UvxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_UVX_PACKAGE.test(value) || "ACP Registry uvx packages must include an exact version.",
  ),
);
const HttpsUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" && url.username.length === 0 && url.password.length === 0) ||
        "ACP Registry URLs must use HTTPS without embedded credentials."
      );
    } catch {
      return "ACP Registry URLs must be valid absolute URLs.";
    }
  }),
);

const AcpRegistryPackageDistributionFields = {
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
} as const;
const AcpRegistryNpxDistribution = Schema.Struct({
  package: NpxPackage,
  ...AcpRegistryPackageDistributionFields,
});
const AcpRegistryUvxDistribution = Schema.Struct({
  package: UvxPackage,
  ...AcpRegistryPackageDistributionFields,
});

const AcpRegistryBinaryTarget = Schema.Struct({
  archive: HttpsUrl,
  cmd: BoundedArgument,
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/iu))),
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
});

const AcpRegistryAgent = Schema.Struct({
  id: BoundedAgentId,
  name: BoundedName,
  version: BoundedVersion,
  description: BoundedDescription,
  authors: Schema.optionalKey(Schema.Array(BoundedMetadata).check(Schema.isMaxLength(16))),
  license: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.optionalKey(HttpsUrl),
  repository: Schema.optionalKey(HttpsUrl),
  icon: Schema.optionalKey(HttpsUrl),
  distribution: Schema.Struct({
    binary: Schema.optionalKey(Schema.Record(Schema.String, AcpRegistryBinaryTarget)),
    npx: Schema.optionalKey(AcpRegistryNpxDistribution),
    uvx: Schema.optionalKey(AcpRegistryUvxDistribution),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

const NpmPackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.Union([BoundedArgument, Schema.Record(PackageCommandName, BoundedArgument)]),
});

const AcpRegistryPackageInstallReceipt = Schema.Struct({
  agentId: BoundedAgentId,
  agentVersion: BoundedVersion,
  distribution: Schema.Literals(["npx", "uvx"]),
  packageSpec: Schema.String,
  managerPath: Schema.String,
  installRoot: Schema.String,
  binDirectory: Schema.String,
  executablePath: Schema.String,
  packageRoot: Schema.optional(Schema.String),
  packageVersion: Schema.optional(Schema.String),
});
type AcpRegistryPackageInstallReceipt = typeof AcpRegistryPackageInstallReceipt.Type;

const AcpRegistryIndexEnvelope = Schema.Struct({
  version: BoundedVersion,
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(512)),
});
export interface AcpRegistryIndex {
  readonly version: string;
  readonly agents: ReadonlyArray<AcpRegistryAgent>;
}

const decodeRegistryIndexEnvelope = Schema.decodeUnknownEffect(AcpRegistryIndexEnvelope);
const decodeRegistryAgent = Schema.decodeUnknownOption(AcpRegistryAgent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeNpmPackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NpmPackageManifest),
);
const decodePackageInstallReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
const encodePackageInstallReceipt = Schema.encodeSync(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
const decodeHttpsUrl = Schema.decodeUnknownEffect(HttpsUrl);
const decodeBoundedAgentId = Schema.decodeUnknownEffect(BoundedAgentId);

export const AcpRegistryErrorReason = AcpRegistryOperationErrorReason;
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: AcpRegistryErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export function toAcpRegistryOperationError(error: AcpRegistryError): AcpRegistryOperationError {
  return new AcpRegistryOperationError({
    reason: error.reason,
    message: error.detail,
    cause: error,
  });
}

const isAcpRegistryError = Schema.is(AcpRegistryError);

export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

interface ExactPackageSpec {
  readonly name: string;
  readonly version: string;
}

function parseNpxPackageSpec(packageSpec: string): ExactPackageSpec {
  const separator = packageSpec.lastIndexOf("@");
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + 1).replace(/^v/iu, ""),
  };
}

function parseUvxPackageSpec(packageSpec: string): ExactPackageSpec {
  const equalsSeparator = packageSpec.lastIndexOf("==");
  const separator = equalsSeparator >= 0 ? equalsSeparator : packageSpec.lastIndexOf("@");
  const separatorLength = equalsSeparator >= 0 ? 2 : 1;
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + separatorLength).replace(/^v/iu, ""),
  };
}

function packageManagerFor(distribution: AcpRegistryDistributionKind): "npm" | "uv" | undefined {
  return distribution === "npx" ? "npm" : distribution === "uvx" ? "uv" : undefined;
}

function packageCommandCandidates(
  agent: AcpRegistryAgent,
  packageName: string,
): ReadonlyArray<string> {
  const unscopedPackageName = packageName.split("/").pop() ?? packageName;
  return Array.from(
    new Set(
      [agent.id, unscopedPackageName, unscopedPackageName.replace(/-acp$/u, "")].filter(
        isPackageCommandName,
      ),
    ),
  );
}

function readEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  return (
    environment.PATH ??
    Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
  );
}

function withPreferredPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: mergePathEntries(directory, readEnvironmentPath(environment, platform), platform),
  };
}

/**
 * Directories exposing installed ACP Registry commands. The integrated
 * terminal appends them to PATH so managed package commands and
 * managed binary agents are both available by name. Best effort: unreadable
 * directories resolve to no entries.
 */
export const acpRegistryManagedBinaryDirectories = Effect.fn("acpRegistryManagedBinaryDirectories")(
  function* (input: {
    readonly cacheDir: string;
    readonly toolsDir: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: NodeJS.Architecture;
  }): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = resolveAcpRegistryPlatformTarget(input.platform, input.architecture);
    const registryDirectory = path.join(input.cacheDir, "acp-registry");
    const installsDirectory = input.toolsDir;
    const packageReceiptsDirectory = path.join(registryDirectory, "package-installs");
    const listDirectories = (directory: string) =>
      fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): Array<string> => []));
    const directories: Array<string> = [];

    for (const receiptFile of (yield* listDirectories(packageReceiptsDirectory))
      .filter((name) => name.endsWith(".json"))
      .toSorted()) {
      const receipt = yield* fileSystem
        .readFileString(path.join(packageReceiptsDirectory, receiptFile))
        .pipe(
          Effect.map(decodePackageInstallReceipt),
          Effect.orElseSucceed(() => Option.none()),
        );
      if (
        Option.isSome(receipt) &&
        path.dirname(receipt.value.installRoot) ===
          path.join(
            installsDirectory,
            receipt.value.agentId,
            encodeURIComponent(receipt.value.agentVersion),
            receipt.value.distribution === "npx" ? "npm" : "python",
            "generations",
          ) &&
        /^[a-f0-9-]{36}$/u.test(path.basename(receipt.value.installRoot)) &&
        receipt.value.binDirectory ===
          path.join(
            receipt.value.installRoot,
            ...(receipt.value.distribution === "npx" && input.platform === "win32" ? [] : ["bin"]),
          ) &&
        path.dirname(receipt.value.executablePath) === receipt.value.binDirectory &&
        (yield* fileSystem
          .exists(receipt.value.executablePath)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        directories.push(receipt.value.binDirectory);
      }
    }

    if (target === undefined) return Array.from(new Set(directories));
    const cachedAgents = yield* fileSystem
      .readFileString(path.join(registryDirectory, "registry.json"))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.flatMap(decodeRegistryIndexEnvelope),
        Effect.map((envelope) =>
          envelope.agents.flatMap((candidate) => {
            const decoded = decodeRegistryAgent(candidate);
            return Option.isSome(decoded) ? [decoded.value] : [];
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<AcpRegistryAgent> => []),
      );
    const cachedAgentByInstall = new Map(
      // Install directories are named by the URI-encoded version.
      cachedAgents.map(
        (agent) => [`${agent.id}\0${encodeURIComponent(agent.version)}`, agent] as const,
      ),
    );
    for (const agent of (yield* listDirectories(installsDirectory)).toSorted()) {
      const versions = (yield* listDirectories(path.join(installsDirectory, agent))).toSorted(
        (left, right) => right.localeCompare(left, undefined, { numeric: true }),
      );
      for (const version of versions) {
        const installRoot = path.join(installsDirectory, agent, version, target);
        if (yield* fileSystem.exists(installRoot).pipe(Effect.orElseSucceed(() => false))) {
          const binaryTarget = cachedAgentByInstall.get(`${agent}\0${version}`)?.distribution
            .binary?.[target];
          const commandSegments =
            binaryTarget === undefined ? undefined : normalizeRegistryCommandPath(binaryTarget.cmd);
          const directory =
            commandSegments === undefined
              ? installRoot
              : path.join(installRoot, ...commandSegments.slice(0, -1));
          if (yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false))) {
            directories.push(directory);
          }
        }
      }
    }
    return Array.from(new Set(directories));
  },
);

export interface ResolvedAcpRegistryDistribution {
  readonly kind: AcpRegistryDistributionKind;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binaryTarget?: typeof AcpRegistryBinaryTarget.Type;
  readonly packageName?: string;
}

export function resolveAcpRegistryDistribution(input: {
  readonly agent: AcpRegistryAgent;
  readonly preference: AcpRegistryDistributionPreference;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const binary = platformTarget ? agent.distribution.binary?.[platformTarget] : undefined;
  const candidates: ReadonlyArray<AcpRegistryDistributionKind> =
    input.preference === "auto" ? ["binary", "npx", "uvx"] : [input.preference];

  for (const kind of candidates) {
    if (kind === "binary" && binary) {
      return {
        kind,
        args: binary.args ?? [],
        env: binary.env ?? {},
        binaryTarget: binary,
      };
    }
    if (kind === "npx" && agent.distribution.npx) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageName: agent.distribution.npx.package,
      };
    }
    if (kind === "uvx" && agent.distribution.uvx) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageName: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

export interface ResolvedAcpRegistryAgent {
  readonly agent?: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind | "local";
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

type AcpRegistryInstallationInspection =
  | { readonly status: "unconfigured" }
  | { readonly status: "not_found"; readonly agentId: string }
  | {
      readonly status: "unsupported";
      readonly agentId: string;
      readonly version: string;
    }
  | {
      readonly status: "missing_runner";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
      readonly runner: string;
    }
  | {
      readonly status: "missing_runner";
      readonly version: null;
      readonly distribution: "local";
    }
  | {
      readonly status: "unprepared";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string | null;
      readonly distribution: AcpRegistryDistributionKind | "local";
      readonly documentationUrl?: string;
    };

export type AcpRegistryInspection = AcpRegistryInstallationInspection & {
  /** Most recently cached catalog version; passive inspection never refreshes the network. */
  readonly latestVersion: string | null;
};

export interface AcpRegistryInstallProgress {
  readonly phase: "downloading" | "verifying" | "extracting" | "installing";
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}
type Progress = (progress: AcpRegistryInstallProgress) => Effect.Effect<void>;

export class AcpRegistryCatalog extends Context.Service<
  AcpRegistryCatalog,
  {
    readonly search: (
      input: AcpRegistrySearchInput,
    ) => Effect.Effect<AcpRegistrySearchResult, AcpRegistryError>;
    readonly preview: (
      input: AcpRegistryPrepareInput,
    ) => Effect.Effect<AcpRegistryInstallPreview, AcpRegistryError>;
    readonly prepare: (
      input: AcpRegistryPrepareInput,
      onProgress?: Progress,
    ) => Effect.Effect<AcpRegistryPrepareResult, AcpRegistryError>;
    readonly inspect: (
      settings: AcpRegistrySettings,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AcpRegistryInspection, AcpRegistryError>;
    readonly resolve: (
      settings: AcpRegistrySettings,
      cwd: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
    readonly uninstallManagedBinary: (
      input: AcpRegistryManagedBinaryUninstallInput,
    ) => Effect.Effect<AcpRegistryManagedBinaryUninstallResult, AcpRegistryError>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistrySupport/AcpRegistryCatalog") {}

const layer = (options: AcpRegistryCatalogOptions) =>
  Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog(options));

/**
 * The server-lifetime catalog, with the runtime coordinator built alongside
 * it so setup, snapshots, and turn launch share one of each. Its cache lives
 * in the host's provider status cache and installed agents under the T3
 * home's `tools` directory.
 */
export const layerFromHost = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const { paths } = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      return layer({
        cacheDir: paths.providerStatusCacheDir,
        toolsDir: path.join(paths.baseDir, "tools"),
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);

export interface AcpRegistryCatalogOptions {
  readonly cacheDir: string;
  readonly toolsDir: string;
  readonly registryUrl?: string;
}

const INSTALL_LOCK_RETRY_COUNT = 300;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
const PREPARED_INSTALLATION_RESERVATION_MS = 30 * 1_000;

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

function normalizeRegistryCommandPath(command: string): ReadonlyArray<string> | undefined {
  const normalized = command.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments;
}

function validateArchiveEntries(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => entry === "./" || normalizeRegistryCommandPath(entry) !== undefined);
}

type ArchiveKind = "raw" | "tar_bz2" | "tar_gz" | "zip";

function archiveKind(url: string): ArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar_gz";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar_bz2";
  if (pathname.endsWith(".zip")) return "zip";
  return "raw";
}

function archiveFileName(kind: ArchiveKind): string {
  switch (kind) {
    case "tar_gz":
      return "agent.tar.gz";
    case "tar_bz2":
      return "agent.tar.bz2";
    case "zip":
      return "agent.zip";
    case "raw":
      return "agent.bin";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;

  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(" ").toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;

  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

export const makeAcpRegistryCatalog = Effect.fn("AcpRegistryCatalog.make")(function* (
  input: AcpRegistryCatalogOptions,
): Effect.fn.Return<
  AcpRegistryCatalog["Service"],
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost
> {
  const crypto = yield* Crypto.Crypto;
  const sha256Hex = (data: Uint8Array) =>
    crypto.digest("SHA-256", data).pipe(Effect.map(Hex.encode), Effect.orDie);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { settings: hostSettings } = yield* ProviderHost.ProviderHost;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;
  const runtimeNodeDirectory = path.dirname(yield* HostProcess.ExecutablePath);
  const resolveExecutable = yield* SpawnExecutableResolution;
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
  const installsDirectory = input.toolsDir;
  const agentInstallRoot = (agent: AcpRegistryAgent) =>
    path.join(installsDirectory, agent.id, encodeURIComponent(agent.version));
  const packageInstallRoot = (agent: AcpRegistryAgent, distribution: "npx" | "uvx") =>
    path.join(agentInstallRoot(agent), distribution === "npx" ? "npm" : "python");
  const packageBinDirectory = (installRoot: string, distribution: "npx" | "uvx") =>
    distribution === "npx" && platform === "win32" ? installRoot : path.join(installRoot, "bin");
  const packageReceiptsDirectory = path.join(registryDirectory, "package-installs");
  const registryRef = yield* Ref.make<AcpRegistryIndex | undefined>(undefined);
  const registryRevision = yield* Ref.make(0);
  const registrySemaphore = yield* Semaphore.make(1);
  const installSemaphore = yield* Semaphore.make(1);
  const preparedInstallationReservations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const managerBinDirectory = Effect.fn("AcpRegistryCatalog.managerBinDirectory")(function* (
    runner: string,
  ) {
    const linkedTarget = yield* fileSystem.readLink(runner).pipe(Effect.option);
    if (Option.isNone(linkedTarget)) return path.dirname(runner);
    const target = path.isAbsolute(linkedTarget.value)
      ? linkedTarget.value
      : path.resolve(path.dirname(runner), linkedTarget.value);
    // Some service installs expose npm/uv through a wrapper symlink into the
    // actual toolchain bin directory. Do not mistake npm's internal
    // `npm-cli.js` directory for the global command directory.
    return path.basename(target) === path.basename(runner)
      ? path.dirname(target)
      : path.dirname(runner);
  });

  const installationsDirectory = path.join(registryDirectory, "installations");
  const InstalledAgent = Schema.Struct({
    agent: AcpRegistryAgent,
    distribution: Schema.Literals(["binary", "npx", "uvx"]),
  });
  const installedAgent = Effect.fn("AcpRegistryCatalog.installedAgent")(function* (
    settings: AcpRegistrySettings,
  ) {
    if (settings.installationId === undefined) return undefined;
    if (!/^[a-f0-9]{64}$/u.test(settings.installationId))
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: "Invalid ACP installation identity.",
      });
    const receipt = yield* fileSystem
      .readFileString(path.join(installationsDirectory, `${settings.installationId}.json`))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledAgent))),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail: "The selected ACP installation is missing. Install it again.",
              cause,
            }),
        ),
      );
    if (
      receipt.agent.id !== settings.agentId ||
      (settings.distribution !== "auto" && settings.distribution !== receipt.distribution)
    )
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: "The selected ACP installation does not match this Agent configuration.",
      });
    return receipt;
  });
  const recordInstallation = Effect.fn("AcpRegistryCatalog.recordInstallation")(
    function* (agent: AcpRegistryAgent, distribution: AcpRegistryDistributionKind) {
      const content = JSON.stringify({ agent, distribution });
      const { installationId, receiptPath } = yield* installationIdentity(agent, distribution);
      yield* fileSystem.makeDirectory(installationsDirectory, { recursive: true });
      const destination = receiptPath;
      const temporary = `${destination}.pending`;
      yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
      yield* fileSystem.rename(temporary, destination);
      return installationId;
    },
    Effect.mapError(
      (cause) =>
        new AcpRegistryError({
          reason: "install_failed",
          detail: "Could not record the ACP installation.",
          cause,
        }),
    ),
  );

  const installationIdentity = Effect.fnUntraced(function* (
    agent: AcpRegistryAgent,
    distribution: AcpRegistryDistributionKind,
  ) {
    const installationId = yield* sha256Hex(
      new TextEncoder().encode(JSON.stringify({ agent, distribution })),
    );
    return {
      installationId,
      receiptPath: path.join(installationsDirectory, `${installationId}.json`),
    };
  });

  const reservePreparedInstallation = Effect.fn("AcpRegistryCatalog.reservePreparedInstallation")(
    function* (agentId: string) {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(preparedInstallationReservations, (current) => {
        const next = new Map(Array.from(current).filter(([, expiresAt]) => expiresAt > now));
        next.set(agentId, now + PREPARED_INSTALLATION_RESERVATION_MS);
        return next;
      });
    },
  );

  const consumePreparedInstallationReservation = (agentId: string) =>
    Ref.update(preparedInstallationReservations, (current) => {
      if (!current.has(agentId)) return current;
      const next = new Map(current);
      next.delete(agentId);
      return next;
    });

  const hasPreparedInstallationReservation = Effect.fn(
    "AcpRegistryCatalog.hasPreparedInstallationReservation",
  )(function* (agentId: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(preparedInstallationReservations, (current) => {
      const expiresAt = current.get(agentId);
      if (expiresAt === undefined || expiresAt <= now) {
        if (expiresAt === undefined) return [false, current] as const;
        const next = new Map(current);
        next.delete(agentId);
        return [false, next] as const;
      }
      return [true, current] as const;
    });
  });

  const assertHttpsUrl = Effect.fn("AcpRegistryCatalog.assertHttpsUrl")(function* (
    value: string,
    detail: string,
  ) {
    const valid = yield* decodeHttpsUrl(value).pipe(Effect.option);
    if (Option.isNone(valid)) {
      return yield* new AcpRegistryError({ reason: "registry_unavailable", detail });
    }
    return value;
  });

  const decodeRegistryText = Effect.fn("AcpRegistryCatalog.decodeRegistryText")(function* (
    text: string,
  ) {
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned invalid JSON.",
            cause,
          }),
      ),
    );
    const envelope = yield* decodeRegistryIndexEnvelope(decoded).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned an invalid index.",
            cause,
          }),
      ),
    );
    const agents = envelope.agents.flatMap((candidate) => {
      const decodedAgent = decodeRegistryAgent(candidate);
      return Option.isSome(decodedAgent) ? [decodedAgent.value] : [];
    });
    const discarded = envelope.agents.length - agents.length;
    if (discarded > 0) {
      yield* Effect.logWarning("ignored invalid ACP Registry entries", { discarded });
    }
    return { version: envelope.version, agents } satisfies AcpRegistryIndex;
  });

  const readCachedRegistry = fileSystem
    .readFileString(registryCachePath)
    .pipe(Effect.flatMap(decodeRegistryText), Effect.option);

  const writeRegistryCache = (text: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.flatMap((id) => {
        const temporaryPath = `${registryCachePath}.${process.pid}-${id}.tmp`;
        return fileSystem
          .makeDirectory(registryDirectory, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(temporaryPath, text)),
            Effect.andThen(fileSystem.rename(temporaryPath, registryCachePath)),
            Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          );
      }),
      Effect.ignore,
    );

  const fetchRegistry = Effect.fn("AcpRegistryCatalog.fetchRegistry")(function* () {
    yield* assertHttpsUrl(registryUrl, "ACP Registry index URL must use HTTPS.");
    const response = yield* httpClient.execute(HttpClientRequest.get(registryUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: `Could not fetch ACP Registry index from ${registryUrl}.`,
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out fetching ACP Registry index.",
            }),
          ),
      }),
    );
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_REGISTRY_BYTES + 1,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "Could not read ACP Registry response body.",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out reading ACP Registry response body.",
            }),
          ),
      }),
    );
    if (collected.truncated || collected.bytes > MAX_REGISTRY_BYTES) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: `ACP Registry index exceeds ${MAX_REGISTRY_BYTES} bytes.`,
      });
    }
    if (collected.invalidUtf8) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "ACP Registry index is not valid UTF-8.",
      });
    }
    const registry = yield* decodeRegistryText(collected.text);
    yield* writeRegistryCache(collected.text);
    return registry;
  });

  const refreshRegistry = Effect.fn("AcpRegistryCatalog.refreshRegistry")(function* () {
    const observedRevision = yield* Ref.get(registryRevision);
    return yield* registrySemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentRevision = yield* Ref.get(registryRevision);
        const current = yield* Ref.get(registryRef);
        if (current !== undefined && currentRevision !== observedRevision) return current;

        const registry = yield* fetchRegistry().pipe(
          Effect.catch((networkError) =>
            readCachedRegistry.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(networkError),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        );
        yield* Ref.set(registryRef, registry);
        yield* Ref.update(registryRevision, (revision) => revision + 1);
        return registry;
      }),
    );
  });

  const loadCachedRegistry = Effect.fn("AcpRegistryCatalog.loadCachedRegistry")(function* () {
    const current = yield* Ref.get(registryRef);
    if (current !== undefined) return current;

    const cached = yield* readCachedRegistry;
    if (Option.isNone(cached)) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "No valid cached ACP Registry index is available.",
      });
    }
    yield* Ref.set(registryRef, cached.value);
    return cached.value;
  });

  const loadRegistry = Effect.fn("AcpRegistryCatalog.loadRegistry")(function* () {
    return yield* loadCachedRegistry().pipe(Effect.catch(() => refreshRegistry()));
  });

  const runCommand = Effect.fn("AcpRegistryCatalog.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: Duration.Input;
      readonly truncatedOutputReason?: AcpRegistryErrorReason;
    } = {},
  ) {
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(
        command,
        args,
        options.env === undefined ? {} : { env: options.env },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env === undefined ? {} : { env: options.env }),
          shell: resolved.shell,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 1024 * 1024 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry install command '${command}' exited with code ${Number(exitCode)}: ${stderr.text.trim()}`,
        });
      }
      // Archive listings feed validateArchiveEntries; a truncated listing would let
      // unvalidated entries past the traversal check, so oversized output is fatal.
      if (stdout.truncated) {
        return yield* new AcpRegistryError({
          reason: options.truncatedOutputReason ?? "archive_invalid",
          detail: `ACP Registry install command '${command}' produced more output than expected.`,
        });
      }
      return stdout.text;
    });
    const scoped = collect.pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not run ACP Registry install command '${command}'.`,
              cause,
            }),
      ),
    );
    return yield* options.timeout === undefined
      ? scoped
      : scoped.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              Effect.fail(
                new AcpRegistryError({
                  reason: "install_failed",
                  detail: `Timed out running ACP Registry install command '${command}'.`,
                }),
              ),
          }),
        );
  });

  const packageReceiptPath = (
    agentId: string,
    agentVersion: string,
    packageSpec: string,
    distribution: "npx" | "uvx",
    managerPath: string,
  ) =>
    sha256Hex(
      new TextEncoder().encode(`${agentVersion}\0${packageSpec}\0${distribution}\0${managerPath}`),
    ).pipe(
      Effect.map((digest) =>
        path.join(packageReceiptsDirectory, `${agentId}-${digest.slice(0, 16)}.json`),
      ),
    );

  const readPackageReceipt = Effect.fn("AcpRegistryCatalog.readPackageReceipt")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    managerPath: string,
  ) {
    const receipt = yield* fileSystem
      .readFileString(
        yield* packageReceiptPath(agent.id, agent.version, packageSpec, distribution, managerPath),
      )
      .pipe(
        Effect.map(decodePackageInstallReceipt),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (
      Option.isNone(receipt) ||
      receipt.value.agentId !== agent.id ||
      receipt.value.agentVersion !== agent.version ||
      receipt.value.distribution !== distribution ||
      receipt.value.packageSpec !== packageSpec ||
      receipt.value.managerPath !== managerPath ||
      path.dirname(receipt.value.installRoot) !==
        path.join(packageInstallRoot(agent, distribution), "generations") ||
      !/^[a-f0-9-]{36}$/u.test(path.basename(receipt.value.installRoot)) ||
      receipt.value.binDirectory !== packageBinDirectory(receipt.value.installRoot, distribution) ||
      path.dirname(receipt.value.executablePath) !== receipt.value.binDirectory
    ) {
      return Option.none<AcpRegistryPackageInstallReceipt>();
    }
    const executableExists = yield* fileSystem
      .exists(receipt.value.executablePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!executableExists) return Option.none<AcpRegistryPackageInstallReceipt>();

    if (distribution === "npx") {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      if (receipt.value.packageRoot === undefined || receipt.value.packageVersion === undefined) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(path.join(receipt.value.packageRoot, "package.json"))
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version ||
        receipt.value.packageVersion !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
    }
    return receipt;
  });

  const writePackageReceipt = Effect.fn("AcpRegistryCatalog.writePackageReceipt")(
    function* (receipt: AcpRegistryPackageInstallReceipt) {
      const receiptPath = yield* packageReceiptPath(
        receipt.agentId,
        receipt.agentVersion,
        receipt.packageSpec,
        receipt.distribution,
        receipt.managerPath,
      );
      const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
      yield* fileSystem.makeDirectory(packageReceiptsDirectory, { recursive: true });
      yield* fileSystem.remove(temporaryPath, { force: true });
      yield* fileSystem.writeFileString(temporaryPath, `${encodePackageInstallReceipt(receipt)}\n`);
      yield* fileSystem.rename(temporaryPath, receiptPath);
    },
    Effect.mapError((cause) =>
      isAcpRegistryError(cause)
        ? cause
        : new AcpRegistryError({
            reason: "install_failed",
            detail: "Could not record the globally installed ACP Registry command.",
            cause,
          }),
    ),
  );

  const parsePackageManagerPath = Effect.fn("AcpRegistryCatalog.parsePackageManagerPath")(
    function* (managerPath: string, output: string) {
      const lines = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry package manager '${managerPath}' returned an invalid global path.`,
        });
      }
      return lines[0]!;
    },
  );

  const npmCommandName = (
    agent: AcpRegistryAgent,
    packageName: string,
    manifest: typeof NpmPackageManifest.Type,
  ): string | undefined => {
    const packageBaseName = packageName.split("/").pop() ?? packageName;
    if (typeof manifest.bin === "string") return packageBaseName;
    const entries = Object.entries(manifest.bin).toSorted(([left], [right]) =>
      compareText(left, right),
    );
    if (entries.length === 1) return entries[0]![0];
    if (manifest.bin[packageBaseName] !== undefined) return packageBaseName;
    if (manifest.bin[agent.id] !== undefined) return agent.id;
    return new Set(entries.map(([, commandPath]) => commandPath)).size === 1
      ? entries[0]?.[0]
      : undefined;
  };

  const discoverNpmGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverNpmGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
      installRoot: string,
    ) {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      // npm redacts UUID-shaped segments even from `root` and `prefix` stdout.
      // The explicit private prefix owns the filesystem layout, including on Windows.
      const globalRoot =
        platform === "win32"
          ? path.join(installRoot, "node_modules")
          : path.join(installRoot, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, ...packageIdentity.name.split("/"));
      const manifestPath = path.join(packageRoot, "package.json");
      const manifestInfo = yield* fileSystem.stat(manifestPath).pipe(Effect.option);
      if (Option.isNone(manifestInfo) || manifestInfo.value.size > MAX_PACKAGE_MANIFEST_BYTES) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const commandName = npmCommandName(agent, packageIdentity.name, manifest.value);
      if (commandName === undefined) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = packageBinDirectory(installRoot, "npx");
      const executablePath = resolveExecutable(
        commandName,
        platform,
        withPreferredPath(environment, binDirectory, platform),
      );
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "npx" as const,
            packageSpec,
            managerPath,
            installRoot,
            binDirectory,
            executablePath,
            packageRoot,
            packageVersion: manifest.value.version,
          });
    },
  );

  const discoverUvGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverUvGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
    ) {
      const packageIdentity = parseUvxPackageSpec(packageSpec);
      const installedTools = yield* runCommand(managerPath, ["tool", "list"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
      const normalizedPackageName = packageIdentity.name.toLowerCase().replace(/[._-]+/gu, "-");
      const exactVersionInstalled = installedTools.split(/\r?\n/u).some((line) => {
        const match = /^(\S+) v(\S+)(?:\s|$)/u.exec(line);
        return (
          match?.[1]?.toLowerCase().replace(/[._-]+/gu, "-") === normalizedPackageName &&
          match[2] === packageIdentity.version
        );
      });
      if (!exactVersionInstalled) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = yield* runCommand(managerPath, ["tool", "dir", "--bin"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      }).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
      const commandEnvironment = withPreferredPath(environment, binDirectory, platform);
      const executablePath = packageCommandCandidates(agent, packageIdentity.name)
        .map((candidate) => resolveExecutable(candidate, platform, commandEnvironment))
        .find((candidate): candidate is string => candidate !== undefined);
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "uvx" as const,
            packageSpec,
            managerPath,
            installRoot: environment.UV_TOOL_DIR!,
            binDirectory,
            executablePath,
            packageVersion: packageIdentity.version,
          });
    },
  );

  const ensureGlobalPackage = Effect.fn("AcpRegistryCatalog.ensureGlobalPackage")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const managerName = packageManagerFor(distribution)!;
    const managerPath = resolveExecutable(managerName, platform, environment);
    if (managerPath === undefined) {
      return yield* new AcpRegistryError({
        reason: "runner_unavailable",
        detail: `ACP Registry agent ${agent.id} requires '${managerName}', but it is not available on this environment's PATH.`,
      });
    }
    const receipt = yield* readPackageReceipt(agent, distribution, packageSpec, managerPath);
    if (Option.isSome(receipt)) return receipt.value;

    // Python virtual environments embed absolute paths. Install to an immutable
    // candidate and atomically publish its receipt; never relocate its contents
    // or adopt an unreceipted directory left by a failed package manager.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const candidate = path.join(
          packageInstallRoot(agent, distribution),
          "generations",
          generation,
        );
        let published = false;
        yield* Effect.acquireRelease(
          fileSystem.makeDirectory(candidate, { recursive: true }),
          () =>
            published
              ? Effect.void
              : fileSystem.remove(candidate, { recursive: true, force: true }).pipe(Effect.ignore),
        );
        const packageEnvironment =
          distribution === "npx"
            ? { ...environment, npm_config_prefix: candidate }
            : {
                ...environment,
                UV_TOOL_DIR: candidate,
                UV_TOOL_BIN_DIR: packageBinDirectory(candidate, distribution),
              };
        const managerDirectory = yield* managerBinDirectory(managerPath);
        const installEnvironment = withPreferredPath(
          packageEnvironment,
          managerDirectory,
          platform,
        );
        yield* runCommand(
          managerPath,
          distribution === "npx"
            ? ["install", "--global", packageSpec]
            : ["tool", "install", "--force", packageSpec],
          {
            env: installEnvironment,
            timeout: PACKAGE_INSTALL_TIMEOUT,
            truncatedOutputReason: "install_failed",
          },
        );
        const installed = yield* distribution === "npx"
          ? discoverNpmGlobalPackage(agent, packageSpec, managerPath, packageEnvironment, candidate)
          : discoverUvGlobalPackage(agent, packageSpec, managerPath, packageEnvironment);
        if (
          Option.isNone(installed) ||
          installed.value.installRoot !== candidate ||
          installed.value.binDirectory !== packageBinDirectory(candidate, distribution)
        )
          return yield* new AcpRegistryError({
            reason: "install_failed",
            detail: `The package manager did not complete the private installation for ${agent.id}.`,
          });
        yield* writePackageReceipt(installed.value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              published = true;
            }),
          ),
          Effect.uninterruptible,
        );
        return installed.value;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not publish the managed installation for ${agent.id}.`,
              cause,
            }),
      ),
    );
  });

  const acquireInstallLock = Effect.fn("AcpRegistryCatalog.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (acquired) return;
      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new AcpRegistryError({
      reason: "install_failed",
      detail: `Timed out waiting for ACP Registry install lock ${lockPath}.`,
    });
  });

  const assertExecutableInRoot = Effect.fn("AcpRegistryCatalog.assertExecutableInRoot")(function* (
    root: string,
    executablePath: string,
  ) {
    const rootRealPath = yield* fileSystem.realPath(root);
    const executableRealPath = yield* fileSystem.realPath(executablePath);
    const relative = path.relative(rootRealPath, executableRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command resolves outside its installation directory.",
      });
    }
    const info = yield* fileSystem.stat(executableRealPath);
    const hasExecutableMode = platform === "win32" || (info.mode & 0o111) !== 0;
    if (info.type !== "File" || !hasExecutableMode) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command is not a regular executable file.",
      });
    }
    return executableRealPath;
  });

  const binaryPaths = (agent: AcpRegistryAgent, target: typeof AcpRegistryBinaryTarget.Type) => {
    const commandSegments = normalizeRegistryCommandPath(target.cmd);
    if (platformTarget === undefined || commandSegments === undefined) return undefined;
    const targetIdentity = Hex.encode(sha256(new TextEncoder().encode(JSON.stringify(target))));
    const installRoot = path.join(agentInstallRoot(agent), platformTarget, targetIdentity);
    return {
      commandSegments,
      installRoot,
      executablePath: path.join(installRoot, ...commandSegments),
    };
  };

  const installBinary = Effect.fn("AcpRegistryCatalog.installBinary")(function* (
    agent: AcpRegistryAgent,
    target: typeof AcpRegistryBinaryTarget.Type,
    onProgress?: Progress,
  ) {
    if (platformTarget === undefined) {
      return yield* new AcpRegistryError({
        reason: "unsupported_platform",
        detail: `ACP Registry does not support platform ${platform}-${architecture}.`,
      });
    }
    const paths = binaryPaths(agent, target);
    if (paths === undefined) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: `ACP Registry agent ${agent.id} declares an unsafe command path '${target.cmd}'.`,
      });
    }
    const { commandSegments, installRoot, executablePath } = paths;
    if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* assertExecutableInRoot(installRoot, executablePath).pipe(
        Effect.mapError((cause) =>
          isAcpRegistryError(cause)
            ? cause
            : new AcpRegistryError({
                reason: "install_failed",
                detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                cause,
              }),
        ),
      );
    }

    yield* fileSystem.makeDirectory(path.dirname(installRoot), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create ACP Registry cache for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const lockPath = `${installRoot}.lock`;
    yield* acquireInstallLock(lockPath).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not acquire install lock for ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
        return yield* assertExecutableInRoot(installRoot, executablePath);
      }
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(installRoot),
        prefix: `.${agent.id}-install-`,
      });
      const extractionRoot = path.join(temporaryRoot, "extracted");
      yield* fileSystem.makeDirectory(extractionRoot, { recursive: true });
      const kind = archiveKind(target.archive);
      const archivePath = path.join(temporaryRoot, archiveFileName(kind));
      yield* (
        onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: null }) ?? Effect.void
      );
      const response = yield* httpClient.execute(HttpClientRequest.get(target.archive)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "download_failed",
              detail: `Could not download ACP Registry agent ${agent.id} ${agent.version}.`,
              cause,
            }),
        ),
        Effect.timeoutOrElse({
          duration: ARCHIVE_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Timed out downloading ACP Registry agent ${agent.id} ${agent.version}.`,
              }),
            ),
        }),
      );
      // Hash while streaming: archives can be up to MAX_ARCHIVE_BYTES, and
      // Effect's Crypto only digests a whole buffer.
      const hash = sha256.create();
      let downloadedBytes = 0;
      const rawTotal = Number(response.headers["content-length"]);
      const totalBytes =
        Number.isFinite(rawTotal) && rawTotal > 0 && rawTotal <= MAX_ARCHIVE_BYTES
          ? rawTotal
          : null;
      yield* response.stream.pipe(
        Stream.tap((chunk) => {
          if (downloadedBytes + chunk.byteLength > MAX_ARCHIVE_BYTES) {
            return Effect.fail(
              new AcpRegistryError({
                reason: "archive_invalid",
                detail: `ACP Registry agent ${agent.id} archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`,
              }),
            );
          }
          downloadedBytes += chunk.byteLength;
          hash.update(chunk);
          return onProgress?.({ phase: "downloading", downloadedBytes, totalBytes }) ?? Effect.void;
        }),
        Stream.run(fileSystem.sink(archivePath)),
        Effect.mapError((cause) =>
          isAcpRegistryError(cause)
            ? cause
            : new AcpRegistryError({
                reason: "download_failed",
                detail: `Could not save ACP Registry agent ${agent.id} ${agent.version}.`,
                cause,
              }),
        ),
        Effect.timeoutOrElse({
          duration: ARCHIVE_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Timed out reading ACP Registry agent ${agent.id} download.`,
              }),
            ),
        }),
      );
      yield* onProgress?.({ phase: "verifying", downloadedBytes, totalBytes }) ?? Effect.void;
      if (target.sha256 !== undefined) {
        const actual = Hex.encode(hash.digest());
        if (actual !== target.sha256.toLowerCase()) {
          return yield* new AcpRegistryError({
            reason: "checksum_mismatch",
            detail: `ACP Registry agent ${agent.id} download did not match its declared SHA-256.`,
          });
        }
      }

      yield* onProgress?.({ phase: "extracting", downloadedBytes, totalBytes }) ?? Effect.void;
      if (kind === "raw") {
        const targetPath = path.join(extractionRoot, ...commandSegments);
        yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
        yield* fileSystem.rename(archivePath, targetPath);
      } else {
        const listArgs =
          kind === "tar_gz"
            ? ["-tzf", archivePath]
            : kind === "tar_bz2"
              ? ["-tjf", archivePath]
              : platform === "win32"
                ? ["-tf", archivePath]
                : undefined;
        const entries =
          listArgs === undefined
            ? yield* runCommand("unzip", ["-Z1", archivePath])
            : yield* runCommand("tar", listArgs);
        if (!validateArchiveEntries(entries)) {
          return yield* new AcpRegistryError({
            reason: "archive_invalid",
            detail: `ACP Registry agent ${agent.id} archive contains an unsafe path.`,
          });
        }
        if (kind === "zip" && platform !== "win32") {
          yield* runCommand("unzip", ["-q", archivePath, "-d", extractionRoot]);
        } else {
          const extractFlag = kind === "tar_gz" ? "-xzf" : kind === "tar_bz2" ? "-xjf" : "-xf";
          yield* runCommand("tar", [extractFlag, archivePath, "-C", extractionRoot]);
        }
      }

      const stagedExecutable = path.join(extractionRoot, ...commandSegments);
      if (!(yield* fileSystem.exists(stagedExecutable).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new AcpRegistryError({
          reason: "archive_invalid",
          detail: `ACP Registry archive for ${agent.id} did not contain '${target.cmd}'.`,
        });
      }
      if (platform !== "win32") yield* fileSystem.chmod(stagedExecutable, 0o755);
      yield* assertExecutableInRoot(extractionRoot, stagedExecutable);
      yield* fileSystem.remove(installRoot, { recursive: true, force: true });
      yield* fileSystem.rename(extractionRoot, installRoot);
      return yield* assertExecutableInRoot(installRoot, executablePath);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not install ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );
  });

  const findAgent = Effect.fn("AcpRegistryCatalog.findAgent")(function* (
    registry: AcpRegistryIndex,
    agentId: string,
  ) {
    const agent = registry.agents.find((candidate) => candidate.id === agentId.trim());
    if (agent === undefined) {
      return yield* new AcpRegistryError({
        reason: "agent_not_found",
        detail: `ACP Registry does not contain agent '${agentId.trim()}'.`,
      });
    }
    return agent;
  });

  const distributionAvailability = (
    agent: AcpRegistryAgent,
    environment: NodeJS.ProcessEnv = hostEnvironment,
  ): ReadonlyArray<AcpRegistryDistributionAvailability> =>
    (["binary", "npx", "uvx"] as const).flatMap((kind) => {
      if (agent.distribution[kind] === undefined) return [];
      const selected = resolveAcpRegistryDistribution({ agent, preference: kind, platformTarget });
      const archive = selected?.binaryTarget?.archive;
      const format = archive === undefined ? "raw" : archiveKind(archive);
      const runner =
        packageManagerFor(kind) ??
        (format === "raw" ? null : format === "zip" && platform !== "win32" ? "unzip" : "tar");
      const reason =
        selected === undefined
          ? "unsupported_platform"
          : selected.binaryTarget && binaryPaths(agent, selected.binaryTarget) === undefined
            ? "unsupported_distribution"
            : runner !== null && resolveExecutable(runner, platform, environment) === undefined
              ? "runner_unavailable"
              : null;
      return [{ kind, available: reason === null, runner, reason }];
    });

  const selectDistribution = (
    agent: AcpRegistryAgent,
    preference: AcpRegistryDistributionPreference,
    environment: NodeJS.ProcessEnv = hostEnvironment,
  ) =>
    resolveAcpRegistryDistribution({
      agent,
      preference:
        preference === "auto"
          ? (distributionAvailability(agent, environment).find((entry) => entry.available)?.kind ??
            "auto")
          : preference,
      platformTarget,
    });

  const compatibleDistribution = Effect.fn("AcpRegistryCatalog.compatibleDistribution")(function* (
    agent: AcpRegistryAgent,
    preference: AcpRegistryDistributionPreference,
    environment: NodeJS.ProcessEnv = hostEnvironment,
  ) {
    const distribution = selectDistribution(agent, preference, environment);
    if (distribution === undefined) {
      return yield* new AcpRegistryError({
        reason: platformTarget === undefined ? "unsupported_platform" : "unsupported_distribution",
        detail: `ACP Registry agent ${agent.id} has no ${preference === "auto" ? "compatible" : preference} distribution for ${platform}-${architecture}.`,
      });
    }
    return distribution;
  });

  const search: AcpRegistryCatalog["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const registry = yield* refreshRegistry();
      const ranked = registry.agents.flatMap((agent) => {
        const rank = searchRank(agent, input.query);
        return rank === undefined ? [] : [{ agent, rank }];
      });
      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
          compareText(left.agent.id, right.agent.id),
      );
      return {
        agents: ranked.slice(0, MAX_SEARCH_RESULTS).map(({ agent }) => {
          const distributions = distributionAvailability(agent);
          const recommended = distributions.find((entry) => entry.available);
          const distribution = recommended
            ? resolveAcpRegistryDistribution({
                agent,
                preference: recommended.kind,
                platformTarget,
              })
            : undefined;
          return {
            id: agent.id,
            name: agent.name,
            version: agent.version,
            description: agent.description,
            authors: agent.authors ?? [],
            license: agent.license ?? null,
            website: agent.website ?? null,
            repository: agent.repository ?? null,
            icon: agent.icon ?? null,
            distributions,
            distribution: distribution?.kind ?? null,
            integrity:
              distribution === undefined
                ? null
                : distribution.binaryTarget?.sha256 !== undefined
                  ? "sha256"
                  : "registry",
          };
        }),
      } satisfies AcpRegistrySearchResult;
    });

  const preview: AcpRegistryCatalog["Service"]["preview"] = (input) =>
    Effect.gen(function* () {
      const agent = yield* findAgent(yield* loadCachedRegistry(), input.agentId);
      const distribution = yield* compatibleDistribution(agent, input.distribution ?? "auto");
      const availability = distributionAvailability(agent).find(
        (entry) => entry.kind === distribution.kind,
      )!;
      const binary = distribution.binaryTarget;
      const binaryRoot = binary ? binaryPaths(agent, binary)?.installRoot : undefined;
      if (binary && binaryRoot === undefined)
        return yield* new AcpRegistryError({
          reason: "unsupported_distribution",
          detail: "The selected Agent distribution does not have a valid executable path.",
        });
      const identity = yield* installationIdentity(agent, distribution.kind);
      return {
        agentId: agent.id,
        installationId: identity.installationId,
        version: agent.version,
        distribution: distribution.kind,
        integrity: binary?.sha256 === undefined ? "registry" : "sha256",
        sha256: binary?.sha256 ?? null,
        packageSpec: distribution.packageName ?? null,
        archiveUrl: binary?.archive ?? null,
        installDirectory:
          binaryRoot ?? packageInstallRoot(agent, distribution.kind as "npx" | "uvx"),
        receiptPath: identity.receiptPath,
        runner: availability.runner,
        runnerPath:
          availability.runner === null
            ? null
            : (resolveExecutable(availability.runner, platform, hostEnvironment) ?? null),
        available: availability.available,
        reason: availability.reason,
      } satisfies AcpRegistryInstallPreview;
    });

  const prepare: AcpRegistryCatalog["Service"]["prepare"] = (input, onProgress) =>
    Effect.gen(function* () {
      const registry = yield* refreshRegistry();
      const agent = yield* findAgent(registry, input.agentId);
      const distribution = yield* compatibleDistribution(agent, input.distribution ?? "auto");
      if (
        input.expectedInstallationId !== undefined &&
        input.expectedInstallationId !==
          (yield* installationIdentity(agent, distribution.kind)).installationId
      )
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail:
            "The Agent distribution changed. Refresh its installation preview before installing.",
        });
      const installationId = yield* installSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (distribution.kind === "binary") {
            // Only an explicit command override opts into an executable on PATH.
            yield* installBinary(agent, distribution.binaryTarget!, onProgress);
          } else {
            yield* (
              onProgress?.({ phase: "installing", downloadedBytes: 0, totalBytes: null }) ??
                Effect.void
            );
            yield* ensureGlobalPackage(
              agent,
              distribution.kind,
              distribution.packageName!,
              hostEnvironment,
            );
          }
          const installationId = yield* recordInstallation(agent, distribution.kind);
          yield* reservePreparedInstallation(agent.id);
          return installationId;
        }),
      );
      return {
        agentId: agent.id,
        version: agent.version,
        distribution: distribution.kind,
        installationId,
        prepared: true,
      } satisfies AcpRegistryPrepareResult;
    });

  const validateLocalExecutable = (command: string) =>
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
      ? Effect.fail(
          new AcpRegistryError({
            reason: "runner_unavailable",
            detail:
              "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
          }),
        )
      : Effect.void;

  const inspectInstallation = (
    settings: AcpRegistrySettings,
    environment?: NodeJS.ProcessEnv,
  ): Effect.Effect<AcpRegistryInstallationInspection, AcpRegistryError> =>
    Effect.gen(function* () {
      if (settings.source === "local") {
        const command = settings.commandPath.trim();
        if (!command) return { status: "unconfigured" } as const;
        const executable = resolveExecutable(command, platform, environment ?? hostEnvironment);
        if (executable !== undefined) yield* validateLocalExecutable(executable);
        return executable === undefined
          ? ({
              status: "missing_runner",
              version: null,
              distribution: "local",
            } as const)
          : ({ status: "ready", agentId: command, version: null, distribution: "local" } as const);
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) return { status: "unconfigured" } as const;
      const pinned = yield* installedAgent(settings);
      const agent =
        pinned?.agent ??
        (yield* loadCachedRegistry()).agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return { status: "not_found", agentId } as const;
      const documentationUrl = agent.website ?? agent.repository;
      const distribution = selectDistribution(
        agent,
        pinned?.distribution ?? settings.distribution,
        environment,
      );
      if (distribution === undefined) {
        return { status: "unsupported", agentId, version: agent.version } as const;
      }

      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const available =
          resolveExecutable(commandOverride, platform, environment ?? hostEnvironment) !==
          undefined;
        return available
          ? ({
              status: "ready",
              agentId,
              // The catalog version does not describe an overridden executable.
              version: null,
              distribution: distribution.kind,
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const)
          : ({
              status: "missing_runner",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
              runner: commandOverride,
            } as const);
      }

      if (distribution.kind === "binary") {
        return yield* installSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const paths = binaryPaths(agent, distribution.binaryTarget!);
            if (paths === undefined) {
              return { status: "unsupported", agentId, version: agent.version } as const;
            }
            const exists = yield* fileSystem
              .exists(paths.executablePath)
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              return {
                status: "unprepared",
                agentId,
                version: agent.version,
                distribution: "binary",
              } as const;
            }
            yield* assertExecutableInRoot(paths.installRoot, paths.executablePath).pipe(
              Effect.mapError((cause) =>
                isAcpRegistryError(cause)
                  ? cause
                  : new AcpRegistryError({
                      reason: "install_failed",
                      detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                      cause,
                    }),
              ),
            );
            return {
              status: "ready",
              agentId,
              version: agent.version,
              distribution: "binary",
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const;
          }),
        );
      }

      const runner = packageManagerFor(distribution.kind)!;
      const managerPath = resolveExecutable(runner, platform, environment ?? hostEnvironment);
      if (managerPath !== undefined) {
        const receipt = yield* readPackageReceipt(
          agent,
          distribution.kind,
          distribution.packageName!,
          managerPath,
        );
        if (Option.isNone(receipt))
          return {
            status: "unprepared",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
          } as const;
      }
      const available =
        resolveExecutable(runner, platform, environment ?? hostEnvironment) !== undefined;
      return available
        ? ({
            status: "ready",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            ...(documentationUrl ? { documentationUrl } : {}),
          } as const)
        : ({
            status: "missing_runner",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            runner,
          } as const);
    });

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = (settings, environment) =>
    Effect.gen(function* () {
      const inspection = yield* inspectInstallation(settings, environment);
      const cached =
        settings.source === "local"
          ? undefined
          : yield* loadCachedRegistry().pipe(Effect.orElseSucceed(() => undefined));
      return {
        ...inspection,
        latestVersion:
          cached?.agents.find((agent) => agent.id === settings.agentId)?.version ?? null,
      };
    });

  const applyAgentEnvironment = (
    settings: AcpRegistrySettings,
    environment: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv => {
    const identity =
      settings.source === "registry" ? settings.agentId : (settings.agentIdentity ?? "");
    return identity === "claude-acp" || identity === "claude-agent-acp"
      ? {
          ...environment,
          CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: environment.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2 ?? "1",
        }
      : environment;
  };

  const resolve: AcpRegistryCatalog["Service"]["resolve"] = (settings, cwd, environment) =>
    Effect.gen(function* () {
      if (settings.source === "local") {
        const executable = settings.commandPath.trim();
        if (!executable) {
          return yield* new AcpRegistryError({
            reason: "agent_not_configured",
            detail: "Local ACP provider requires an executable.",
          });
        }
        const env = applyAgentEnvironment(settings, environment ?? hostEnvironment);
        const command = resolveExecutable(executable, platform, env);
        if (command === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: "Local ACP executable is not available on this environment's PATH.",
          });
        }
        yield* validateLocalExecutable(command);
        return {
          distribution: "local",
          spawn: { command, args: settings.commandArgs, cwd, env, shell: false },
        } satisfies ResolvedAcpRegistryAgent;
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "ACP Registry provider requires a registry agent ID.",
        });
      }
      const pinned = yield* installedAgent(settings);
      const agent = pinned?.agent ?? (yield* findAgent(yield* loadRegistry(), agentId));
      const distribution = yield* compatibleDistribution(
        agent,
        pinned?.distribution ?? settings.distribution,
        environment,
      );

      let command: string;
      let args: ReadonlyArray<string>;
      let commandBinDirectory: string | undefined;
      const effectiveEnvironment = environment ?? hostEnvironment;
      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const resolvedOverride = resolveExecutable(commandOverride, platform, effectiveEnvironment);
        if (resolvedOverride === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: `ACP Registry agent ${agent.id} requires '${commandOverride}', but it is not available on this provider instance's PATH.`,
          });
        }
        command = resolvedOverride;
        args = distribution.args;
      } else if (distribution.kind === "npx" || distribution.kind === "uvx") {
        const installed = yield* installSemaphore.withPermits(1)(
          settings.discovery === "explicit"
            ? Effect.gen(function* () {
                const managerPath = resolveExecutable(
                  packageManagerFor(distribution.kind)!,
                  platform,
                  effectiveEnvironment,
                );
                const receipt =
                  managerPath === undefined
                    ? Option.none<AcpRegistryPackageInstallReceipt>()
                    : yield* readPackageReceipt(
                        agent,
                        distribution.kind as "npx" | "uvx",
                        distribution.packageName!,
                        managerPath,
                      );
                if (Option.isNone(receipt))
                  return yield* new AcpRegistryError({
                    reason: "install_failed",
                    detail: "Install this Agent distribution before connecting.",
                  });
                return receipt.value;
              })
            : ensureGlobalPackage(
                agent,
                distribution.kind,
                distribution.packageName!,
                effectiveEnvironment,
              ),
        );
        command = installed.executablePath;
        args = distribution.args;
        commandBinDirectory = installed.binDirectory;
      } else {
        const target = distribution.binaryTarget!;
        command = yield* installSemaphore.withPermits(1)(
          settings.discovery === "explicit"
            ? Effect.gen(function* () {
                const paths = binaryPaths(agent, target);
                if (
                  !paths ||
                  !(yield* fileSystem
                    .exists(paths.executablePath)
                    .pipe(Effect.orElseSucceed(() => false)))
                )
                  return yield* new AcpRegistryError({
                    reason: "install_failed",
                    detail: "Install this Agent distribution before connecting.",
                  });
                return yield* assertExecutableInRoot(paths.installRoot, paths.executablePath).pipe(
                  Effect.mapError((cause) =>
                    isAcpRegistryError(cause)
                      ? cause
                      : new AcpRegistryError({
                          reason: "install_failed",
                          detail: "The prepared executable is unavailable.",
                          cause,
                        }),
                  ),
                );
              })
            : installBinary(agent, target),
        );
        args = distribution.args;
      }

      const baseSpawnEnvironment = {
        ...effectiveEnvironment,
        ...distribution.env,
      };
      // Managed JavaScript entrypoints must keep working with isolated HOME,
      // where host version-manager shims can no longer resolve their toolchain.
      const packageEnvironment =
        distribution.kind === "npx"
          ? withPreferredPath(baseSpawnEnvironment, runtimeNodeDirectory, platform)
          : baseSpawnEnvironment;
      const spawnEnvironment =
        commandBinDirectory === undefined
          ? packageEnvironment
          : withPreferredPath(packageEnvironment, commandBinDirectory, platform);

      return {
        agent,
        distribution: distribution.kind,
        spawn: {
          command,
          args,
          cwd,
          env: applyAgentEnvironment(settings, spawnEnvironment),
        },
      } satisfies ResolvedAcpRegistryAgent;
    });

  const uninstallManagedBinary: AcpRegistryCatalog["Service"]["uninstallManagedBinary"] = (input) =>
    hostSettings
      .withSnapshot((settings) =>
        installSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const safeAgentId = yield* decodeBoundedAgentId(input.agentId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: "ACP Registry managed binary uninstall received an invalid agent ID.",
                    cause,
                  }),
              ),
            );
            const isReferenced = Object.values(settings.providerInstances).some((instance) => {
              if (
                instance.driver !== "acpRegistry" ||
                instance.config === null ||
                typeof instance.config !== "object"
              )
                return false;
              const config = instance.config as Record<string, unknown>;
              return (
                config.source !== "local" &&
                typeof config.agentId === "string" &&
                config.agentId.trim() === safeAgentId
              );
            });
            if (isReferenced) {
              yield* consumePreparedInstallationReservation(safeAgentId);
              return yield* new AcpRegistryError({
                reason: "busy",
                detail: "This Agent installation is referenced by a configured instance.",
              });
            }
            if (yield* hasPreparedInstallationReservation(safeAgentId)) {
              return yield* new AcpRegistryError({
                reason: "busy",
                detail:
                  "This Agent installation has just been prepared. Retry after setup finishes.",
              });
            }
            const agentRoot = path.join(installsDirectory, safeAgentId);
            const existed = yield* fileSystem.exists(agentRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not inspect the managed binary cache for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            if (!existed) return { agentId: safeAgentId, removed: false };

            let removed = false;
            yield* Effect.gen(function* () {
              for (const version of yield* fileSystem.readDirectory(agentRoot)) {
                const versionRoot = path.join(agentRoot, version);
                for (const entry of yield* fileSystem.readDirectory(versionRoot)) {
                  if (!/^(?:(?:darwin|linux|windows)-(?:aarch64|x86_64)|npm|python)$/u.test(entry))
                    continue;
                  yield* fileSystem.remove(path.join(versionRoot, entry), {
                    recursive: true,
                    force: true,
                  });
                  removed = true;
                }
                if ((yield* fileSystem.readDirectory(versionRoot)).length === 0)
                  yield* fileSystem.remove(versionRoot, { recursive: true });
              }
              if ((yield* fileSystem.readDirectory(agentRoot)).length === 0)
                yield* fileSystem.remove(agentRoot, { recursive: true });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not remove managed binaries for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            return { agentId: safeAgentId, removed };
          }),
        ),
      )
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail:
                "Could not read provider settings while checking managed ACP binary references.",
              cause,
            }),
        }),
      );

  return AcpRegistryCatalog.of({
    search,
    preview,
    prepare,
    inspect,
    resolve,
    uninstallManagedBinary,
  });
});
