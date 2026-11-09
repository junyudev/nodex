import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { version } from "../../package.json";
import markdownWasmPath from "../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?asset";
import { layer as configLayer } from "../main/app/MainConfig";
import { MainShutdown, layer as shutdownLayer } from "../main/app/MainShutdown";
import { CoreClient } from "../main/core-client/core-client";
import { resolveCoreExecutable } from "../main/core-client/core-launcher";
import { layer as nodeServices } from "../main/platform/node/NodeServices";
import { verifyHostSecrets, hostListenerWarning } from "../main/platform/node/HostSecurity";
import {
  readHostConfiguration,
  openHostLease,
  writeHostStatus,
  clearHostStatus,
} from "../main/platform/node/HostServePlatform";
import { HeadlessHost, live as hostLayer } from "./HeadlessApplicationLive";
import { startHostRelay } from "./HostRelay";

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const packaged = resolve(__dirname, "../..").endsWith("app.asar.unpacked");
const resourcesPath = packaged
  ? resolve(__dirname, "../../..")
  : resolve(__dirname, "../../resources");
const projectRootPath = resolve(__dirname, "../..");

/** A service manager's SIGTERM or SIGINT is the only interruption of this fiber: a stop whose
 * teardown released Core and the Host lease is clean; any failure stays non-zero for restart. */
const stoppedCleanly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause);

const program = Effect.gen(function* () {
  if (!process.versions.electron)
    return yield* Effect.fail(new Error("The Host requires Electron in Node mode"));
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      home: { type: "string" },
      instance: { type: "string" },
      "allow-same-user-agents": { type: "boolean", default: false },
    },
  });
  if (!values.home || !values.instance)
    return yield* Effect.fail(new Error("Host requires --home and --instance"));
  if (!/^[a-f\d-]{16,64}$/iu.test(values.instance))
    return yield* Effect.fail(new Error("Host instance identity is invalid"));
  const instance = values.instance;
  const coreHome = yield* Effect.tryPromise(() => realpath(values.home!));
  const coreExecutable = resolveCoreExecutable({
    environment,
    isPackaged: packaged,
    appResourcesPath: resourcesPath,
    repositoryRoot: projectRootPath,
  });
  const config = yield* Effect.tryPromise(() => readHostConfiguration(coreHome, coreExecutable));
  const warning = hostListenerWarning({
    address: config.address,
    agentRunner: config.agentRunner,
    allowSameUserAgents: values["allow-same-user-agents"],
  });
  yield* Effect.tryPromise(() => verifyHostSecrets(coreHome, coreExecutable, { running: false }));
  if (warning)
    yield* Effect.logWarning(warning).pipe(
      Effect.annotateLogs({ allowSameUserAgents: values["allow-same-user-agents"] }),
    );
  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      openHostLease({
        cli: join(dirname(coreExecutable), process.platform === "win32" ? "nodex.exe" : "nodex"),
        coreHome,
        instance,
        pid: process.pid,
        environment,
      }),
    ),
    (lease) => Effect.promise(lease.close),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => clearHostStatus(coreHome, instance)));
  const configuration = configLayer({
    assistantStreamingDebug: false,
    appVersion: version,
    arch: process.arch,
    argv: process.argv,
    composerAppshotHelperPath: null,
    documentsPath: join(homedir(), "Documents"),
    environment,
    environmentPath: environment.PATH ?? null,
    homeDirectory: homedir(),
    projectsDirectory: null,
    isolatedRunId: environment.NODEX_ISOLATED_RUN_ID ?? null,
    isDefaultApp: false,
    isPackaged: packaged,
    markdownModulePath: markdownWasmPath,
    nodexHome: config.executionHome,
    platform: process.platform,
    profileSettingsPath: join(coreHome, "config.toml"),
    projectRootPath,
    rendererUrl: null,
    resourcesPath,
    runtimeBinaryPath: process.execPath,
  });
  const run = Effect.gen(function* () {
    const host = yield* HeadlessHost;
    const shutdown = yield* MainShutdown;
    yield* startHostRelay({ coreHome, instance, host });
    const admin = yield* Effect.tryPromise(() =>
      CoreClient.connect({
        nodexHome: coreHome,
        clientKind: "native_cli",
        buildId: `nodex-host/${version}`,
      }),
    );
    if (admin.handshake.library_id !== config.spaceId)
      return yield* Effect.fail(new Error("Host configuration belongs to another Space"));
    yield* Effect.tryPromise(() => verifyHostSecrets(coreHome, coreExecutable));
    const listener = yield* Effect.tryPromise(() =>
    );
    yield* Effect.tryPromise(() =>
      writeHostStatus(coreHome, {
        state: "ready",
        running: true,
        instance,
        pid: process.pid,
        spaceId: config.spaceId,
        coreGeneration: admin.handshake.generation.start_nonce,
        listener,
        warning,
        agentRunner: config.agentRunner?.user ?? null,
        allowSameUserAgents: values["allow-same-user-agents"],
      }),
    );
    yield* Effect.logInfo("Space Host is ready").pipe(
      Effect.annotateLogs({ spaceId: config.spaceId, address: listener.url }),
    );
    const lost = Effect.promise(() => lease.closed).pipe(
      Effect.andThen(Effect.fail(new Error("Host lease was lost"))),
    );
    const reason = yield* Effect.raceFirst(shutdown.awaitRequest, lost).pipe(
      Effect.onInterrupt(() => Effect.logInfo("Space Host is stopping")),
    );
    if (
      reason._tag === "RuntimeFatal" ||
      reason._tag === "AuthorityDriftRelaunch" ||
      reason._tag === "StoreRestoreRelaunch"
    ) {
      yield* Effect.logError("Space Host generation ended").pipe(Effect.annotateLogs({ reason }));
      return yield* Effect.fail(new Error("The Space Host requires restart"));
    }
  }).pipe(
    Effect.provide(
      hostLayer({
        coreHome,
        workerDirectory: __dirname,
        agentRunner: config.agentRunner,
        repositories: config.repositories,
      }).pipe(Layer.provideMerge(configuration)),
    ),
    Effect.provide(shutdownLayer),
  );
  yield* run;
}).pipe(
  Effect.scoped,
  Effect.provide(nodeServices),
  Effect.onExit((exit) =>
    Exit.isFailure(exit) && !stoppedCleanly(exit)
      ? Effect.logError("Space Host stopped after a failure", exit.cause)
      : Effect.logInfo("Space Host stopped"),
  ),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => onExit(stoppedCleanly(exit) ? 0 : 1),
});
