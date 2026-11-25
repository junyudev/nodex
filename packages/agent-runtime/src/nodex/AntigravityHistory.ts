// @effect-diagnostics nodeBuiltinImport:off -- lstat proves literal paths; copyFile clones copy-on-write.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import {
  AntigravitySettings,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
} from "@nodex/runtime-contracts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@nodex/provider-core/server/instanceEnvironment";
import * as AcpClient from "effect-acp/client";
import { AcpRequestError } from "effect-acp/errors";
import type { SessionNotification } from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AntigravityInstallation } from "../provider/AntigravityInstallation.ts";
import { antigravityClientInfo } from "../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../provider/acp/AntigravityProtocol.ts";
import {
  isAntigravitySignInRequiredError,
  makeAntigravityStdoutTransform,
} from "../provider/antigravityAuthSupport.ts";
import { resolveAntigravityUserHome } from "../provider/Drivers/AntigravitySkills.ts";
import { AntigravityHistoryError, openAntigravityImportSource } from "./AntigravityImportSource.ts";
import type { AgentRuntimeOperations } from "./Interface.ts";
import type { OpenAntigravityImportSource } from "./NativeImport.ts";
import { ProviderPolicy } from "./ProviderConfiguration.ts";

type List = AgentRuntimeOperations["antigravity.history.list"];
type Verify = AgentRuntimeOperations["antigravity.history.verify"];

const sourcePath = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const target = { instanceId: ProviderInstanceId, home: sourcePath };
export const ListInput = Schema.Struct(target);
export const VerifyInput = Schema.Struct({
  ...target,
  sessionId: Schema.String.check(Schema.isUUID()),
  sourceCwd: sourcePath,
});

const isNativeSessionId = Schema.is(VerifyInput.fields.sessionId);
const decodeSettings = Schema.decodeUnknownEffect(AntigravitySettings);
const MAX_PAGES = 100;
const MAX_PAGE_ENTRIES = 256;
const MAX_REPLAY_UPDATES = 100_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPTS = 10_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const HOME_UNAVAILABLE = "Antigravity's history folder is unavailable.";
const AUTH_REQUIRED =
  "Antigravity's command line isn't signed in on this computer, so its conversations can't be read. Run agy in a terminal to sign in, then try again.";

/**
 * Antigravity's apps that keep conversations under the Gemini root: the desktop app names its data
 * folder after itself, and agy keeps its own. A conversation's transcript lives in one of them.
 */
const HISTORY_APPS = ["antigravity", "antigravity-cli"] as const;
type HistoryApp = (typeof HISTORY_APPS)[number];
/** The desktop app encrypts each transcript into one file; agy keeps a SQLite database. */
const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(db|pb)$/u;
const SQLITE_COMPANIONS = ["-wal", "-shm"] as const;

/** One conversation's files, relative to its app's folder: its transcript and the title agy gave it. */
interface Transcript {
  readonly app: HistoryApp;
  readonly sessionId: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly modifiedAt: number;
}

const failure = (message: string) => new AntigravityHistoryError({ message });
const isHistoryError = Schema.is(AntigravityHistoryError);
const isAcpRequestError = Schema.is(AcpRequestError);

/** A regular file at its literal path, never through a link that could point elsewhere. */
const regularFile = (file: string) =>
  Effect.promise(() => NodeFSP.lstat(file).catch(() => undefined)).pipe(
    Effect.map((info) => (info?.isFile() ? info : undefined)),
  );

export const make = Effect.fn("AntigravityHistory.make")(function* () {
  const policy = yield* ProviderPolicy;
  const installation = yield* AntigravityInstallation;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const userHome = resolveAntigravityUserHome(
    platform,
    environment,
    yield* HostProcess.HomeDirectory,
  );
  const geminiDir = path.join(userHome, ".gemini");

  /** The profile whose executable reads the history, and the Gemini root it was asked about. */
  const prepare = Effect.fn("AntigravityHistory.prepare")(function* (input: List["input"]) {
    const profile = (yield* policy.current)[ProviderInstanceId.make(input.instanceId)];
    if (profile?.driver !== "antigravity" || profile.enabled === false)
      return yield* failure("This Antigravity profile is disabled or unavailable.");
    const settings = yield* decodeSettings(profile.config ?? {}).pipe(
      Effect.mapError(() => failure("This Antigravity profile is unavailable.")),
    );
    if (
      providerInstanceConfigEnabledFlag(profile.config) === false ||
      !(profile.enabled ?? settings.enabled)
    )
      return yield* failure("This Antigravity profile is disabled or unavailable.");
    if (!path.isAbsolute(geminiDir) || !path.isAbsolute(input.home))
      return yield* failure(HOME_UNAVAILABLE);
    const directory = yield* fs
      .stat(geminiDir)
      .pipe(Effect.mapError(() => failure(HOME_UNAVAILABLE)));
    if (directory.type !== "Directory") return yield* failure(HOME_UNAVAILABLE);
    const home = yield* fs
      .realPath(geminiDir)
      .pipe(Effect.mapError(() => failure(HOME_UNAVAILABLE)));
    if (home !== input.home)
      return yield* failure("Antigravity's history folder changed. Refresh and try again.");
    return {
      home,
      settings,
      executableEnvironment: yield* mergeProviderInstanceEnvironment(profile.environment, {
        host: environment,
      }),
    };
  });

  /** Every transcript an app keeps, each found once at its literal path. */
  const transcripts = Effect.fn("AntigravityHistory.transcripts")(function* (
    home: string,
    app: HistoryApp,
    only?: string,
  ) {
    const directory = path.join(home, app, "conversations");
    const info = yield* Effect.promise(() => NodeFSP.lstat(directory).catch(() => undefined));
    if (!info?.isDirectory()) return [];
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const found: Transcript[] = [];
    for (const name of names) {
      const match = TRANSCRIPT.exec(name);
      if (!match || (only !== undefined && match[1] !== only)) continue;
      const transcript = yield* regularFile(path.join(directory, name));
      if (!transcript) continue;
      const files = [{ path: path.join("conversations", name), size: transcript.size }];
      const optional = [
        ...(match[2] === "db"
          ? SQLITE_COMPANIONS.map((suffix) => path.join("conversations", name + suffix))
          : []),
        path.join("annotations", `${match[1]}.pbtxt`),
      ];
      for (const relative of optional) {
        const file = yield* regularFile(path.join(home, app, relative));
        if (file) files.push({ path: relative, size: file.size });
      }
      found.push({ app, sessionId: match[1]!, files, modifiedAt: transcript.mtimeMs });
      if (found.length > MAX_TRANSCRIPTS)
        return yield* failure("Antigravity's history has too many conversations to read.");
    }
    return found;
  });

  // agy writes its own state wherever it reads: an index, caches, memories and built-in skills.
  // It reads a private copy-on-write snapshot instead, so neither app's history is ever written.
  const snapshot = Effect.fn("AntigravityHistory.snapshot")(function* (
    home: string,
    root: string,
    app: HistoryApp,
    selected: ReadonlyArray<Transcript>,
  ) {
    const files = selected.flatMap(({ files }) => files);
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SNAPSHOT_BYTES)
      return yield* failure("Antigravity's history is too large to read.");
    for (const folder of ["conversations", "annotations"])
      yield* fs.makeDirectory(path.join(root, app, folder), { recursive: true });
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.tryPromise({
          try: () =>
            NodeFSP.copyFile(
              path.join(home, app, file.path),
              path.join(root, app, file.path),
              NodeFS.constants.COPYFILE_FICLONE,
            ),
          catch: () => failure("Could not read Antigravity's history."),
        }),
      { concurrency: 8, discard: true },
    );
  });

  /** An initialize-only agy connection reading one app's snapshot with the command line's sign-in. */
  const connect = Effect.fn("AntigravityHistory.connect")(function* (
    prepared: Effect.Success<ReturnType<typeof prepare>>,
    app: HistoryApp,
    selected: ReadonlyArray<Transcript>,
  ) {
    const executable = yield* installation
      .acquire(prepared.settings.binaryPath, prepared.executableEnvironment)
      .pipe(
        Effect.mapError(() =>
          failure("Could not find the Antigravity executable for this profile."),
        ),
      );
    // agy unpacks its runtime into a private temp directory. An empty process cwd also
    // distinguishes conversations whose original history never recorded a workspace.
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-agy-history-" });
    const root = path.join(temp, "gemini");
    yield* snapshot(prepared.home, root, app, selected);
    const workspace = path.join(temp, "empty");
    yield* fs.makeDirectory(workspace);
    const cwd = yield* fs.realPath(workspace);
    const child = yield* spawner.spawn(
      ChildProcess.make(
        executable.executablePath,
        [
          "acp",
          "--gemini-dir",
          root,
          "--app-data-dir",
          app,
          "--log-file",
          path.join(temp, "acp.log"),
          "--disable-telemetry",
        ],
        {
          cwd,
          env: {
            ...environment,
            TMPDIR: temp,
            ...(platform === "win32" ? { TMP: temp, TEMP: temp } : {}),
            AGY_CLI_DISABLE_AUTO_UPDATE: "1",
          },
          extendEnv: false,
          shell: false,
        },
      ),
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
    const context = yield* Layer.build(
      AcpClient.layerChildProcess(child, {
        transformStdout: makeAntigravityStdoutTransform(),
        transformSessionUpdate: normalizeAntigravitySessionUpdate,
      }),
    );
    const client = yield* AcpClient.AcpClient.pipe(Effect.provide(context));
    return {
      client,
      cwd,
      initialize: () =>
        client.agent.initialize({
          protocolVersion: 2,
          clientInfo: antigravityClientInfo(executable.version),
        }),
    };
  });

  // Only curated history failures cross the Runtime boundary. Protocol errors may contain
  // agent-supplied diagnostics and are translated here, before they reach the wire.
  const publicFailure = (cause: unknown, fallback: string) => {
    if (isHistoryError(cause)) return cause;
    const needsAuth = isAcpRequestError(cause)
      ? cause.code === -32000 && cause.errorMessage === "Authentication required"
      : isAntigravitySignInRequiredError(cause);
    return failure(needsAuth ? AUTH_REQUIRED : fallback);
  };

  /** One app's conversations, as agy lists them from its snapshot across every folder. */
  const listApp = Effect.fn("AntigravityHistory.listApp")(function* (
    prepared: Effect.Success<ReturnType<typeof prepare>>,
    app: HistoryApp,
    selected: ReadonlyArray<Transcript>,
  ) {
    const { client, cwd, initialize } = yield* connect(prepared, app, selected);
    yield* client.handleSessionUpdate(() => Effect.void);
    yield* initialize();
    const entries: Array<List["output"]["entries"][number]> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Omitting cwd is how agy lists work across every folder.
      const result = yield* client.agent.listSessions(cursor === undefined ? {} : { cursor });
      if (result.sessions.length > MAX_PAGE_ENTRIES)
        return yield* failure("Antigravity returned an unexpectedly large conversation list.");
      yield* Effect.forEach(
        result.sessions,
        (session) =>
          Effect.gen(function* () {
            if (!isNativeSessionId(session.sessionId) || !path.isAbsolute(session.cwd)) return;
            const project = yield* fs
              .realPath(session.cwd)
              .pipe(Effect.orElseSucceed(() => path.normalize(session.cwd)));
            if (project === cwd) return;
            const parsed = Date.parse(session.updatedAt ?? "");
            entries.push({
              nativeSessionId: session.sessionId.toLowerCase(),
              cwd: session.cwd,
              title: session.title ?? "",
              updatedAt: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
            });
          }),
        { concurrency: 8, discard: true },
      );
      if (!result.nextCursor) return entries;
      cursor = result.nextCursor;
      if (seen.has(cursor))
        return yield* failure("Antigravity repeated a conversation list page. Try again.");
      seen.add(cursor);
    }
    return yield* failure("Antigravity's conversation list is too large to read.");
  }, Effect.scoped);

  const list = Effect.fn("AntigravityHistory.list")(
    function* (input: List["input"]): Effect.fn.Return<List["output"], unknown, Scope.Scope> {
      const prepared = yield* prepare(input);
      const found = yield* Effect.forEach(HISTORY_APPS, (app) => transcripts(prepared.home, app));
      // Each app lists only the transcripts in its snapshot. Should both hold one conversation, the
      // newer transcript is the one copied, so that app's listing is the one offered.
      const owners = new Map<string, Transcript>();
      for (const transcript of found.flat()) {
        const known = owners.get(transcript.sessionId);
        if (!known || transcript.modifiedAt > known.modifiedAt)
          owners.set(transcript.sessionId, transcript);
      }
      const offered = new Map<string, List["output"]["entries"][number]>();
      for (const [index, app] of HISTORY_APPS.entries()) {
        const selected = found[index]!;
        if (selected.length === 0) continue;
        for (const entry of yield* listApp(prepared, app, selected)) {
          const owner = owners.get(entry.nativeSessionId);
          if (owner && (owner.app === app || !offered.has(entry.nativeSessionId)))
            offered.set(entry.nativeSessionId, entry);
        }
      }
      return { entries: [...offered.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
    },
    Effect.timeout("90 seconds"),
    Effect.mapError((cause) => publicFailure(cause, "Could not list Antigravity's conversations.")),
    Effect.scoped,
  );

  const replay = Effect.fn("AntigravityHistory.replay")(
    function* (input: Verify["input"]) {
      if (!path.isAbsolute(input.sourceCwd))
        return yield* failure("Antigravity did not record a folder for this conversation.");
      const prepared = yield* prepare(input);
      const sessionId = input.sessionId.toLowerCase();
      // The app holding the transcript owns the conversation; the newest copy wins if both do.
      const [transcript] = (yield* Effect.forEach(HISTORY_APPS, (app) =>
        transcripts(prepared.home, app, sessionId),
      ))
        .flat()
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      if (!transcript)
        return yield* failure("This Antigravity conversation is no longer on this computer.");
      const { client, initialize } = yield* connect(prepared, transcript.app, [transcript]);
      const updates: SessionNotification[] = [];
      let bytes = 0;
      let overflow = false;
      yield* client.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          if (overflow || notification.sessionId !== sessionId) return;
          bytes += Buffer.byteLength(JSON.stringify(notification));
          overflow = bytes > MAX_REPLAY_BYTES || updates.length >= MAX_REPLAY_UPDATES;
          if (!overflow) updates.push(notification);
        }),
      );
      const initialized = yield* initialize();
      // The typed client maps load to a resume on v2. Only the read-only v1 load is used here.
      if (
        initialized.agentCapabilities?.loadSession !== true ||
        (yield* client.protocolGeneration) !== 1
      )
        return yield* failure("This Antigravity executable cannot replay its history.");
      yield* client.agent.loadSession({ sessionId, cwd: input.sourceCwd, mcpServers: [] });
      if (overflow) return yield* failure("This Antigravity conversation is too large to copy.");
      return updates;
    },
    Effect.timeout("60 seconds"),
    Effect.mapError((cause) =>
      publicFailure(cause, "Could not replay this Antigravity conversation."),
    ),
    Effect.scoped,
  );

  const open = (input: Verify["input"]) =>
    replay(input).pipe(
      Effect.flatMap((updates) => openAntigravityImportSource({ cwd: input.sourceCwd, updates })),
    );
  const verify = (input: Verify["input"]) => open(input).pipe(Effect.as({}));
  const openImportSource: OpenAntigravityImportSource = (input) =>
    open({
      instanceId: input.modelSelection.instanceId,
      home: input.sourceHome,
      sessionId: input.sourceNativeThreadId,
      sourceCwd: input.sourceCwd,
    });
  return { list, verify, openImportSource };
});
