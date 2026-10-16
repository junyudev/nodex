import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { MainConfig } from "../../app/MainConfig";
import { loadCodexLocalShellEnvironment } from "../../codex/codex-worktree-shell-environment";

export const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/v2/install | /bin/bash";
const MAXIMUM_INSTALL_OUTPUT_BYTES = 256 * 1024;
const MAXIMUM_VERSION_OUTPUT_BYTES = 4 * 1024;

export interface OpenCodeInstalledExecutable {
  readonly binaryPath: string;
  readonly version: string;
}
export interface OpenCodeInstallOutput {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}
export interface OpenCodeInstallHost {
  readonly homeDirectory: string;
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}
export class OpenCodeInstallPlatformError extends Schema.TaggedError<OpenCodeInstallPlatformError>()(
  "OpenCodeInstallPlatformError",
  {
    reason: Schema.Literals([
      "unsupported-platform",
      "invalid-home",
      "existing-installation",
      "process",
      "timeout",
      "output-limit",
      "invalid-version",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
export class OpenCodeInstallPlatform extends Context.Service<
  OpenCodeInstallPlatform,
  {
    /** Searches the preference first, then other host installs; discovery never rebinds settings. */
    readonly probe: (
      preferredBinaryPath?: string,
    ) => Effect.Effect<OpenCodeInstalledExecutable | null, OpenCodeInstallPlatformError>;
    readonly install: (
      onOutput: (output: OpenCodeInstallOutput) => Effect.Effect<void>,
      preferredBinaryPath?: string,
    ) => Effect.Effect<OpenCodeInstalledExecutable, OpenCodeInstallPlatformError>;
  }
>()("nodex/main/platform/node/OpenCodeInstallPlatform") {}

/** Installation belongs to the host account, independently of every native execution Profile. */
export const openCodeInstallEnvironment = (
  host: OpenCodeInstallHost,
): Record<string, string | undefined> => ({
  ...Object.fromEntries(
    Object.entries(host.environment).filter(
      ([name, value]) =>
        value !== undefined &&
        name !== "VERSION" &&
        !name.startsWith("OPENCODE_") &&
        !name.startsWith("XDG_"),
    ),
  ),
  HOME: host.homeDirectory,
  SHELL: host.environment.SHELL || (host.platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
});

const failure = (
  reason: OpenCodeInstallPlatformError["reason"],
  message: string,
  cause?: unknown,
) =>
  new OpenCodeInstallPlatformError({ reason, message, ...(cause === undefined ? {} : { cause }) });

export const make = Effect.fn("OpenCodeInstallPlatform.make")(function* (
  host: OpenCodeInstallHost,
  loadShellPath?: Effect.Effect<string | undefined>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = openCodeInstallEnvironment(host);
  const target = join(host.homeDirectory, ".opencode", "bin", "opencode");
  // The official installer also replaces its legacy launcher shims.
  const installationPaths = [
    "opencode",
    "opencode.exe",
    "opencode2",
    "opencode2.exe",
    "opencode2.cmd",
  ];
  const targetExists = Effect.forEach(installationPaths, (name) =>
    Effect.tryPromise(() => lstat(join(host.homeDirectory, ".opencode", "bin", name))).pipe(
      Effect.map(() => true),
      Effect.catch((cause) =>
        cause.cause instanceof Error && "code" in cause.cause && cause.cause.code === "ENOENT"
          ? Effect.succeed(false)
          : failure("process", "The OpenCode installation path could not be checked.", cause),
      ),
    ),
  ).pipe(Effect.map((existing) => existing.some(Boolean)));
  const supported = host.platform === "darwin" || host.platform === "linux";
  const checkHost = Effect.suspend(() => {
    if (!supported)
      return failure("unsupported-platform", "OpenCode installation requires macOS or Linux.");
    if (!isAbsolute(host.homeDirectory))
      return failure("invalid-home", "The host home directory must be absolute.");
    return Effect.void;
  });
  const run = Effect.fn("OpenCodeInstallPlatform.run")(function* (
    command: ChildProcess.Command,
    maximumBytes: number,
    onOutput: (output: OpenCodeInstallOutput) => Effect.Effect<void>,
  ) {
    let outputBytes = 0;
    const process = yield* spawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          failure("process", "OpenCode could not start its command.", cause),
        ),
      );
    const drain = (stream: OpenCodeInstallOutput["stream"]) =>
      process[stream].pipe(
        Stream.decodeText(),
        Stream.runForEach((data) =>
          Effect.suspend(() => {
            outputBytes += Buffer.byteLength(data);
            if (outputBytes > maximumBytes)
              return failure("output-limit", "OpenCode command output exceeded its limit.");
            return onOutput({ stream, data });
          }),
        ),
        Effect.mapError((cause) =>
          Schema.is(OpenCodeInstallPlatformError)(cause)
            ? cause
            : failure("process", "OpenCode command output could not be read.", cause),
        ),
      );
    const [, , code] = yield* Effect.all([drain("stdout"), drain("stderr"), process.exitCode], {
      concurrency: "unbounded",
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OpenCodeInstallPlatformError)(cause)
          ? cause
          : failure("process", "OpenCode command could not finish.", cause),
      ),
    );
    if (code !== 0) return yield* failure("process", `OpenCode command exited with code ${code}.`);
  });
  const processOptions = {
    cwd: host.homeDirectory,
    env: environment,
    extendEnv: false,
    shell: false,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  } as const;
  const inspect = Effect.fn("OpenCodeInstallPlatform.inspect")(function* (binaryPath: string) {
    let stdout = "";
    yield* run(
      ChildProcess.make(binaryPath, ["--version"], processOptions),
      MAXIMUM_VERSION_OUTPUT_BYTES,
      ({ stream, data }) =>
        Effect.sync(() => {
          if (stream === "stdout") stdout += data;
        }),
    ).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => failure("timeout", "OpenCode version detection timed out."),
      }),
    );
    const version = stdout
      .trim()
      .match(/^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/u)?.[1];
    if (!version) return yield* failure("invalid-version", "OpenCode returned an invalid version.");
    return { binaryPath, version };
  });
  const find = Effect.fn("OpenCodeInstallPlatform.find")(function* (candidates: readonly string[]) {
    for (const candidate of candidates) {
      const executable = yield* Effect.tryPromise(() =>
        access(candidate, constants.X_OK)
          .then(() => stat(candidate))
          .then((info) => (info.isFile() ? candidate : null)),
      ).pipe(Effect.orElseSucceed(() => null));
      if (executable) return executable;
    }
    return null;
  });
  const fromPath = (path: string | undefined, binary: string) =>
    (path ?? "")
      .split(delimiter)
      .filter(isAbsolute)
      .map((directory) => join(directory, binary));
  const probe = Effect.fn("OpenCodeInstallPlatform.probe")(function* (
    preferredBinaryPath = "opencode",
  ) {
    yield* checkHost;
    const explicit = /[/\\]/u.test(preferredBinaryPath);
    const expanded = preferredBinaryPath.startsWith("~/")
      ? join(host.homeDirectory, preferredBinaryPath.slice(2))
      : resolve(host.homeDirectory, preferredBinaryPath);
    const primary = yield* find(
      explicit ? [expanded] : fromPath(environment.PATH, preferredBinaryPath),
    );
    if (primary) return yield* inspect(primary);
    const loginPath = loadShellPath ? yield* loadShellPath : undefined;
    const discovered = yield* find([
      ...fromPath(loginPath, "opencode"),
      ...(explicit ? fromPath(environment.PATH, "opencode") : []),
      target,
    ]);
    if (discovered) return yield* inspect(discovered);
    if (yield* targetExists)
      return yield* failure(
        "existing-installation",
        "An existing OpenCode installation could not be executed.",
      );
    return null;
  });
  return OpenCodeInstallPlatform.of({
    probe,
    install: Effect.fn("OpenCodeInstallPlatform.install")(function* (
      onOutput: (output: OpenCodeInstallOutput) => Effect.Effect<void>,
      preferredBinaryPath?: string,
    ) {
      const existing = yield* probe(preferredBinaryPath);
      if (existing) return existing;
      if (yield* targetExists)
        return yield* failure(
          "existing-installation",
          "An existing OpenCode installation will not be replaced.",
        );
      yield* run(
        ChildProcess.make(
          "/bin/bash",
          ["-o", "pipefail", "-c", OPENCODE_INSTALL_COMMAND],
          processOptions,
        ),
        MAXIMUM_INSTALL_OUTPUT_BYTES,
        onOutput,
      ).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () => failure("timeout", "OpenCode installation timed out."),
        }),
      );
      const installed = yield* find([target]);
      if (!installed)
        return yield* failure("process", "The installer did not produce an OpenCode executable.");
      return yield* inspect(installed);
    }),
  });
});

export const live = Layer.effect(
  OpenCodeInstallPlatform,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const environment = openCodeInstallEnvironment(config);
    const loginPath = Effect.tryPromise({
      try: (signal) => loadCodexLocalShellEnvironment({ baseEnvironment: environment, signal }),
      catch: (cause) => failure("process", "The login shell path could not be read.", cause),
    }).pipe(
      Effect.map((value) => value.PATH),
      Effect.timeoutOption("5 seconds"),
      Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
    return yield* make(config, loginPath);
  }),
);

export const nodeLive = live.pipe(Layer.provide(NodeServices.layer));
