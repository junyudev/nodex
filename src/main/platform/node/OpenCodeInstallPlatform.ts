import {
  escapeWindowsShellArg,
  sanitizeShellModeArgsForPlatform,
} from "@nodex/agent-runtime/windows-shell";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hostCapabilities } from "../../../shared/host-capabilities";
import { makeHostExecutableSearch, type HostExecutableSearchHost } from "./HostExecutableSearch";
import { OPEN_CODE_HOME_LOCATIONS } from "./OpenCodeExecutable";
import {
  HostShellEnvironment,
  inheritedHostShellEnvironment,
} from "../../host-runtime/HostShellEnvironment";
import * as NodeServices from "./NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { MainConfig } from "../../app/MainConfig";

export const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/v2/install | /bin/bash";
export const openCodeInstallCommand = (platform: string, architecture = "x64"): string =>
  platform === "win32" ? openCodeWindowsInstallScript(architecture) : OPENCODE_INSTALL_COMMAND;

export const openCodeWindowsInstallScript = (architecture: string): string => {
  if (architecture !== "x64" && architecture !== "arm64")
    throw new Error("Unsupported Windows architecture");
  const artifact = architecture === "arm64" ? "arm64" : "x64-baseline";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$root = Join-Path $env:USERPROFILE '.opencode'",
    "$temporary = if ($env:NODEX_OPENCODE_INSTALL_TEMP) { $env:NODEX_OPENCODE_INSTALL_TEMP } else { Join-Path $root ([Guid]::NewGuid().ToString()) }",
    "New-Item -ItemType Directory -Path $temporary -Force | Out-Null",
    "try {",
    `Invoke-WebRequest -Uri 'https://opencode.ai/update/api/latest/cli/opencode/opencode-windows-${artifact}.zip' -OutFile (Join-Path $temporary 'opencode.zip')`,
    "Expand-Archive -LiteralPath (Join-Path $temporary 'opencode.zip') -DestinationPath (Join-Path $temporary 'unpacked')",
    "$binary = @(Get-ChildItem -LiteralPath (Join-Path $temporary 'unpacked') -Recurse -Filter 'opencode.exe')",
    "if ($binary.Count -ne 1) { throw 'The download did not contain one OpenCode executable.' }",
    "New-Item -ItemType Directory -Path (Join-Path $root 'bin') -Force | Out-Null",
    "[IO.File]::Move($binary[0].FullName, (Join-Path $root 'bin\\opencode.exe'))",
    "} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }",
  ].join("; ");
};

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
export interface OpenCodeInstallHost extends HostExecutableSearchHost {
  readonly arch?: string;
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
  ...(host.platform === "win32" ? { USERPROFILE: host.homeDirectory } : {}),
  ...(host.platform === "win32"
    ? {}
    : { SHELL: host.environment.SHELL || (host.platform === "darwin" ? "/bin/zsh" : "/bin/bash") }),
});

const failure = (
  reason: OpenCodeInstallPlatformError["reason"],
  message: string,
  cause?: unknown,
) =>
  new OpenCodeInstallPlatformError({ reason, message, ...(cause === undefined ? {} : { cause }) });

export const make = Effect.fn("OpenCodeInstallPlatform.make")(function* (
  host: OpenCodeInstallHost,
  shell: HostShellEnvironment["Service"] = inheritedHostShellEnvironment(host.environment),
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = openCodeInstallEnvironment(host);
  const target = join(
    host.homeDirectory,
    ".opencode",
    "bin",
    host.platform === "win32" ? "opencode.exe" : "opencode",
  );
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
  const supported = hostCapabilities(host.platform).openCode;
  const checkHost = Effect.suspend(() => {
    if (!supported)
      return failure("unsupported-platform", "OpenCode is unavailable on this platform.");
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
    detached: host.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  } as const;
  const search = makeHostExecutableSearch({ ...host, environment }, shell);
  const inspect = Effect.fn("OpenCodeInstallPlatform.inspect")(function* (
    binaryPath: string,
    path = environment.PATH,
  ) {
    // Keep the installer probe in the host account while allowing script launchers to find Node.
    const probeOptions = {
      ...processOptions,
      env: { ...environment, PATH: path },
      detached: false,
    };
    let stdout = "";
    yield* run(
      host.platform === "win32" && /\.(cmd|bat)$/iu.test(binaryPath)
        ? ChildProcess.make(
            escapeWindowsShellArg(binaryPath),
            sanitizeShellModeArgsForPlatform(["--version"], "win32"),
            { ...probeOptions, shell: true },
          )
        : ChildProcess.make(binaryPath, ["--version"], probeOptions),
      MAXIMUM_VERSION_OUTPUT_BYTES,
      ({ stream, data }) =>
        Effect.sync(() => {
          if (stream === "stdout") stdout += data;
        }),
    ).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => failure("timeout", "OpenCode version detection timed out."),
      }),
    );
    const version = stdout
      .trim()
      .match(/^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/u)?.[1];
    if (!version) return yield* failure("invalid-version", "OpenCode returned an invalid version.");
    return { binaryPath, version };
  });
  const probe = Effect.fn("OpenCodeInstallPlatform.probe")(function* (
    preferredBinaryPath = "opencode",
  ) {
    yield* checkHost;
    const request = { cwd: host.homeDirectory };
    const preferred =
      preferredBinaryPath !== "opencode"
        ? yield* search.first({ ...request, commands: [preferredBinaryPath], pathOnly: true })
        : undefined;
    const candidate =
      preferred ??
      (yield* search.first({
        ...request,
        commands: ["opencode"],
        homeLocations: OPEN_CODE_HOME_LOCATIONS,
      }));
    if (candidate) return yield* inspect(candidate.path, candidate.environment.PATH);
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
    ): Effect.fn.Return<OpenCodeInstalledExecutable, OpenCodeInstallPlatformError> {
      const existing = yield* probe(preferredBinaryPath);
      if (existing) return existing;
      if (yield* targetExists)
        return yield* failure(
          "existing-installation",
          "An existing OpenCode installation will not be replaced.",
        );
      const recovered = yield* shell.latest;
      const installEnvironment =
        recovered?.status === "captured"
          ? openCodeInstallEnvironment({ ...host, environment: recovered.environment })
          : environment;
      yield* Effect.gen(function* () {
        const temporary =
          host.platform === "win32"
            ? yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => mkdtemp(join(host.homeDirectory, ".nodex-opencode-install-")),
                  catch: (cause) =>
                    failure(
                      "process",
                      "The OpenCode download directory could not be created.",
                      cause,
                    ),
                }),
                (directory) =>
                  Effect.promise(() =>
                    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
                  ),
              )
            : undefined;
        return yield* run(
          host.platform === "win32"
            ? ChildProcess.make(
                "powershell.exe",
                [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-Command",
                  openCodeWindowsInstallScript(host.arch ?? "x64"),
                ],
                {
                  ...processOptions,
                  env: { ...environment, NODEX_OPENCODE_INSTALL_TEMP: temporary },
                },
              )
            : ChildProcess.make("/bin/bash", ["-o", "pipefail", "-c", OPENCODE_INSTALL_COMMAND], {
                ...processOptions,
                env: installEnvironment,
              }),
          MAXIMUM_INSTALL_OUTPUT_BYTES,
          onOutput,
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () => failure("timeout", "OpenCode installation timed out."),
        }),
      );
      const installed = yield* search.first({ commands: [target], pathOnly: true });
      if (!installed)
        return yield* failure("process", "The installer did not produce an OpenCode executable.");
      return yield* inspect(installed.path);
    }),
  });
});

export const live = Layer.effect(
  OpenCodeInstallPlatform,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const shell = yield* HostShellEnvironment;
    return yield* make(config, shell);
  }),
);

export const nodeLive = live.pipe(Layer.provide(NodeServices.layer));
