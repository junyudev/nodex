import { symlink } from "node:fs/promises";
import * as McpProviderSessions from "@nodex/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
} from "@nodex/runtime-contracts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import { resolveSelfInvocation } from "@nodex/runtime-shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@nodex/runtime-shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import * as ProviderHost from "@nodex/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { brokenRuntimeError } from "../providerCompatibility.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityModelOptions,
  antigravitySessionMode,
  antigravityThinkingConfig,
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@nodex/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@nodex/provider-core/server/snapshotProbe";
import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@nodex/provider-core/server/ProviderContinuationRequests";
import {
  makeAntigravityAdapterV2,
  type AntigravityAdapterV2RuntimeInput,
} from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@nodex/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../AntigravityProvider.ts";
import { readAntigravityUsage } from "../antigravityUsageLimits.ts";
import { readAntigravityStoredSignIn } from "../antigravityStoredSignIn.ts";
import * as ProviderEventLoggers from "@nodex/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@nodex/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@nodex/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@nodex/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@nodex/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isAcpErrorDetails = Schema.is(Schema.Struct({ details: Schema.String }));
const REFRESH_FAILED =
  "Could not refresh Antigravity models. The previous model list is unchanged.";
const PYTHON_SOCKS_REQUIRED = "python-socks is required to use a SOCKS proxy";

// Keep provider diagnostics in cause; only recognized, fixed text reaches clients.
function refreshFailureDetail(cause: unknown) {
  return isAcpRequestError(cause) &&
    cause.operation === "receive-response" &&
    isAcpErrorDetails(cause.data) &&
    cause.data.details.includes(PYTHON_SOCKS_REQUIRED)
    ? `${REFRESH_FAILED} Antigravity reported: ${PYTHON_SOCKS_REQUIRED}`
    : REFRESH_FAILED;
}

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Antigravity",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const digest = yield* Crypto.Crypto;
    const random = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const selfInvocation = yield* resolveSelfInvocation();
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      apiKey: settings.apiKey,
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const platform = yield* HostProcess.Platform;
    const userHome = resolveAntigravityUserHome(
      platform,
      processEnvironment,
      yield* HostProcess.HomeDirectory,
    );
    const directories = yield* resolveAntigravityInstanceDirectories(
      host.paths.stateDir,
      instanceId,
      { authMethod: auth.authMethod, userHome },
    ).pipe(
      Effect.provideService(Crypto.Crypto, digest),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not resolve the Antigravity profile directory.",
            cause,
          }),
      ),
    );
    const profileDirectory = directories.profile;
    // A private profile may still hold runtime files from before they moved beside it.
    for (const directory of [
      directories.runtimeTemp,
      ...(directories.shared ? [] : [path.join(profileDirectory, "antigravity-acp", "tmp")]),
    ]) {
      const removeRetired = yield* retireAntigravityRuntimeTempDirs(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* Effect.forkScoped(removeRetired);
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const readSignIn = readAntigravityStoredSignIn({
      profileDirectory,
      shared: directories.shared,
      platform,
      environment: processEnvironment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    // Absent for a profile with its own sign-in: only this computer's can change outside Nodex.
    const storedSignIn = directories.shared ? readSignIn : undefined;
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const prepareSpawn = Effect.fn("AntigravityDriver.prepareSpawn")(function* (
      cwd: string,
      baseEnv: NodeJS.ProcessEnv,
    ): Effect.fn.Return<
      {
        readonly executable: AntigravityInstallation.AntigravityExecutable;
        readonly spawn: AcpSessionRuntime.AcpSpawnInput;
      },
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        baseEnv: processEnvironment,
        auth,
        userHome,
        tempDirectory: directories.runtimeTemp,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isNodeRuntimeUnavailableError(cause.cause)
            ? new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                cause,
              })
            : cause,
        ),
      );
      // Use one directory per process; shared cleanup could delete files another session still reads.
      // Remove after the child dies, best-effort on Windows where handles may outlive the kill;
      // the next driver start sweeps leftovers.
      const runtimeTempDirectory = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity runtime temp directory.",
                cause,
              }),
          ),
        ),
        (directory) =>
          fileSystem
            .remove(directory, { recursive: true, force: true })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
              ),
            ),
      );
      return {
        executable,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd,
          baseEnv,
          auth,
          runtimeTempDirectory,
        }),
      };
    });

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: AntigravityAdapterV2RuntimeInput,
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      // `buildAntigravityAcpSpawnInput` sets `extendEnv: false`, so thread variables only reach the
      // agent's shell through `baseEnv`.
      const { processEnvironment: threadEnvironment, ...runtimeInput } = input;
      // Signed out, agy on this computer would open a browser for any session it starts. Only a
      // sign-in may do that; everything else asks for one without starting agy.
      const signIn = storedSignIn ? yield* storedSignIn : undefined;
      if (signIn?.status === "signed-out" && runtimeInput.onAuthorizationUrl === undefined) {
        yield* provider.onAuthRequired;
        return yield* new AcpErrors.AcpTransportError({
          detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
          cause: undefined,
        });
      }
      const { executable, spawn } = yield* prepareSpawn(
        runtimeInput.cwd,
        threadEnvironment === undefined
          ? processEnvironment
          : { ...processEnvironment, ...threadEnvironment },
      );
      const runtime = yield* makeAntigravityAcpRuntime({
        ...runtimeInput,
        runtimeVersion: executable.version,
        // This computer's sign-in authenticates with the Google method agy signed in with.
        authMethod:
          auth.authMethod === "computer"
            ? signIn?.status === "signed-in"
              ? signIn.authMethod
              : "oauth-personal"
            : auth.authMethod,
        childProcessSpawner: spawner,
        spawn,
      }).pipe(Effect.provideService(Crypto.Crypto, random));
      // A custom or PATH executable has no version until it answers initialize.
      const startCompatible = Effect.fn("AntigravityDriver.startCompatible")(function* () {
        const version = (yield* runtime.initialize()).agentInfo?.version;
        if (version && executable.managedVersionDirectory === null) {
          yield* installation.rememberVersion(executable, version);
        }
        const advisory = version ? yield* installation.compatibility(version) : undefined;
        const refused =
          version &&
          brokenRuntimeError({
            instanceId,
            name: "Antigravity",
            version,
            advisory,
            action:
              executable.source === "managed"
                ? "Update it in Antigravity setup"
                : `Update the Antigravity executable at ${executable.executablePath}`,
          });
        if (refused) {
          return yield* new AcpErrors.AcpTransportError({ detail: refused.detail, cause: refused });
        }
        return yield* runtime.start();
      });
      return {
        ...runtime,
        setMode: (modeId: string) =>
          runtime.getModeState.pipe(
            Effect.flatMap((modeState) =>
              runtime.setMode(antigravitySessionMode(modeId, modeState)),
            ),
          ),
        start: () =>
          startCompatible().pipe(
            Effect.tapError((cause): Effect.Effect<void> =>
              runtimeInput.onAuthorizationUrl === undefined &&
              isAntigravitySignInRequiredError(cause)
                ? provider.onAuthRequired
                : Effect.void,
            ),
          ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
    ) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "nodex-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravitySessionFiles({
          profileDirectory,
          sessionId,
          cwd,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const runtime = yield* makeRuntime({
        cwd,
        mcpServers: [],
        ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
      });
      return {
        ...runtime,
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                sessionId = started.sessionId;
              }),
            ),
          ),
      };
    });

    // The agy CLI ignores Nodex's browser helper during ACP `authenticate`, so a private Google
    // sign-in runs its remote-friendly `--login`, which stores the sign-in where the ACP process
    // reads it. This computer's sign-in is agy's own: `authenticate` opens the browser as agy in a
    // terminal does, and stores the sign-in in this computer's keyring.
    const codeLogin = Effect.fn("AntigravityDriver.codeLogin")(function* (input: {
      readonly onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
    }) {
      if (directories.shared || !antigravityAuthUsesBrowser(auth.authMethod)) return undefined;
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "nodex-antigravity-login-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      const { spawn } = yield* prepareSpawn(cwd, processEnvironment);
      const failed = (detail: string, cause?: unknown) =>
        new ProviderSetupError({ instanceId, operation: "start", detail, cause });
      // Without a display it prints the link only, instead of opening a browser on this machine.
      const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = spawn.env ?? {};
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, [...spawn.args, "--login"], {
            cwd,
            env,
            extendEnv: false,
            shell: false,
          }),
        )
        .pipe(Effect.mapError((cause) => failed("Could not start Antigravity sign-in.", cause)));
      const code = yield* Deferred.make<string>();
      yield* Stream.fromEffect(Deferred.await(code)).pipe(
        Stream.map((response) => `${response}\n`),
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => line.trim()),
        Stream.runForEach((line) =>
          line.startsWith("https://accounts.google.com/")
            ? input.onAuthorizationUrl(line)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
      return {
        submit: (response: string) => Deferred.succeed(code, response).pipe(Effect.asVoid),
        completed: Effect.gen(function* () {
          // Stdout closes when the process exits, or this fails first on an unusable link.
          yield* Fiber.join(output).pipe(
            Effect.mapError((cause) =>
              failed("Antigravity returned an invalid Google sign-in link.", cause),
            ),
          );
          const exitCode = yield* child.exitCode.pipe(
            Effect.mapError((cause) => failed("Antigravity sign-in stopped unexpectedly.", cause)),
          );
          if (Number(exitCode) !== 0) {
            return yield* failed(
              "Antigravity could not finish Google sign-in. Start sign-in again.",
            );
          }
        }),
      };
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
    ) {
      yield* provider.onSessionStarted(started);
      yield* authFlow.onSignedInElsewhere;
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const current = configOptions.find((option) => option.id === "model")?.currentValue;
      if (antigravityThinkingConfig(configOptions) !== undefined && typeof current === "string") {
        for (const model of [...antigravityModelOptions(configOptions), { value: current }]) {
          yield* runtime.setModel(model.value).pipe(Effect.ignore);
        }
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      // A new sign-in may be another account; drop any in-flight quota read first.
      onAuthenticated: (started, runtime) =>
        Effect.suspend(() => provider.onSignedIn).pipe(
          Effect.andThen(publishCatalog(started, runtime)),
        ),
      onSignedOut: Effect.suspend(() => provider.onSignedOut),
      usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
      codeLogin,
    });

    // The probe must not spawn. The agent is a PyInstaller one-file bundle
    // that unpacks about 1 GB per launch, and the health check runs every
    // minute.
    const probe = Effect.gen(function* () {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: "antigravity-acp",
          title: "Google Antigravity",
          version: executable.version ?? "unknown",
        },
      };
    });

    const probeUsage = (fileBacked: boolean) =>
      readAntigravityUsage({
        spawner,
        prepare: Effect.gen(function* () {
          const cwd = host.paths.stateDir;
          const { spawn } = yield* prepareSpawn(cwd, processEnvironment);
          const invocation = { command: spawn.command, cwd, env: spawn.env };
          if (!fileBacked && directories.shared) return invocation;
          // Print mode uses ~/.gemini/antigravity-cli and accepts neither ACP directory flag.
          // Give it a scoped home that resolves to the same Nodex profile and sign-in file.
          const home = yield* fileSystem.makeTempDirectoryScoped({
            directory: directories.runtimeTemp,
            prefix: "usage-",
          });
          const gemini = path.join(home, ".gemini");
          yield* fileSystem.makeDirectory(gemini, { mode: 0o700 });
          yield* Effect.tryPromise(() =>
            symlink(
              path.join(profileDirectory, "antigravity-acp"),
              path.join(gemini, "antigravity-cli"),
              platform === "win32" ? "junction" : "dir",
            ),
          );
          return {
            ...invocation,
            env: {
              ...invocation.env,
              SSH_CONNECTION: invocation.env?.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
              ...(platform === "win32" ? { USERPROFILE: home } : { HOME: home }),
            },
          };
        }),
      });
    // A sign-in made in a terminal loads the account's models once checks find it.
    const catalogLoader = yield* Deferred.make<Effect.Effect<void>>();
    const provider = yield* makeAntigravityProvider(settings, {
      environment: processEnvironment,
      ...(storedSignIn
        ? { storedSignIn, loadCatalog: Deferred.await(catalogLoader).pipe(Effect.flatten) }
        : { readPrivateSignIn: readSignIn }),
      stampIdentity: classifyModels,
      probe,
      probeUsage,
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Couldn't check Antigravity.",
            cause,
          }),
      ),
    );
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation,
      makeRuntime,
      withProcess: authFlow.withProcess,
      defaultModel,
      supportsNativeGoals: provider.snapshot.getSnapshot.pipe(
        Effect.map(
          (snapshot) => snapshot.slashCommands?.some((command) => command.name === "goal") === true,
        ),
      ),
      profileDirectory,
      onSessionStarted: (started, cwd) =>
        provider.onSessionStarted(started, cwd).pipe(Effect.andThen(authFlow.onSignedInElsewhere)),
      onSessionEvent: (event, cwd) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands, cwd)
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      profileDirectory,
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              const started = yield* runtime.start();
              yield* publishCatalog(started, runtime);
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in Settings → Agents before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" || cause.operation === "start")
                  ? cause.detail
                  : cause._tag === "AcpTransportError" &&
                      isProviderSetupError(cause.cause) &&
                      cause.cause.operation === "runtime"
                    ? cause.cause.detail
                    : refreshFailureDetail(cause),
              cause,
            }),
      ),
    );

    const catalogLoad = yield* FiberHandle.make();
    yield* Deferred.succeed(
      catalogLoader,
      FiberHandle.run(catalogLoad, refreshModels().pipe(Effect.ignore)).pipe(Effect.asVoid),
    );

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : discoverAntigravitySkills({ cwd, userHome, profileDirectory }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
      refreshUsage: provider.refreshUsage,
    } satisfies ProviderInstance;
  }),
};
