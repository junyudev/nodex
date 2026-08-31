import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexEndpointMap } from "./CodexEndpointMap";
import { CodexThreadHostResolver } from "./CodexGateway";
import type { CodexRuntimeError } from "./CodexRuntimeError";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const NON_NUMERIC_IDENTIFIER = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const PRERELEASE = `${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMANTIC_VERSION = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE})?(?:\\+${BUILD})?`;

const EXACT_SEMANTIC_VERSION = new RegExp(`^(${SEMANTIC_VERSION})$`, "u");
const CODEX_USER_AGENT_VERSION = new RegExp(
  `(?:^|[\\s;(])(?:Codex Desktop|codex-cli|codex_cli_rs|codex-app-server)[/\\s]+v?(${SEMANTIC_VERSION})(?=$|[\\s;)])`,
  "iu",
);

interface ParsedSemanticVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

export const CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS = Object.freeze({
  forkLastTurnId: "0.143.0-alpha.32",
  paginatedHistory: "0.145.0-alpha.15",
  searchOccurrences: "0.145.0-alpha.24",
  ephemeralFork: "0.146.0-alpha.7",
  sideConversation: "0.146.0-alpha.8",
  threadRevert: "0.148.0-alpha.13",
} as const);

export type CodexAppServerCapability = keyof typeof CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS;

export type CodexAppServerCapabilityFlags = Readonly<Record<CodexAppServerCapability, boolean>>;

/**
 * `0.0.0` is an unversioned development sentinel, not the oldest SemVer release.
 * Only APIs with an explicit development contract are enabled. History storage and
 * fork formats remain fail-closed because their wire shapes require version proof.
 */
export const CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS = Object.freeze({
  forkLastTurnId: false,
  paginatedHistory: false,
  searchOccurrences: true,
  ephemeralFork: false,
  sideConversation: false,
  threadRevert: true,
}) satisfies CodexAppServerCapabilityFlags;

const FAIL_CLOSED_CAPABILITY_FLAGS = Object.freeze({
  forkLastTurnId: false,
  paginatedHistory: false,
  searchOccurrences: false,
  ephemeralFork: false,
  sideConversation: false,
  threadRevert: false,
}) satisfies CodexAppServerCapabilityFlags;

export interface CodexAppServerCapabilitySnapshotInput {
  readonly hostId: string;
  readonly generation: number;
  readonly userAgent: string;
}

export interface CodexAppServerCapabilitySnapshot {
  readonly hostId: string;
  readonly generation: number;
  readonly userAgent: string;
  readonly version: string | null;
  readonly flags: CodexAppServerCapabilityFlags;
}

export class CodexAppServerCapabilities extends Context.Service<
  CodexAppServerCapabilities,
  {
    readonly forHost: (
      hostId: string,
    ) => Effect.Effect<CodexAppServerCapabilitySnapshot, CodexRuntimeError>;
    readonly forThread: (
      threadId: string,
    ) => Effect.Effect<CodexAppServerCapabilitySnapshot, CodexRuntimeError>;
    readonly isCurrent: (
      snapshot: CodexAppServerCapabilitySnapshot,
    ) => Effect.Effect<boolean, CodexRuntimeError>;
  }
>()("nodex/main/codex-runtime/CodexAppServerCapabilities") {}

const parseSemanticVersion = (value: string): ParsedSemanticVersion | null => {
  const match = EXACT_SEMANTIC_VERSION.exec(value);
  if (!match) return null;

  const coreAndPrerelease = value.split("+", 1)[0]!;
  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core = (
    prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator)
  ).split(".");
  if (core.length !== 3) return null;

  const prerelease =
    prereleaseSeparator === -1 ? null : coreAndPrerelease.slice(prereleaseSeparator + 1).split(".");
  return {
    core: core as [string, string, string],
    prerelease,
  };
};

const compareNumericIdentifiers = (left: string, right: string): -1 | 0 | 1 => {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const comparePrereleaseIdentifiers = (left: string, right: string): -1 | 0 | 1 => {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);
  if (leftIsNumeric && rightIsNumeric) return compareNumericIdentifiers(left, right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compareSemanticVersions = (
  left: ParsedSemanticVersion,
  right: ParsedSemanticVersion,
): -1 | 0 | 1 => {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index]!, right.core[index]!);
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = comparePrereleaseIdentifiers(
      left.prerelease[index]!,
      right.prerelease[index]!,
    );
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length < right.prerelease.length) return -1;
  if (left.prerelease.length > right.prerelease.length) return 1;
  return 0;
};

/** Extracts only an app-server product version, never an unrelated OS/browser version. */
export function extractCodexAppServerVersion(userAgent: string | null | undefined): string | null {
  const normalized = userAgent?.trim();
  if (!normalized) return null;

  const exact = EXACT_SEMANTIC_VERSION.exec(normalized);
  if (exact?.[1]) return exact[1];

  return CODEX_USER_AGENT_VERSION.exec(normalized)?.[1] ?? null;
}

const capabilityFlagsForVersion = (version: string | null): CodexAppServerCapabilityFlags => {
  if (version === null) return FAIL_CLOSED_CAPABILITY_FLAGS;
  if (version === "0.0.0") return CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS;

  const parsedVersion = parseSemanticVersion(version);
  if (!parsedVersion) return FAIL_CLOSED_CAPABILITY_FLAGS;

  const supports = (minimumVersion: string): boolean => {
    const parsedMinimum = parseSemanticVersion(minimumVersion);
    return parsedMinimum !== null && compareSemanticVersions(parsedVersion, parsedMinimum) >= 0;
  };
  return Object.freeze({
    forkLastTurnId: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.forkLastTurnId),
    paginatedHistory: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.paginatedHistory),
    searchOccurrences: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.searchOccurrences),
    ephemeralFork: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.ephemeralFork),
    sideConversation: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.sideConversation),
    threadRevert: supports(CODEX_APP_SERVER_CAPABILITY_MINIMUM_VERSIONS.threadRevert),
  });
};

/**
 * Produces the immutable policy snapshot owned by one physical host generation.
 * Callers must replace it rather than carrying flags across a reconnect.
 */
export function createCodexAppServerCapabilitySnapshot(
  input: CodexAppServerCapabilitySnapshotInput,
): CodexAppServerCapabilitySnapshot {
  const hostId = input.hostId.trim();
  if (!hostId) throw new TypeError("Codex app-server capability hostId must not be empty");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError("Codex app-server capability generation must be a non-negative integer");
  }

  const version = extractCodexAppServerVersion(input.userAgent);
  return Object.freeze({
    hostId,
    generation: input.generation,
    userAgent: input.userAgent,
    version,
    flags: capabilityFlagsForVersion(version),
  });
}

/** Projects capability policy from the exact physical session generation that owns the wire. */
export const make: Effect.Effect<
  CodexAppServerCapabilities["Service"],
  never,
  CodexEndpointMap | CodexThreadHostResolver
> = Effect.gen(function* () {
  const endpoints = yield* CodexEndpointMap;
  const threadHosts = yield* CodexThreadHostResolver;

  const forHost = Effect.fn("CodexAppServerCapabilities.forHost")(function* (hostId: string) {
    const endpoint = yield* endpoints.endpoint(hostId);
    const session = yield* endpoint.session;
    return createCodexAppServerCapabilitySnapshot({
      hostId: session.hostId,
      generation: session.generation,
      userAgent: session.initialize.userAgent,
    });
  });

  const forThread = Effect.fn("CodexAppServerCapabilities.forThread")(function* (threadId: string) {
    const hostId = yield* threadHosts.resolve(threadId);
    return yield* forHost(hostId);
  });

  const isCurrent = Effect.fn("CodexAppServerCapabilities.isCurrent")(function* (
    snapshot: CodexAppServerCapabilitySnapshot,
  ) {
    const current = yield* forHost(snapshot.hostId);
    return current.generation === snapshot.generation && current.userAgent === snapshot.userAgent;
  });

  return CodexAppServerCapabilities.of({ forHost, forThread, isCurrent });
});

export const live: Layer.Layer<
  CodexAppServerCapabilities,
  never,
  CodexEndpointMap | CodexThreadHostResolver
> = Layer.effect(CodexAppServerCapabilities, make);
