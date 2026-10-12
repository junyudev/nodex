import * as Chunk from "effect/Chunk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import path from "node:path";
import {
  BrowserProfileHelperError,
  BrowserProfileHelperPlatform,
  decodeBrowserProfileHelperResponse,
  type BrowserProfileHelper,
  type BrowserProfileHelperOptions,
} from "../../browser/browser-profile-helper-client";

const MAX_HELPER_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const HELPER_TIMEOUT_MS = 30_000;

interface BoundedOutput {
  readonly bytes: number;
  readonly chunks: Chunk.Chunk<Uint8Array>;
}

const helperError = (operation: string, cause: unknown): BrowserProfileHelperError =>
  new BrowserProfileHelperError({ operation, cause });

const makeHelper = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BrowserProfileHelperOptions,
): BrowserProfileHelper => {
  const executablePath = path.resolve(options.executablePath);
  const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;

  return {
    readProfile: (request) => {
      const payload = `${JSON.stringify({
        schemaVersion: 1,
        operation: "read-profile",
        source: request.source,
        profilePath: request.profilePath,
        includeCookies: request.includeCookies,
        includePasswords: request.includePasswords,
        cookieDomainAllowlist: [...(request.cookieDomainAllowlist ?? [])],
      })}\n`;
      const command = ChildProcess.make(executablePath, [], {
        detached: false,
        killSignal: "SIGKILL",
        stderr: "ignore",
        stdin: {
          stream: Stream.make(new TextEncoder().encode(payload)),
          endOnDone: true,
        },
        stdout: "pipe",
        windowsHide: true,
      });
      const run = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(command)
            .pipe(Effect.mapError((cause) => helperError("spawn", cause)));
          const output = yield* handle.stdout.pipe(
            Stream.runFoldEffect(
              (): BoundedOutput => ({ bytes: 0, chunks: Chunk.empty() }),
              (current, chunk) => {
                const bytes = current.bytes + chunk.byteLength;
                return bytes > MAX_HELPER_OUTPUT_BYTES
                  ? Effect.fail(
                      helperError(
                        "read-output",
                        new TypeError("Browser Profile helper response is too large"),
                      ),
                    )
                  : Effect.succeed({
                      bytes,
                      chunks: Chunk.append(current.chunks, chunk),
                    } satisfies BoundedOutput);
              },
            ),
            Effect.mapError((cause) =>
              Schema.is(BrowserProfileHelperError)(cause)
                ? cause
                : helperError("read-output", cause),
            ),
          );
          const exitCode = yield* handle.exitCode.pipe(
            Effect.mapError((cause) => helperError("read-exit", cause)),
          );
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* helperError(
              "exit",
              new Error(`Browser Profile helper exited with code ${exitCode}`),
            );
          }
          return yield* Effect.try({
            try: () =>
              decodeBrowserProfileHelperResponse(
                Buffer.concat(
                  Chunk.toReadonlyArray(output.chunks).map((chunk) => Buffer.from(chunk)),
                  output.bytes,
                ).toString("utf8"),
              ),
            catch: (cause) => helperError("parse-response", cause),
          });
        }),
      );
      return run.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            Effect.fail(helperError("timeout", new Error("Browser Profile helper timed out"))),
        }),
      );
    },
  };
};

export const live: Layer.Layer<
  BrowserProfileHelperPlatform,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  BrowserProfileHelperPlatform,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return BrowserProfileHelperPlatform.of({
      make: (options) => makeHelper(spawner, options),
    });
  }),
);

export const nodeLive: Layer.Layer<BrowserProfileHelperPlatform> = live.pipe(
  Layer.provide(NodeServices.layer),
);
