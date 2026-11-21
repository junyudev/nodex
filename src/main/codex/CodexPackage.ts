import { defineMessages, getMainIntl } from "../i18n/main-intl";
import type { CodexExecutableProbe } from "../../shared/codex-executable-settings";
import { CODEX_APP_SERVER_MINIMUM_VERSION } from "../../shared/codex-app-server-version";
import { lstat } from "node:fs/promises";
import path from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { AGENT_RUNTIME_METADATA_FILENAME } from "../../shared/codex-runtime-metadata";
import type { CodexPackageUnavailableReason } from "@nodex/agent-runtime/contracts";
import {
  type CodexPackageLocation,
  runRuntimeResolution,
  verifyCodexPackage,
  type VerifiedCodexPackage,
} from "./codex-runtime";

type Location = CodexPackageLocation;
type Target = Parameters<typeof verifyCodexPackage>[1];

export type ExternalCodexPackage = Pick<
  VerifiedCodexPackage,
  "binaryPath" | "additionalSearchPaths" | "version" | "appServerRuntimeVersion"
> & {
  readonly source: "external";
  readonly appServerIdentity?: never;
  readonly rootPath?: never;
};

export type AvailableCodexPackage = VerifiedCodexPackage | ExternalCodexPackage;

export type CodexPackageAvailability =
  | { readonly status: "available"; readonly package: AvailableCodexPackage }
  | {
      readonly status: "unavailable";
      readonly reason: CodexPackageUnavailableReason;
      readonly message: string;
    };

const externalErrors = defineMessages({
  "not-found": {
    id: "main.codex.executableNotFound",
    defaultMessage: "The Codex executable was not found.",
  },
  "invalid-version": {
    id: "main.codex.executableUnknownVersion",
    defaultMessage: "The Codex executable did not report a recognizable version.",
  },
  "probe-failed": {
    id: "main.codex.executableProbeFailed",
    defaultMessage: "The Codex executable could not report its version.",
  },
});

export function externalCodexPackage(probe: CodexExecutableProbe): CodexPackageAvailability {
  if (probe.status === "ready")
    return {
      status: "available",
      package: {
        source: "external",
        binaryPath: probe.binaryPath,
        version: probe.version,
        appServerRuntimeVersion: probe.version,
        additionalSearchPaths: [],
      },
    };
  return {
    status: "unavailable",
    reason: "external-unusable",
    message:
      probe.status === "too-old"
        ? getMainIntl().formatMessage(
            {
              id: "main.codex.executableTooOld",
              defaultMessage: "Codex requires version {minimum} or newer.",
            },
            { minimum: CODEX_APP_SERVER_MINIMUM_VERSION },
          )
        : getMainIntl().formatMessage(externalErrors[probe.status]),
  };
}

const notInstalled = {
  status: "unavailable",
  reason: "not-installed",
  message: "Codex is not installed.",
} as const;

async function packageExists(location: Location, platform?: string) {
  const candidates = [
    AGENT_RUNTIME_METADATA_FILENAME,
    "codex-package.json",
    platform === "win32" ? "bin/codex.exe" : "bin/codex",
  ];
  for (const relativePath of candidates) {
    try {
      await lstat(path.join(location.rootPath, relativePath));
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return false;
}

/** The single lane from an absent package to a verified, process-owned executable. */
export const makeCodexPackage = (location: Location, target: Omit<Target, "signal">) => {
  let current: CodexPackageAvailability = notInstalled;
  const available = Deferred.makeUnsafe<VerifiedCodexPackage>();
  const gate = Semaphore.makeUnsafe(1);
  const activate = (rootPath = location.rootPath): Effect.Effect<CodexPackageAvailability> =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        if (current.status === "available") return current;
        const candidate = { ...location, rootPath: path.resolve(rootPath) };
        const result = yield* runRuntimeResolution(async (signal) => {
          if (!(await packageExists(candidate, target.platform))) return notInstalled;
          const verified = await verifyCodexPackage(candidate, { ...target, signal });
          return { status: "available", package: verified } as const;
        }).pipe(
          Effect.catch(({ cause }) =>
            Effect.logWarning("Codex package verification failed", { cause }).pipe(
              Effect.as({
                status: "unavailable",
                reason: "invalid",
                message: "Codex could not be verified.",
              } as const),
            ),
          ),
        );
        current = result;
        if (result.status === "available")
          Deferred.doneUnsafe(available, Effect.succeed(result.package));
        return result;
      }),
    );
  return {
    get current() {
      return current;
    },
    activate,
    available: Deferred.await(available),
  };
};

export type CodexPackage = ReturnType<typeof makeCodexPackage>;

export const skipsBundledCodexActivation = (target: {
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) =>
  !target.isPackaged &&
  target.environment[
    target.environment.NODE_ENV === "test" ? "NODEX_TEST_CODEX_ABSENT" : "NODEX_DEV_CODEX_ABSENT"
  ] === "1";
