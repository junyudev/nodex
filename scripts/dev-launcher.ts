import {
  resolveDevelopmentRendererPort,
  requireDevelopmentRendererPort,
} from "./development-renderer-origin";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  developmentFeatureEnvironment,
  NODEX_DEVELOPMENT_FEATURES_ENV,
  resolveDevelopmentFeatureOverrides,
  type DevelopmentFeatureSlug,
} from "../src/shared/development-features";
import {
  NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE_ENV,
  NODEX_CORE_EXECUTABLE_ENV,
} from "../src/shared/native-runtime-environment";
import { runProcessMain } from "../src/main/app/EffectProcessEntry";
import {
  cleanupDevelopmentEnvironmentHome,
  ensureDevelopmentProfileDirectories,
  markDevelopmentEnvironmentInitialized,
  openDevelopmentEnvironmentHome,
  refreshDevelopmentEnvironmentHome,
  updateDevelopmentAgentFiles,
  type DevelopmentEnvironmentHome,
  type DevelopmentHomeManifest,
  type DevelopmentProfileSnapshotProvenance,
  type DevelopmentSeedProvenance,
} from "./development-environment-home";
import { superviseIsolatedRun, type SupervisedCommandPlan } from "./isolated-run-supervisor";
import type { IsolatedRunFailure } from "./isolated-run/IsolatedRun";
import { getScenario } from "./scenarios/registry";
import { materializeDevelopmentSeed } from "./scenarios/harness/development-seed";

export interface DevLauncherArguments {
  readonly home?: string;
  readonly seed?: string;
  readonly fromProfile?: string;
  readonly backup: string;
  readonly build: boolean;
  readonly authJson?: string;
  readonly agentConfigToml?: string;
  readonly remoteDebuggingPort?: string;
  readonly rendererPort?: string;
  readonly enabledFeatures: readonly string[];
  readonly deleteHome: boolean;
  readonly help: boolean;
}

export interface DevLaunchPlan {
  readonly preparation: readonly SupervisedCommandPlan[];
  readonly application: SupervisedCommandPlan;
  readonly environment: NodeJS.ProcessEnv;
  readonly enabledFeatures: readonly DevelopmentFeatureSlug[];
  readonly mode: "hmr" | "built";
}

export class DevLauncherError extends Data.TaggedError("DevLauncherError")<{
  readonly cause: unknown;
}> {}

const devLauncherError = (cause: unknown): DevLauncherError => new DevLauncherError({ cause });

const USAGE = `Usage: pnpm run dev [options]

Options:
  --home <dir>               Environment root (default: runs.local/default)
  --seed <seed-id>           Initialize a new environment from the seed catalog
  --from-profile <dir>       Clone a published backup from a real Profile
  --backup <id|latest>       Backup to clone (default: latest assets-inclusive backup)
  --renderer-port <port>     Explicitly choose and persist this home’s renderer cache origin
  --build                    Build optimized Rust binaries and run without HMR
  --auth-json <file>         Copy an auth.json into the environment
  --agent-config-toml <file> Copy a sanitized agent config.toml
  --remote-debugging-port <port>, --cdp <port>
                             Expose DevTools on port 0-65535 (default: 0)
  --enable <feature-slug>    Enable a development feature for this invocation
  --delete                   Delete the environment after a proven clean stop
  --help                     Show this help
`;

const readOptionValue = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseRemoteDebuggingPort = (value: string, option: string): string => {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${option} must be an integer from 0 to 65535`);
  }
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${option} must be an integer from 0 to 65535`);
  }
  return String(port);
};

export const parseDevLauncherArguments = (args: readonly string[]): DevLauncherArguments => {
  let home: string | undefined;
  let seed: string | undefined;
  let fromProfile: string | undefined;
  let backup = "latest";
  let backupWasSet = false;
  let authJson: string | undefined;
  let agentConfigToml: string | undefined;
  let remoteDebuggingPort: string | undefined;
  let build = false;
  let deleteHome = false;
  let help = false;
  let rendererPort: string | undefined;
  const enabledFeatures: string[] = [];
  const setOnce = (option: string, current: string | undefined, value: string): string => {
    if (current !== undefined) throw new Error(`${option} may be specified only once`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--build") {
      build = true;
      continue;
    }
    if (argument === "--delete") {
      deleteHome = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--renderer-port") {
      rendererPort = setOnce(
        argument,
        rendererPort,
        String(requireDevelopmentRendererPort(readOptionValue(args, index, argument))),
      );
      index += 1;
      continue;
    }
    if (argument === "--home") {
      const value = readOptionValue(args, index, argument);
      home = setOnce(argument, home, value);
      index += 1;
      continue;
    }
    if (argument === "--seed") {
      const value = readOptionValue(args, index, argument);
      seed = setOnce(argument, seed, value);
      index += 1;
      continue;
    }
    if (argument === "--from-profile") {
      const value = readOptionValue(args, index, argument);
      fromProfile = setOnce(argument, fromProfile, value);
      index += 1;
      continue;
    }
    if (argument === "--backup") {
      if (backupWasSet) throw new Error("--backup may be specified only once");
      backup = readOptionValue(args, index, argument);
      backupWasSet = true;
      index += 1;
      continue;
    }
    if (argument === "--auth-json") {
      const value = readOptionValue(args, index, argument);
      authJson = setOnce(argument, authJson, value);
      index += 1;
      continue;
    }
    if (argument === "--agent-config-toml") {
      const value = readOptionValue(args, index, argument);
      agentConfigToml = setOnce(argument, agentConfigToml, value);
      index += 1;
      continue;
    }
    if (argument === "--remote-debugging-port" || argument === "--cdp") {
      const value = parseRemoteDebuggingPort(readOptionValue(args, index, argument), argument);
      remoteDebuggingPort = setOnce("--remote-debugging-port/--cdp", remoteDebuggingPort, value);
      index += 1;
      continue;
    }
    if (argument === "--enable") {
      enabledFeatures.push(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown dev option: ${argument ?? "<missing>"}\n${USAGE}`);
  }
  if (seed && fromProfile) {
    throw new Error("--seed and --from-profile are mutually exclusive");
  }
  if (backupWasSet && !fromProfile) {
    throw new Error("--backup requires --from-profile");
  }
  return {
    ...(home === undefined ? {} : { home }),
    ...(seed === undefined ? {} : { seed }),
    ...(fromProfile === undefined ? {} : { fromProfile }),
    backup,
    build,
    ...(authJson === undefined ? {} : { authJson }),
    ...(agentConfigToml === undefined ? {} : { agentConfigToml }),
    ...(remoteDebuggingPort === undefined ? {} : { remoteDebuggingPort }),
    ...(rendererPort === undefined ? {} : { rendererPort }),
    enabledFeatures,
    deleteHome,
    help,
  };
};

const pnpmScript = (script: string): SupervisedCommandPlan => ({
  command: "pnpm",
  args: ["--silent", "run", script],
});

export const createDevLaunchPlan = (input: {
  readonly arguments: DevLauncherArguments;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: DevelopmentEnvironmentHome;
}): DevLaunchPlan => {
  const enabledFeatures = resolveDevelopmentFeatureOverrides(input.arguments.enabledFeatures);
  const remoteDebuggingPort =
    input.arguments.remoteDebuggingPort ??
    parseRemoteDebuggingPort(
      input.environment.NODEX_REMOTE_DEBUGGING_PORT?.trim() || "0",
      "NODEX_REMOTE_DEBUGGING_PORT",
    );
  const usesProfileSnapshot =
    input.arguments.fromProfile !== undefined || input.home.manifest.profileSnapshot !== undefined;
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    ...developmentFeatureEnvironment(enabledFeatures),
    ...(input.arguments.build
      ? {
          [NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE_ENV]: path.join(
            input.home.repositoryRealpath,
            "target/release/nodex-browser-profile-helper",
          ),
          [NODEX_CORE_EXECUTABLE_ENV]: path.join(
            input.home.repositoryRealpath,
            "target/release/nodex-core",
          ),
        }
      : {}),
    NODEX_HOME: input.home.nodexHome,
    CODEX_HOME: input.home.codexHome,
    NODEX_INITIAL_PROJECTS_DIR: input.home.workspace,
    NODEX_REMOTE_DEBUGGING_PORT: remoteDebuggingPort,
    NODEX_SENTRY_ENABLED: usesProfileSnapshot ? "false" : "true",
    ...(usesProfileSnapshot
      ? {
          NODEX_SENTRY_REPLAY_ENABLED: "false",
          NODEX_SENTRY_REPLAYS_SESSION_SAMPLE_RATE: "0",
          NODEX_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: "0",
          NODEX_TELEMETRY_ENABLED: "false",
          NODEX_TELEMETRY_AUTOCAPTURE_ENABLED: "false",
        }
      : {}),
    SENTRY_ENVIRONMENT: "development",
    SENTRY_RELEASE: "nodex-dev",
  };
  if (enabledFeatures.length === 0) {
    delete environment[NODEX_DEVELOPMENT_FEATURES_ENV];
  }
  if (input.arguments.build) {
    return {
      preparation: [
        pnpmScript("core:binaries:build:release"),
        pnpmScript("build"),
        pnpmScript("stage:codex-runtime:mac:cached"),
      ],
      application: {
        command: "pnpm",
        args: ["exec", "electron", ".", `--remote-debugging-port=${remoteDebuggingPort}`],
      },
      environment,
      enabledFeatures,
      mode: "built",
    };
  }
  return {
    preparation: [
      pnpmScript("build-resources:prepare"),
      pnpmScript("core:build:dev"),
      pnpmScript("stage:codex-runtime:mac:cached"),
      pnpmScript("sync:icons"),
    ],
    application: {
      command: "pnpm",
      args: [
        "exec",
        "electron-vite",
        "dev",
        "--logLevel",
        "warn",
        "--remoteDebuggingPort",
        remoteDebuggingPort,
      ],
    },
    environment,
    enabledFeatures,
    mode: "hmr",
  };
};

const runCommand = (
  command: SupervisedCommandPlan,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<void, DevLauncherError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(command.command, [...command.args], {
              cwd: repositoryRoot,
              env: environment,
              shell: false,
              stdio: "inherit",
            }),
          catch: devLauncherError,
        }),
        (child) =>
          Effect.sync(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          }),
      );
      const exitCode = yield* Effect.callback<number, DevLauncherError>((resume) => {
        const onError = (error: Error) => resume(Effect.fail(devLauncherError(error)));
        const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
          signal === null
            ? resume(Effect.succeed(code ?? 1))
            : resume(
                Effect.fail(devLauncherError(new Error(`${command.command} stopped by ${signal}`))),
              );
        child.once("error", onError);
        child.once("close", onClose);
        return Effect.sync(() => {
          child.off("error", onError);
          child.off("close", onClose);
        });
      });
      if (exitCode !== 0) {
        return yield* Effect.fail(
          devLauncherError(
            new Error(`${command.command} ${command.args.join(" ")} exited with ${exitCode}`),
          ),
        );
      }
    }),
  );

const attemptPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, DevLauncherError> =>
  Effect.tryPromise({ try: operation, catch: devLauncherError });

export type DevelopmentSeedInitialization =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly seed: DevelopmentSeedProvenance }
  | { readonly kind: "reuse"; readonly seed: DevelopmentSeedProvenance };

export const resolveDevelopmentSeedInitialization = (input: {
  readonly manifest: DevelopmentHomeManifest;
  readonly requestedSeed?: DevelopmentSeedProvenance;
}): DevelopmentSeedInitialization => {
  if (!input.requestedSeed) return { kind: "none" };
  const existing = input.manifest.seed;
  if (existing) {
    if (
      existing.id !== input.requestedSeed.id ||
      existing.revision !== input.requestedSeed.revision
    ) {
      throw new Error(
        `Development home was initialized with ${existing.id}@${existing.revision}; refusing ${input.requestedSeed.id}@${input.requestedSeed.revision}`,
      );
    }
    return { kind: "reuse", seed: existing };
  }
  if (input.manifest.initializedAt) {
    throw new Error("Development home was already initialized without a seed");
  }
  return { kind: "apply", seed: input.requestedSeed };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readProfileSnapshotReceipt = async (
  nodexHome: string,
  sourceProfileHome: string,
): Promise<DevelopmentProfileSnapshotProvenance> => {
  const value: unknown = JSON.parse(
    await readFile(path.join(nodexHome, "profile-snapshot.json"), "utf8"),
  );
  if (
    !isRecord(value) ||
    value.version !== 4 ||
    typeof value.sourceProfileFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sourceProfileFingerprint) ||
    value.backupIntegrityEvidenceVersion !== 1 ||
    typeof value.missingManagedAssetCount !== "number" ||
    !Number.isInteger(value.missingManagedAssetCount) ||
    value.missingManagedAssetCount < 0 ||
    typeof value.backupId !== "string" ||
    typeof value.backupCreatedAt !== "string" ||
    typeof value.clonedAt !== "string" ||
    typeof value.storeSchemaVersion !== "number" ||
    !Number.isInteger(value.storeSchemaVersion) ||
    typeof value.sourceStoreEpoch !== "string" ||
    value.sourceStoreEpoch.length === 0 ||
    typeof value.storeEpoch !== "string" ||
    value.storeEpoch !== value.sourceStoreEpoch ||
    typeof value.profileId !== "string" ||
    typeof value.libraryId !== "string"
  ) {
    throw new Error("Profile clone receipt is invalid or unsupported");
  }
  return {
    sourceProfileHome,
    sourceProfileFingerprint: value.sourceProfileFingerprint,
    backupIntegrityEvidenceVersion: value.backupIntegrityEvidenceVersion,
    missingManagedAssetCount: value.missingManagedAssetCount,
    backupId: value.backupId,
    backupCreatedAt: value.backupCreatedAt,
    clonedAt: value.clonedAt,
    storeSchemaVersion: value.storeSchemaVersion,
    sourceStoreEpoch: value.sourceStoreEpoch,
    storeEpoch: value.storeEpoch,
    profileId: value.profileId,
    libraryId: value.libraryId,
  };
};

const prepareProfileSnapshot = (input: {
  readonly arguments: DevLauncherArguments;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: DevelopmentEnvironmentHome;
}): Effect.Effect<void, DevLauncherError> =>
  Effect.gen(function* () {
    if (!input.arguments.fromProfile) return;
    const sourceProfileHome = yield* attemptPromise(() =>
      realpath(path.resolve(input.arguments.fromProfile!)),
    );
    const sourceProfileFingerprint = createHash("sha256").update(sourceProfileHome).digest("hex");
    const current = yield* attemptPromise(() => refreshDevelopmentEnvironmentHome(input.home));
    const existing = current.manifest.profileSnapshot;
    if (existing) {
      const sameBackup =
        input.arguments.backup === "latest" || existing.backupId === input.arguments.backup;
      if (existing.sourceProfileHome !== sourceProfileHome || !sameBackup) {
        return yield* Effect.fail(
          devLauncherError(
            new Error(
              `Development home already contains backup ${existing.backupId} from ${existing.sourceProfileHome}`,
            ),
          ),
        );
      }
      yield* attemptPromise(() => ensureDevelopmentProfileDirectories(current));
      yield* Effect.sync(() =>
        process.stdout.write(`Reusing Profile snapshot ${existing.backupId} in ${current.root}\n`),
      );
      return;
    }
    if (current.manifest.initializedAt) {
      return yield* Effect.fail(
        devLauncherError(
          new Error("Development home was already initialized without a Profile snapshot"),
        ),
      );
    }

    const publishedResult = yield* Effect.result(
      attemptPromise(() => readProfileSnapshotReceipt(current.nodexHome, sourceProfileHome)),
    );
    if (Result.isSuccess(publishedResult)) {
      const published = publishedResult.success;
      const sameBackup =
        input.arguments.backup === "latest" || published.backupId === input.arguments.backup;
      if (published.sourceProfileFingerprint !== sourceProfileFingerprint || !sameBackup) {
        return yield* Effect.fail(
          devLauncherError(
            new Error("Existing Profile snapshot does not match the requested source backup"),
          ),
        );
      }
      yield* attemptPromise(() => ensureDevelopmentProfileDirectories(current));
      yield* attemptPromise(() =>
        markDevelopmentEnvironmentInitialized(current, {
          kind: "profileSnapshot",
          profileSnapshot: published,
        }),
      );
      yield* Effect.sync(() =>
        process.stdout.write(`Adopted Profile snapshot ${published.backupId} in ${current.root}\n`),
      );
      return;
    }
    const receiptError = publishedResult.failure.cause;
    if (
      !(receiptError instanceof Error && "code" in receiptError && receiptError.code === "ENOENT")
    ) {
      return yield* Effect.fail(publishedResult.failure);
    }

    const executable = path.join(
      current.repositoryRealpath,
      input.arguments.build ? "target/release/nodex" : "target/debug/nodex",
    );
    yield* runCommand(
      {
        command: executable,
        args: [
          "--json",
          "profile",
          "clone",
          "--from",
          sourceProfileHome,
          "--to",
          current.nodexHome,
          "--backup",
          input.arguments.backup,
        ],
      },
      current.repositoryRealpath,
      input.environment,
    );
    const profileSnapshot = yield* attemptPromise(() =>
      readProfileSnapshotReceipt(current.nodexHome, sourceProfileHome),
    );
    yield* attemptPromise(() => ensureDevelopmentProfileDirectories(current));
    yield* attemptPromise(() =>
      markDevelopmentEnvironmentInitialized(current, {
        kind: "profileSnapshot",
        profileSnapshot,
      }),
    );
    if (profileSnapshot.missingManagedAssetCount > 0) {
      yield* Effect.sync(() =>
        process.stderr.write(
          `Profile snapshot preserved ${profileSnapshot.missingManagedAssetCount} missing managed asset reference(s) from the source backup.\n`,
        ),
      );
    }
    yield* Effect.sync(() =>
      process.stdout.write(
        `Initialized ${current.root} from Profile backup ${profileSnapshot.backupId}\n`,
      ),
    );
  });

const prepareEnvironment = async (input: {
  readonly arguments: DevLauncherArguments;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: DevelopmentEnvironmentHome;
  readonly seedRevision?: number;
}): Promise<void> => {
  const current = await refreshDevelopmentEnvironmentHome(input.home);
  if (input.arguments.fromProfile) {
    if (!current.manifest.profileSnapshot) {
      throw new Error("Development Profile snapshot was not materialized");
    }
    await updateDevelopmentAgentFiles(current, {
      authJson: input.arguments.authJson,
      agentConfigToml: input.arguments.agentConfigToml,
    });
    return;
  }
  const requestedSeed = input.arguments.seed
    ? { id: input.arguments.seed, revision: input.seedRevision ?? -1 }
    : undefined;
  const seedInitialization = resolveDevelopmentSeedInitialization({
    manifest: current.manifest,
    requestedSeed,
  });
  await updateDevelopmentAgentFiles(current, {
    authJson: input.arguments.authJson,
    agentConfigToml: input.arguments.agentConfigToml,
  });
  if (seedInitialization.kind === "none") {
    if (!current.manifest.initializedAt) {
      await markDevelopmentEnvironmentInitialized(current);
    }
    return;
  }
  if (seedInitialization.kind === "reuse") {
    process.stdout.write(
      `Reusing seed ${seedInitialization.seed.id}@${seedInitialization.seed.revision} in ${current.root}\n`,
    );
    return;
  }
  const manifest = await materializeDevelopmentSeed({
    environment: input.environment,
    scenarioId: seedInitialization.seed.id,
    nodexHome: current.nodexHome,
    workspace: current.workspace,
  });
  if (manifest.scenarioRevision !== seedInitialization.seed.revision) {
    throw new Error(
      `Seed revision changed during initialization: expected ${seedInitialization.seed.revision}, received ${manifest.scenarioRevision}`,
    );
  }
  await markDevelopmentEnvironmentInitialized(current, {
    kind: "seed",
    seed: seedInitialization.seed,
  });
  process.stdout.write(
    `Initialized ${current.root} with seed ${seedInitialization.seed.id}@${seedInitialization.seed.revision}\n`,
  );
};

export const runDevLauncher = (input: {
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
}): Effect.Effect<number, DevLauncherError | IsolatedRunFailure> =>
  Effect.gen(function* () {
    const arguments_ = yield* Effect.try({
      try: () => parseDevLauncherArguments(input.args),
      catch: devLauncherError,
    });
    if (arguments_.help) {
      yield* Effect.sync(() => process.stdout.write(USAGE));
      return 0;
    }
    const environment = { ...(input.environment ?? process.env) };
    const recipe = yield* Effect.try({
      try: () => (arguments_.seed ? getScenario(arguments_.seed) : null),
      catch: devLauncherError,
    });
    const home = yield* attemptPromise(() =>
      openDevelopmentEnvironmentHome({
        repositoryRoot: input.repositoryRoot,
        home: arguments_.home,
        initializeProfileHome: arguments_.fromProfile === undefined,
      }),
    );
    if (!arguments_.build) {
      const port = yield* attemptPromise(() =>
        resolveDevelopmentRendererPort({
          root: home.root,
          nodexHome: home.nodexHome,
          requestedPort: arguments_.rendererPort,
        }),
      );
      environment.NODEX_DEV_RENDERER_PORT = String(port);
    }
    const planResult = yield* Effect.result(
      Effect.try({
        try: () => createDevLaunchPlan({ arguments: arguments_, environment, home }),
        catch: devLauncherError,
      }),
    );
    if (Result.isFailure(planResult)) {
      if (home.wasCreated) {
        yield* attemptPromise(() => cleanupDevelopmentEnvironmentHome(home));
      }
      return yield* Effect.fail(planResult.failure);
    }
    const plan = planResult.success;
    yield* Effect.sync(() =>
      process.stdout.write(`Nodex ${plan.mode} environment: ${home.root}\n`),
    );
    if (plan.enabledFeatures.length > 0) {
      yield* Effect.sync(() =>
        process.stdout.write(`Enabled features: ${plan.enabledFeatures.join(", ")}\n`),
      );
    }

    const preparation = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.forEach(
          plan.preparation,
          (command) => runCommand(command, home.repositoryRealpath, plan.environment),
          { discard: true },
        );
        yield* prepareProfileSnapshot({
          arguments: arguments_,
          environment: plan.environment,
          home,
        });
      }),
    );
    if (Result.isFailure(preparation)) {
      if (home.wasCreated) {
        yield* attemptPromise(() => cleanupDevelopmentEnvironmentHome(home));
      }
      return yield* Effect.fail(preparation.failure);
    }

    let environmentPreparationFailed = false;
    const result = yield* superviseIsolatedRun({
      command: plan.application,
      environment: plan.environment,
      nodexHome: home.nodexHome,
      repositoryRoot: home.repositoryRealpath,
      prepare: async () => {
        try {
          await prepareEnvironment({
            arguments: arguments_,
            environment: plan.environment,
            home,
            seedRevision: recipe?.revision,
          });
        } catch (error) {
          environmentPreparationFailed = true;
          throw error;
        }
      },
    });

    const shouldDelete = arguments_.deleteHome || (home.wasCreated && environmentPreparationFailed);
    if (shouldDelete) {
      if (!result.safeToDeleteRunRoot) {
        yield* Effect.sync(() =>
          process.stderr.write(
            `Preserved unsafe development home ${home.root}; clean shutdown was not proven.\n`,
          ),
        );
        return result.childExitCode === 0 ? 1 : result.childExitCode;
      }
      const cleanup = yield* attemptPromise(() => cleanupDevelopmentEnvironmentHome(home));
      if (cleanup.status === "unsafe") {
        yield* Effect.sync(() =>
          process.stderr.write(
            `Preserved unsafe development home ${home.root}: ${cleanup.reason}\n`,
          ),
        );
        return result.childExitCode === 0 ? 1 : result.childExitCode;
      }
      yield* Effect.sync(() => process.stdout.write(`Deleted development home ${home.root}\n`));
    }
    return result.childExitCode;
  });

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
  runProcessMain(
    runDevLauncher({
      args: process.argv.slice(2),
      repositoryRoot,
    }).pipe(
      Effect.tap((exitCode) => Effect.sync(() => (process.exitCode = exitCode))),
      Effect.catch((error) =>
        Effect.sync(() => {
          const cause = error.cause;
          process.stderr.write(
            `Error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = 1;
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}
