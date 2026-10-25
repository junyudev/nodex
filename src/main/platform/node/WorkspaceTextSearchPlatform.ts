import { createHash, randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CodexSshExecutionHostConfig } from "../../../shared/types";
import type { WorkspaceTextSearchErrorCode } from "../../../shared/workspace-text-search";
import { CodexPlatform } from "../../app/CodexApplicationLive";
import { MainConfig } from "../../app/MainConfig";
import { buildCodexSshArguments } from "../../codex/codex-ssh-execution-host";

export class WorkspaceTextSearchError extends Schema.TaggedError<WorkspaceTextSearchError>()(
  "WorkspaceTextSearchError",
  {
    code: Schema.Literals([
      "invalid-query",
      "invalid-file-mask",
      "unsupported-host",
      "missing-ripgrep",
      "search-failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const textSearchError = (
  code: WorkspaceTextSearchErrorCode,
  message: string,
  cause?: unknown,
) => new WorkspaceTextSearchError({ code, message, ...(cause === undefined ? {} : { cause }) });

interface ProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly onLine?: (line: string) => Effect.Effect<boolean, WorkspaceTextSearchError>;
}

export interface WorkspaceTextSearchHost {
  readonly platform: "posix" | "win32";
  readonly executable: string;
  readonly readDirectory: (
    directory: string,
  ) => Effect.Effect<readonly string[], WorkspaceTextSearchError>;
  readonly search: (
    root: string,
    args: readonly string[],
    onLine: NonNullable<ProcessInput["onLine"]>,
  ) => Effect.Effect<{ code: number; stderr: string }, WorkspaceTextSearchError>;
}

export type WorkspaceTextSearchHostInput =
  | { readonly kind: "local"; readonly roots: readonly string[] }
  | {
      readonly kind: "ssh";
      readonly roots: readonly string[];
      readonly config: CodexSshExecutionHostConfig;
      readonly codexHome: string;
    };

export class WorkspaceTextSearchPlatform extends Context.Service<
  WorkspaceTextSearchPlatform,
  {
    readonly open: (
      input: WorkspaceTextSearchHostInput,
    ) => Effect.Effect<WorkspaceTextSearchHost, WorkspaceTextSearchError>;
  }
>()("nodex/main/platform/WorkspaceTextSearchPlatform") {}

/** All children and pipe readers belong to the caller's Effect interruption boundary. */
const runProcess = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  environment: Readonly<Record<string, string | undefined>>,
  input: ProcessInput,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.executable, [...input.args], {
            cwd: input.cwd,
            env: environment,
            extendEnv: false,
            detached: process.platform !== "win32",
            forceKillAfter: Duration.millis(250),
            stdin: {
              stream: input.stdin ? Stream.make(input.stdin) : Stream.empty,
              endOnDone: true,
            },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            textSearchError("search-failed", "Could not start file search", cause),
          ),
        );
      let bytes = 0;
      let stopped = false;
      let stdout = "";
      let stderr = "";
      const bounded = (chunk: Uint8Array) =>
        Effect.suspend(() => {
          bytes += chunk.byteLength;
          return bytes > input.maxBytes
            ? Effect.fail(textSearchError("search-failed", "File search exceeded its output limit"))
            : Effect.void;
        });
      const stdoutStream = child.stdout.pipe(
        Stream.mapError((cause) =>
          textSearchError("search-failed", "Could not read file search output", cause),
        ),
        Stream.tap(bounded),
        Stream.decodeText(),
      );
      const readStdout = input.onLine
        ? stdoutStream.pipe(
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                if (stopped) return;
                if (yield* input.onLine!(line)) return;
                stopped = true;
                yield* child.kill().pipe(Effect.ignore);
              }),
            ),
          )
        : stdoutStream.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stdout += chunk;
              }),
            ),
          );
      const [, , code] = yield* Effect.all(
        [
          readStdout,
          child.stderr.pipe(
            Stream.mapError((cause) =>
              textSearchError("search-failed", "Could not read file search errors", cause),
            ),
            Stream.tap(bounded),
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stderr = (stderr + chunk).slice(0, 65_536);
              }),
            ),
          ),
          child.exitCode.pipe(
            Effect.catchIf(
              () => stopped,
              () => Effect.succeed(0),
            ),
            Effect.mapError((cause) =>
              textSearchError("search-failed", "File search process failed", cause),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout, stderr };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(input.timeoutMs),
      orElse: () => Effect.fail(textSearchError("search-failed", "File search timed out")),
    }),
  );

interface PinnedRipgrep {
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly binarySha256: string;
  readonly binarySize: number;
  readonly target: string;
}

const PINNED_RIPGREP: Readonly<Record<string, PinnedRipgrep>> = {
  "Darwin-arm64": {
    archiveSha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
    archiveSize: 1764284,
    binarySha256: "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
    binarySize: 4014576,
    target: "aarch64-apple-darwin",
  },
  "Darwin-x86_64": {
    archiveSha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
    archiveSize: 1878284,
    binarySha256: "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
    binarySize: 4387000,
    target: "x86_64-apple-darwin",
  },
  "Linux-arm64": {
    archiveSha256: "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
    archiveSize: 1854661,
    binarySha256: "e36d0eb52e70696bdf1781392722e05a21bb91d3b7b762ef5ec20e5df2ec687b",
    binarySize: 4506992,
    target: "aarch64-unknown-linux-gnu",
  },
  "Linux-x86_64": {
    archiveSha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
    archiveSize: 2265718,
    binarySha256: "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
    binarySize: 5408904,
    target: "x86_64-unknown-linux-musl",
  },
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unzip = promisify(gunzip);

/** Extract exactly the verified regular executable; never materialize archive paths. */
export async function decodePinnedRipgrepArchive(
  archive: Uint8Array,
  pin: PinnedRipgrep,
): Promise<Uint8Array> {
  if (archive.byteLength !== pin.archiveSize || digest(archive) !== pin.archiveSha256)
    throw new Error("File search archive verification failed");
  const tar = await unzip(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const target = `ripgrep-15.2.0-${pin.target}/rg`;
  let binary: Buffer | null = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").split("\0", 1)[0];
    if (!name) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim(),
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("Invalid file search archive");
    if (name === target) {
      if (binary || (header[156] !== 0 && header[156] !== 48))
        throw new Error("File search archive executable is not a regular file");
      binary = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary || binary.byteLength !== pin.binarySize || digest(binary) !== pin.binarySha256)
    throw new Error("File search executable verification failed");
  return binary;
}

const downloadRipgrep = (pin: PinnedRipgrep) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-${pin.target}.tar.gz`,
        { signal },
      );
      if (!response.ok || !response.body) throw new Error("Could not download file search");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > pin.archiveSize)
          throw new Error("File search archive exceeded its pinned size");
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      return decodePinnedRipgrepArchive(Buffer.concat(chunks), pin);
    },
    catch: (cause) =>
      textSearchError(
        "missing-ripgrep",
        "Could not prepare file search on the connected machine",
        cause,
      ),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(120),
      orElse: () =>
        Effect.fail(textSearchError("missing-ripgrep", "Preparing file search timed out")),
    }),
  );

const FIND_TRUSTED_RG = `set -ef
for root do
  case "$root" in /*) ;; *) exit 2 ;; esac
  root=$(CDPATH= cd -P "$root" && printf '%s/' "\${PWD%/}") || exit 2
  shift; set -- "$@" "$root"
done
IFS=:
for directory in $PATH; do
  case "$directory" in /*) ;; *) continue ;; esac
  directory=$(CDPATH= cd -P "$directory" 2>/dev/null && printf '%s/' "\${PWD%/}") || continue
  for root do case "$directory" in "$root"*) continue 2 ;; esac; done
  candidate="\${directory}rg"
  if test -f "$candidate" && test ! -L "$candidate" && test -x "$candidate"; then printf '%s\\n' "$candidate"; exit 0; fi
done
exit 1`;

const SYSTEM_SHELL = "set -eu; PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; ";

export const live: Layer.Layer<WorkspaceTextSearchPlatform, never, MainConfig | CodexPlatform> =
  Layer.effect(
    WorkspaceTextSearchPlatform,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const codex = yield* CodexPlatform;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = {
        ...config.environment,
        PATH: config.environmentPath ?? config.environment.PATH,
      };
      const execute = (input: ProcessInput) => runProcess(spawner, environment, input);
      const open = Effect.fn("WorkspaceTextSearchPlatform.open")(function* (
        input: WorkspaceTextSearchHostInput,
      ) {
        if (input.kind === "local") {
          const executable = yield* Effect.tryPromise({
            try: async () => {
              for (const directory of codex.runtime.additionalSearchPaths) {
                const candidate = path.join(
                  directory,
                  config.platform === "win32" ? "rg.exe" : "rg",
                );
                if (
                  await access(candidate).then(
                    () => true,
                    () => false,
                  )
                )
                  return candidate;
              }
              throw new Error("Bundled ripgrep is unavailable");
            },
            catch: (cause) =>
              textSearchError("missing-ripgrep", "File search runtime is unavailable", cause),
          });
          return {
            platform: config.platform === "win32" ? ("win32" as const) : ("posix" as const),
            executable,
            readDirectory: (directory: string) =>
              Effect.tryPromise({
                try: () => readdir(directory),
                catch: (cause) =>
                  textSearchError("search-failed", "Could not inspect search folders", cause),
              }),
            search: (
              root: string,
              args: readonly string[],
              onLine: NonNullable<ProcessInput["onLine"]>,
            ) =>
              execute({
                executable,
                args,
                cwd: root,
                onLine,
                maxBytes: 128 * 1024 * 1024,
                timeoutMs: 30_000,
              }),
          };
        }
        const ssh = (
          args: readonly string[],
          options: Partial<Pick<ProcessInput, "stdin" | "maxBytes" | "timeoutMs" | "onLine">> = {},
        ) =>
          execute({
            executable: "ssh",
            args: buildCodexSshArguments(input.config, args),
            maxBytes: 4096,
            timeoutMs: 10_000,
            ...options,
          });
        const shell = (
          script: string,
          args: readonly string[] = [],
          stdin?: Uint8Array,
          maxBytes = 4096,
        ) => ssh(["/bin/sh", "-c", SYSTEM_SHELL + script, "sh", ...args], { stdin, maxBytes });
        const health = yield* shell("uname -s; uname -m");
        if (health.code !== 0)
          return yield* textSearchError(
            "unsupported-host",
            "Text search requires a POSIX connected machine",
          );
        const [os, rawArch] = health.stdout.trim().split(/\r?\n/u);
        const arch = rawArch === "aarch64" ? "arm64" : rawArch;
        if (os !== "Darwin" && os !== "Linux")
          return yield* textSearchError(
            "unsupported-host",
            "Text search is not supported on this connected machine",
          );
        const trusted = yield* ssh(["/bin/sh", "-c", FIND_TRUSTED_RG, "sh", ...input.roots]);
        let executable = trusted.code === 0 ? trusted.stdout.trim() : "";
        if (trusted.code !== 0 && trusted.code !== 1)
          return yield* textSearchError(
            "search-failed",
            "Could not inspect the connected search roots",
          );
        if (!executable) {
          const pin = PINNED_RIPGREP[`${os}-${arch}`];
          if (!pin || !path.posix.isAbsolute(input.codexHome))
            return yield* textSearchError(
              "unsupported-host",
              "Text search is not supported on this connected machine",
            );
          const directory = path.posix.join(input.codexHome, "file-search-runtimes");
          executable = path.posix.join(directory, `rg-${pin.binarySha256}`);
          const check = yield* shell(
            'test -f "$1"; test ! -L "$1"; test "$(wc -c < "$1" | tr -d " ")" = "$2"; if command -v sha256sum >/dev/null 2>&1; then digest=$(sha256sum < "$1"); else digest=$(shasum -a 256 < "$1"); fi; test "${digest%% *}" = "$3"; chmod 500 "$1"',
            [executable, String(pin.binarySize), pin.binarySha256],
          );
          if (check.code !== 0) {
            const binary = yield* downloadRipgrep(pin);
            const temporary = path.posix.join(directory, `.install-${randomUUID()}`);
            const installed = yield* shell(
              'umask 077; mkdir -p "$1"; test ! -L "$1"; chmod 700 "$1"; mkdir "$2"; trap \'rm -rf "$2"\' EXIT HUP INT TERM; cat > "$2/rg"; test "$(wc -c < "$2/rg" | tr -d " ")" = "$4"; if command -v sha256sum >/dev/null 2>&1; then digest=$(sha256sum < "$2/rg"); else digest=$(shasum -a 256 < "$2/rg"); fi; test "${digest%% *}" = "$5"; chmod 500 "$2/rg"; test ! -d "$3"; mv -f "$2/rg" "$3"; "$3" --version',
              [directory, temporary, executable, String(pin.binarySize), pin.binarySha256],
              binary,
            );
            if (installed.code !== 0)
              return yield* textSearchError(
                "missing-ripgrep",
                "Could not run file search on the connected machine",
              );
          }
        }
        if (!path.posix.isAbsolute(executable) || /[\r\n\0]/u.test(executable))
          return yield* textSearchError(
            "missing-ripgrep",
            "Connected file search returned an invalid executable",
          );
        return {
          platform: "posix" as const,
          executable,
          readDirectory: (directory: string) =>
            shell(
              'for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do test -e "$child" || test -L "$child" || continue; printf "%s\\0" "${child##*/}"; done',
              [directory],
              undefined,
              128 * 1024,
            ).pipe(
              Effect.flatMap((result) =>
                result.code === 0
                  ? Effect.succeed(result.stdout.split("\0").filter(Boolean))
                  : Effect.fail(
                      textSearchError(
                        "search-failed",
                        "Could not inspect connected search folders",
                      ),
                    ),
              ),
            ),
          search: (
            root: string,
            args: readonly string[],
            onLine: NonNullable<ProcessInput["onLine"]>,
          ) =>
            ssh(
              [
                "/bin/sh",
                "-c",
                'cd "$1" || exit; shift; exec "$@"',
                "sh",
                root,
                executable,
                ...args,
              ],
              { onLine, maxBytes: 128 * 1024 * 1024, timeoutMs: 30_000 },
            ),
        };
      });
      return WorkspaceTextSearchPlatform.of({ open });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
