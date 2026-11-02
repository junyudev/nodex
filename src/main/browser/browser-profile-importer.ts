import { hostCapabilities } from "../../shared/host-capabilities";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import fs from "node:fs";
import path from "node:path";
import type {
  BrowserCapabilityStatus,
  BrowserProfileImportDataResult,
  BrowserProfileImportInput,
  BrowserProfileImportResult,
  BrowserProfileSource,
  ImportableBrowserProfile,
} from "../../shared/browser-profile";
import type { BrowserCredentialRuntime } from "./browser-credential-service";
import type {
  BrowserProfileHelper,
  BrowserProfileHelperResponse,
} from "./browser-profile-helper-client";

interface BrowserCookie {
  readonly domain?: string;
  readonly name: string;
  readonly path?: string;
  readonly value: string;
}

interface BrowserCookieStore {
  readonly get: (filter: Record<string, never>) => Promise<BrowserCookie[]>;
  readonly set: (details: {
    readonly url: string;
    readonly name: string;
    readonly value: string;
    readonly domain?: string;
    readonly path?: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly expirationDate?: number;
    readonly sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  }) => Promise<void>;
}

export interface BrowserProfileImportRuntimeOptions {
  readonly cookieStore: BrowserCookieStore;
  readonly credentials: Pick<BrowserCredentialRuntime, "capability" | "importCredential">;
  readonly helper: BrowserProfileHelper;
  readonly homeDirectory: string;
  readonly platform: string;
  readonly sourceRoots?: Partial<Record<BrowserProfileSource, string>>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => number;
}

interface BrowserSourceDefinition {
  readonly source: BrowserProfileSource;
  readonly appName: string;
  readonly rootPath: string;
}

export class BrowserProfileImportRuntimeError extends Schema.TaggedError<BrowserProfileImportRuntimeError>()(
  "BrowserProfileImportRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserProfileImportRuntime {
  readonly capability: () => BrowserCapabilityStatus;
  readonly listProfiles: Effect.Effect<
    readonly ImportableBrowserProfile[],
    BrowserProfileImportRuntimeError
  >;
  readonly importProfile: (
    input: BrowserProfileImportInput,
  ) => Effect.Effect<BrowserProfileImportResult, BrowserProfileImportRuntimeError>;
}

const runtimeError = (operation: string, cause: unknown): BrowserProfileImportRuntimeError =>
  new BrowserProfileImportRuntimeError({ operation, cause });

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sourceDefinitions = (
  homeDirectory: string,
  sourceRoots: Partial<Record<BrowserProfileSource, string>>,
): readonly BrowserSourceDefinition[] => {
  const applicationSupport = path.join(homeDirectory, "Library", "Application Support");
  return [
    {
      source: "atlas",
      appName: "ChatGPT Atlas",
      rootPath:
        sourceRoots.atlas ??
        path.join(applicationSupport, "com.openai.atlas", "browser-data", "host"),
    },
    {
      source: "chrome",
      appName: "Google Chrome",
      rootPath: sourceRoots.chrome ?? path.join(applicationSupport, "Google", "Chrome"),
    },
  ];
};

export const makeBrowserProfileImportRuntime = (
  options: BrowserProfileImportRuntimeOptions,
): Effect.Effect<BrowserProfileImportRuntime> =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const roots = options.sourceRoots ?? {};
    const imports = yield* Semaphore.make(1);
    const capability = (): BrowserCapabilityStatus => {
      if (!hostCapabilities(options.platform).browserProfileImport) {
        return {
          available: false,
          provider: "unavailable",
          reason: "Browser Profile import is unavailable on this platform",
        };
      }
      if (!options.credentials.capability().available) {
        return {
          available: false,
          provider: "unavailable",
          reason: "Secure credential storage is unavailable on this device",
        };
      }
      return { available: true, provider: "nodex-profile-import" };
    };
    const listProfiles = Effect.try({
      try: () =>
        sourceDefinitions(options.homeDirectory, roots)
          .flatMap((definition) => discoverProfiles(definition, isProcessAlive))
          .sort((left, right) => {
            if (left.source !== right.source) return left.source === "atlas" ? -1 : 1;
            return left.profileName.localeCompare(right.profileName);
          }),
      catch: (cause) => runtimeError("discover-profiles", cause),
    });
    const importCookies = (
      helperResult: BrowserProfileHelperResponse,
    ): Effect.Effect<BrowserProfileImportDataResult, BrowserProfileImportRuntimeError> =>
      Effect.gen(function* () {
        const currentCookies = yield* Effect.tryPromise({
          try: () => options.cookieStore.get({}),
          catch: (cause) => runtimeError("read-cookies", cause),
        });
        const existing = new Map(
          currentCookies.map((cookie) => [
            cookieKey(cookie.domain ?? "", cookie.name, cookie.path ?? "/"),
            cookie.value,
          ]),
        );
        let imported = 0;
        let skippedExisting = 0;
        let skippedInvalid = 0;
        let failed = helperResult.cookieFailures;
        for (const cookie of helperResult.cookies) {
          const host = cookie.domain.replace(/^\./u, "");
          const expirationDate = cookie.expirationDate ?? undefined;
          if (
            !isSafeCookieHost(host) ||
            (expirationDate !== undefined && expirationDate <= now() / 1_000)
          ) {
            skippedInvalid += 1;
            continue;
          }
          const key = cookieKey(cookie.domain, cookie.name, cookie.path);
          if (existing.get(key) === cookie.value) {
            skippedExisting += 1;
            continue;
          }
          const saved = yield* Effect.tryPromise({
            try: () =>
              options.cookieStore.set({
                url: `${cookie.secure ? "https" : "http"}://${host}${normalizeCookiePath(cookie.path)}`,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: normalizeCookiePath(cookie.path),
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                ...(expirationDate === undefined ? {} : { expirationDate }),
                sameSite: cookie.sameSite,
              }),
            catch: (cause) => runtimeError("write-cookie", cause),
          }).pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true,
            }),
          );
          if (!saved) {
            failed += 1;
            continue;
          }
          existing.set(key, cookie.value);
          imported += 1;
        }
        return importDataResult({
          discovered: helperResult.cookies.length + helperResult.cookieFailures,
          imported,
          skippedExisting,
          skippedInvalid,
          failed,
        });
      });
    const importPasswords = (
      helperResult: BrowserProfileHelperResponse,
    ): Effect.Effect<BrowserProfileImportDataResult> =>
      Effect.gen(function* () {
        let imported = 0;
        let skippedExisting = 0;
        let skippedInvalid = 0;
        let failed = helperResult.passwordFailures;
        for (const credential of helperResult.credentials) {
          const outcome = yield* options.credentials.importCredential(credential).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Failed" as const, error }),
              onSuccess: (status) => ({ _tag: "Succeeded" as const, status }),
            }),
          );
          if (outcome._tag === "Succeeded") {
            if (outcome.status === "unchanged") skippedExisting += 1;
            else imported += 1;
            continue;
          }
          if (isInvalidCredentialFailure(outcome.error.cause)) skippedInvalid += 1;
          else failed += 1;
        }
        return importDataResult({
          discovered: helperResult.credentials.length + helperResult.passwordFailures,
          imported,
          skippedExisting,
          skippedInvalid,
          failed,
        });
      });

    return {
      capability,
      listProfiles,
      importProfile: (input) =>
        imports.withPermits(1)(
          Effect.gen(function* () {
            if (!input.importCookies && !input.importPasswords) {
              return yield* Effect.fail(
                runtimeError(
                  "validate-import",
                  new TypeError("Select cookies, passwords, or both to import"),
                ),
              );
            }
            if (!input.importCookies && input.cookieDomainAllowlist !== undefined) {
              return yield* Effect.fail(
                runtimeError(
                  "validate-import",
                  new TypeError("Cookie domain selection requires cookie import"),
                ),
              );
            }
            const profile = (yield* listProfiles).find(
              (candidate) =>
                candidate.source === input.source && candidate.profilePath === input.profilePath,
            );
            if (profile === undefined) {
              return yield* Effect.fail(
                runtimeError(
                  "validate-profile",
                  new Error("Browser Profile is no longer importable"),
                ),
              );
            }
            if (profile.sourceBrowserOpen) {
              return yield* Effect.fail(
                runtimeError(
                  "validate-profile",
                  new Error(`Close ${profile.appName} completely before importing`),
                ),
              );
            }
            if (input.importPasswords && !options.credentials.capability().available) {
              return yield* Effect.fail(
                runtimeError(
                  "validate-profile",
                  new Error("Secure credential storage is unavailable"),
                ),
              );
            }
            const helperResult = yield* options.helper
              .readProfile({
                source: input.source,
                profilePath: profile.profilePath,
                includeCookies: input.importCookies,
                includePasswords: input.importPasswords,
                cookieDomainAllowlist: input.cookieDomainAllowlist,
              })
              .pipe(Effect.mapError((cause) => runtimeError("read-profile", cause)));
            const result: BrowserProfileImportResult = {
              source: input.source,
              profilePath: profile.profilePath,
            };
            if (input.importCookies) result.cookies = yield* importCookies(helperResult);
            if (input.importPasswords) result.passwords = yield* importPasswords(helperResult);
            return result;
          }),
        ),
    } satisfies BrowserProfileImportRuntime;
  });

const discoverProfiles = (
  definition: BrowserSourceDefinition,
  isProcessAlive: (pid: number) => boolean,
): ImportableBrowserProfile[] => {
  const rootMetadata = safeLstat(definition.rootPath);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) return [];
  const rootPath = safeRealpath(definition.rootPath);
  if (!rootPath) return [];
  const profileMetadata = readProfileInfoCache(path.join(rootPath, "Local State"));
  const sourceBrowserOpen = isSourceBrowserOpen(rootPath, isProcessAlive);
  const profiles: ImportableBrowserProfile[] = [];
  for (const [directoryName, metadata] of Object.entries(profileMetadata)) {
    const profilePath = safeRealpath(path.join(rootPath, directoryName));
    if (!profilePath || !isPathInside(profilePath, rootPath)) continue;
    const profileStats = safeLstat(profilePath);
    if (!profileStats?.isDirectory() || profileStats.isSymbolicLink()) continue;
    const hasCookies = isRegularFile(path.join(profilePath, "Cookies"));
    const hasPasswords = isRegularFile(path.join(profilePath, "Login Data"));
    if (!hasCookies && !hasPasswords) continue;
    const gaiaName = readNonEmptyString(metadata.gaia_name);
    const userName = readNonEmptyString(metadata.user_name);
    profiles.push({
      source: definition.source,
      appName: definition.appName,
      profileName: readNonEmptyString(metadata.name) ?? directoryName,
      profileDirectoryName: directoryName,
      profilePath,
      rootPath,
      hasCookies,
      hasPasswords,
      sourceBrowserOpen,
      ...(gaiaName ? { gaiaName } : {}),
      ...(userName ? { userName } : {}),
    });
  }
  return profiles;
};

const readProfileInfoCache = (localStatePath: string): Record<string, Record<string, unknown>> => {
  try {
    const value = JSON.parse(fs.readFileSync(localStatePath, "utf8")) as unknown;
    if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.profile.info_cache)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value.profile.info_cache).filter(
        (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
      ),
    );
  } catch {
    return {};
  }
};

const isSourceBrowserOpen = (
  rootPath: string,
  isProcessAlive: (pid: number) => boolean,
): boolean => {
  const lockPath = path.join(rootPath, "SingletonLock");
  let target: string;
  try {
    const metadata = fs.lstatSync(lockPath);
    if (!metadata.isSymbolicLink()) return false;
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }
  const pid = Number.parseInt(/-(\d+)$/u.exec(target)?.[1] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
};

const importDataResult = (
  input: Omit<BrowserProfileImportDataResult, "status">,
): BrowserProfileImportDataResult => ({
  ...input,
  status:
    input.failed > 0
      ? input.imported > 0 || input.skippedExisting > 0
        ? "partial-success"
        : "failed"
      : "success",
});

const cookieKey = (domain: string, name: string, cookiePath: string): string =>
  `${domain.toLowerCase()}\0${name}\0${normalizeCookiePath(cookiePath)}`;

const normalizeCookiePath = (value: string): string => (value.startsWith("/") ? value : "/");

const isSafeCookieHost = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 253 &&
  !value.includes("/") &&
  !value.includes(":") &&
  !/\s/u.test(value);

const isInvalidCredentialFailure = (cause: unknown): boolean =>
  cause instanceof Error && /origin|username|password/iu.test(cause.message);

const isRegularFile = (value: string): boolean => {
  const metadata = safeLstat(value);
  return metadata?.isFile() === true && !metadata.isSymbolicLink();
};

const safeLstat = (value: string): fs.Stats | null => {
  try {
    return fs.lstatSync(value);
  } catch {
    return null;
  }
};

const safeRealpath = (value: string): string | null => {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
};

const isPathInside = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
