import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { BrowserUsePeerAuthorizationMode } from "../../../shared/browser-use-host-capability";
import type { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { makeBrowserUseNativePipeServer } from "../../browser-use/browser-use-native-pipe-server";
import { createBrowserUsePeerAuthorizer } from "../../browser-use/browser-use-peer-authorizer";
import {
  writeComputerUseRuntimeConfig,
  type ComputerUseRuntimeConfigWriteInput,
} from "../../codex/computer-use-runtime-config";
import { loadSkyNativeAddon, type SkyNativeAddon } from "../../sky-native";

const execFileAsync = promisify(execFile);
const COMPUTER_USE_APP_NAME = "Codex Computer Use.app";
const COMPUTER_USE_SERVICE_RELATIVE_PATH = path.join("Contents", "MacOS", "SkyComputerUseService");
const MATERIALIZATION_KEY_FILENAME = ".materialization-key";

export type ComputerUseServiceAddon = Pick<
  SkyNativeAddon,
  "computerUseServiceProcessMatchesExecutablePath" | "spawnComputerUseService"
>;

export interface ComputerUseAppMaterializationInput {
  readonly bundleIdentifier: string;
  readonly desktopBuild: string;
  readonly runtimeStateHome: string;
  readonly signingTeamId: string;
  readonly sourceAppPath: string;
}

export interface ComputerUseAppMaterializationResult {
  readonly appPath: string;
  readonly serviceExecutablePath: string;
}

export class ComputerUseHostPlatformError extends Data.TaggedError("ComputerUseHostPlatformError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ComputerUseHostServicesServer {
  readonly pipePath: string;
}

export interface ComputerUseHostPlatform {
  readonly createNativePipeServer: (
    handler: (
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, ComputerUseHostPlatformError>,
    peerAuthorizationMode: BrowserUsePeerAuthorizationMode,
    peerAuthorizationAddonPath: string,
  ) => Effect.Effect<ComputerUseHostServicesServer, ComputerUseHostPlatformError, Scope.Scope>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly loadAddon: Effect.Effect<ComputerUseServiceAddon | null>;
  readonly macOSRelease: string;
  readonly materializeApp: (
    input: ComputerUseAppMaterializationInput,
  ) => Effect.Effect<ComputerUseAppMaterializationResult, ComputerUseHostPlatformError>;
  readonly platform: NodeJS.Platform;
  readonly processMatchesExecutable: (
    addon: ComputerUseServiceAddon,
    pid: number,
    executablePath: string,
  ) => boolean;
  readonly spawnService: (
    addon: ComputerUseServiceAddon,
    executablePath: string,
  ) => Effect.Effect<number | null, ComputerUseHostPlatformError>;
  readonly terminateProcess: (pid: number) => Effect.Effect<void, ComputerUseHostPlatformError>;
  readonly writeRuntimeConfig: (
    input: ComputerUseRuntimeConfigWriteInput,
  ) => Effect.Effect<string, ComputerUseHostPlatformError>;
}

type ComputerUseAppVerifier = (input: {
  readonly appPath: string;
  readonly bundleIdentifier: string;
  readonly serviceExecutablePath: string;
  readonly signingTeamId: string;
}) => Effect.Effect<void, ComputerUseHostPlatformError>;

export interface ComputerUseAppMaterializerOptions extends ComputerUseAppMaterializationInput {
  readonly copyApp?: (
    sourcePath: string,
    targetPath: string,
  ) => Effect.Effect<void, ComputerUseHostPlatformError>;
  readonly verifyApp?: ComputerUseAppVerifier;
}

const platformError = (operation: string, cause: unknown): ComputerUseHostPlatformError =>
  new ComputerUseHostPlatformError({ operation, cause });

export function canonicalComputerUseExecutablePath(executablePath: string): string {
  try {
    return realpathSync.native(executablePath);
  } catch {
    return path.resolve(executablePath);
  }
}

function defaultCopyApp(
  sourcePath: string,
  targetPath: string,
): Effect.Effect<void, ComputerUseHostPlatformError> {
  return Effect.tryPromise({
    try: () => execFileAsync("/usr/bin/ditto", ["--noqtn", sourcePath, targetPath]),
    catch: (cause) => platformError("helper.copy", cause),
  }).pipe(Effect.asVoid);
}

function readBundleIdentifier(
  appPath: string,
): Effect.Effect<string, ComputerUseHostPlatformError> {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  return Effect.tryPromise({
    try: () =>
      execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist]),
    catch: (cause) => platformError("helper.bundle-identifier", cause),
  }).pipe(Effect.map(({ stdout }) => stdout.trim()));
}

function readSigningTeamId(
  codePath: string,
): Effect.Effect<string | null, ComputerUseHostPlatformError> {
  return Effect.tryPromise({
    try: () => execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", codePath]),
    catch: (cause) => platformError("helper.signing-team", cause),
  }).pipe(
    Effect.map(
      ({ stderr, stdout }) =>
        /^TeamIdentifier=(.+)$/mu.exec(`${stdout}\n${stderr}`)?.[1]?.trim() ?? null,
    ),
  );
}

function defaultVerifyApp(input: {
  readonly appPath: string;
  readonly bundleIdentifier: string;
  readonly serviceExecutablePath: string;
  readonly signingTeamId: string;
}): Effect.Effect<void, ComputerUseHostPlatformError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", input.appPath]),
      catch: (cause) => platformError("helper.codesign", cause),
    });
    if ((yield* readBundleIdentifier(input.appPath)) !== input.bundleIdentifier) {
      return yield* platformError(
        "helper.verify",
        new Error("Computer Use helper bundle identifier is invalid"),
      );
    }
    if ((yield* readSigningTeamId(input.serviceExecutablePath)) !== input.signingTeamId) {
      return yield* platformError(
        "helper.verify",
        new Error("Computer Use helper signing team is invalid"),
      );
    }
    const stats = yield* Effect.tryPromise({
      try: () => fs.lstat(input.serviceExecutablePath),
      catch: (cause) => platformError("helper.stat", cause),
    });
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
      return yield* platformError(
        "helper.verify",
        new Error("Computer Use service executable is invalid"),
      );
    }
  });
}

const rename = (
  sourcePath: string,
  targetPath: string,
): Effect.Effect<void, ComputerUseHostPlatformError> =>
  Effect.tryPromise({
    try: () => fs.rename(sourcePath, targetPath),
    catch: (cause) => platformError("helper.rename", cause),
  });

const remove = (targetPath: string): Effect.Effect<void, ComputerUseHostPlatformError> =>
  Effect.tryPromise({
    try: () => fs.rm(targetPath, { force: true, recursive: true }),
    catch: (cause) => platformError("helper.remove", cause),
  });

function moveDirectoryIntoPlace(
  stagingPath: string,
  targetPath: string,
): Effect.Effect<string | null, ComputerUseHostPlatformError> {
  return Effect.gen(function* () {
    const previousPath = `${targetPath}.previous-${randomUUID()}`;
    let movedPrevious = false;
    yield* rename(targetPath, previousPath).pipe(
      Effect.tap(() => Effect.sync(() => void (movedPrevious = true))),
      Effect.catch((error) =>
        (error.cause as NodeJS.ErrnoException).code === "ENOENT" ? Effect.void : Effect.fail(error),
      ),
    );
    yield* rename(stagingPath, targetPath).pipe(
      Effect.catch((error) =>
        movedPrevious
          ? rename(previousPath, targetPath).pipe(Effect.andThen(Effect.fail(error)))
          : Effect.fail(error),
      ),
    );
    return movedPrevious ? previousPath : null;
  });
}

/** Materializes one verified helper build; all lifecycle and admission stay in the host runtime. */
export class ComputerUseAppMaterializer {
  readonly #copyApp: (
    sourcePath: string,
    targetPath: string,
  ) => Effect.Effect<void, ComputerUseHostPlatformError>;
  readonly #options: ComputerUseAppMaterializerOptions;
  readonly #verifyApp: ComputerUseAppVerifier;

  constructor(options: ComputerUseAppMaterializerOptions) {
    this.#options = options;
    this.#copyApp = options.copyApp ?? defaultCopyApp;
    this.#verifyApp = options.verifyApp ?? defaultVerifyApp;
  }

  materialize(): Effect.Effect<ComputerUseAppMaterializationResult, ComputerUseHostPlatformError> {
    const copyApp = this.#copyApp;
    const options = this.#options;
    const verifyApp = this.#verifyApp;
    return Effect.gen(function* () {
      const parentPath = path.join(path.resolve(options.runtimeStateHome), "computer-use");
      const appPath = path.join(parentPath, COMPUTER_USE_APP_NAME);
      const serviceExecutablePath = path.join(appPath, COMPUTER_USE_SERVICE_RELATIVE_PATH);
      const key = createHash("sha256")
        .update(options.bundleIdentifier)
        .update("\0")
        .update(options.desktopBuild)
        .update("\0")
        .update(options.signingTeamId)
        .digest("hex");
      const keyPath = path.join(parentPath, MATERIALIZATION_KEY_FILENAME);
      const existingKey = yield* Effect.exit(
        Effect.tryPromise({
          try: () => fs.readFile(keyPath, "utf8"),
          catch: (cause) => platformError("helper.read-key", cause),
        }),
      );
      if (Exit.isSuccess(existingKey) && existingKey.value.trim() === key) {
        const verified = yield* Effect.exit(
          verifyApp({
            appPath,
            bundleIdentifier: options.bundleIdentifier,
            serviceExecutablePath,
            signingTeamId: options.signingTeamId,
          }),
        );
        if (Exit.isSuccess(verified)) return { appPath, serviceExecutablePath };
      }

      yield* Effect.tryPromise({
        try: () => fs.mkdir(parentPath, { recursive: true }),
        catch: (cause) => platformError("helper.mkdir", cause),
      });
      const stagingPath = path.join(parentPath, `.staging-${randomUUID()}.app`);
      return yield* Effect.gen(function* () {
        yield* copyApp(options.sourceAppPath, stagingPath);
        const stagingServicePath = path.join(stagingPath, COMPUTER_USE_SERVICE_RELATIVE_PATH);
        yield* verifyApp({
          appPath: stagingPath,
          bundleIdentifier: options.bundleIdentifier,
          serviceExecutablePath: stagingServicePath,
          signingTeamId: options.signingTeamId,
        });
        const previousPath = yield* moveDirectoryIntoPlace(stagingPath, appPath);
        yield* Effect.gen(function* () {
          yield* verifyApp({
            appPath,
            bundleIdentifier: options.bundleIdentifier,
            serviceExecutablePath,
            signingTeamId: options.signingTeamId,
          });
          yield* Effect.tryPromise({
            try: () => fs.writeFile(keyPath, `${key}\n`, "utf8"),
            catch: (cause) => platformError("helper.write-key", cause),
          });
          if (previousPath) yield* remove(previousPath);
        }).pipe(
          Effect.catch((error) =>
            remove(appPath).pipe(
              Effect.andThen(previousPath ? rename(previousPath, appPath) : Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        return { appPath, serviceExecutablePath };
      }).pipe(Effect.tapError(() => remove(stagingPath).pipe(Effect.ignore)));
    });
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const processState = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (processState.status !== 0 || processState.error) return false;
  return !processState.stdout.trimStart().startsWith("Z");
}

export interface ComputerUseHostPlatformOptions {
  readonly loadAddon?: (
    verifiedAddonPath: string,
    verifiedExports: readonly string[],
  ) => SkyNativeAddon | null;
  readonly macOSRelease?: string;
  readonly platform: NodeJS.Platform;
  readonly verifiedSkyNativeAddonPath: string | null;
  readonly verifiedSkyNativeExports?: readonly string[] | null;
}

export function makeComputerUseHostPlatform(
  options: ComputerUseHostPlatformOptions,
  callbacks: ScopedCallbackRuntime["Service"],
): ComputerUseHostPlatform {
  return {
    createNativePipeServer: (handler, peerAuthorizationMode, peerAuthorizationAddonPath) =>
      makeBrowserUseNativePipeServer({
        handler: (request) => callbacks.runPromise(handler(request.method, request.params)),
        nativePipeDirectory: path.join("/tmp", "nodex-host-services"),
        platform: options.platform,
        socketPeerAuthorizer: createBrowserUsePeerAuthorizer({
          addonPath: peerAuthorizationAddonPath,
          mode: peerAuthorizationMode,
        }),
      }).pipe(Effect.mapError((cause) => platformError("native-pipe.acquire", cause))),
    isProcessAlive: isLiveProcess,
    loadAddon: Effect.sync(() => {
      if (!options.verifiedSkyNativeAddonPath || !options.verifiedSkyNativeExports) return null;
      return (options.loadAddon ?? loadSkyNativeAddon)(
        options.verifiedSkyNativeAddonPath,
        options.verifiedSkyNativeExports,
      );
    }),
    macOSRelease: options.macOSRelease ?? process.getSystemVersion?.() ?? "0",
    materializeApp: (input) => new ComputerUseAppMaterializer(input).materialize(),
    platform: options.platform,
    processMatchesExecutable: (addon, pid, executablePath) => {
      try {
        return addon.computerUseServiceProcessMatchesExecutablePath(pid, executablePath);
      } catch {
        return false;
      }
    },
    spawnService: (addon, executablePath) =>
      Effect.tryPromise({
        try: () => addon.spawnComputerUseService(executablePath),
        catch: (cause) => platformError("service.spawn", cause),
      }),
    terminateProcess: (pid) =>
      Effect.try({
        try: () => process.kill(pid, "SIGTERM"),
        catch: (cause) => platformError("service.terminate", cause),
      }).pipe(Effect.asVoid),
    writeRuntimeConfig: (input) =>
      Effect.tryPromise({
        try: () => writeComputerUseRuntimeConfig(input),
        catch: (cause) => platformError("config.write", cause),
      }),
  };
}
