/* @effect-diagnostics asyncFunction:off -- Node stdio and process teardown cross the Effect boundary here. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import type { MainConfigValue } from "../../app/MainConfig";
import type { ReadVisualSource } from "../../visual/VisualSources";
import type {
  VisualJob,
  VisualWorkerInput,
  VisualWorkerOutput,
} from "../../visual/VisualWorkerProtocol";

/** The worker gets only system launch variables, never Profile or Agent credentials. */
const keepEnvironment = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  "USERPROFILE",
  "HOME",
]);

function launch(config: MainConfigValue): ChildProcessWithoutNullStreams {
  const environment = Object.fromEntries(
    Object.entries(config.environment).filter(([key]) => keepEnvironment.has(key.toUpperCase())),
  );
  const linuxHeadless =
    config.platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY;
  const args = [
    ...(config.isPackaged ? [] : [join(config.projectRootPath, "out/main/bootstrap.js")]),
    "--nodex-visual-worker",
    "--disable-gpu",
    ...(config.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
  ];
  const executable = linuxHeadless ? "xvfb-run" : config.runtimeBinaryPath;
  const argv = linuxHeadless
    ? [
        "-a",
        "-s",
        "-screen 0 1280x1024x24 -nolisten tcp",
        config.runtimeBinaryPath,
        ...args,
        "--ozone-platform=x11",
        "--disable-dev-shm-usage",
      ]
    : args;
  return spawn(executable, argv, { env: environment, windowsHide: true });
}

export const renderVisualJob = Effect.fn("VisualWorker.render")(function* (
  config: MainConfigValue,
  job: VisualJob,
  read: ReadVisualSource,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => launch(config),
          catch: () => new Error("Visual worker is unavailable"),
        }),
        (child) =>
          Effect.sync(() => {
            child.stdin.destroy();
            child.kill();
          }),
      );
      child.stderr.resume();
      child.on("error", () => child.stdout.destroy());
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const received = lines[Symbol.asyncIterator]();
      yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()));
      const send = (message: VisualWorkerInput) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              child.stdin.write(JSON.stringify(message) + "\n", (error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
          catch: () => new Error("The offline Visual worker could not receive this job"),
        });
      yield* send({ kind: "render", job });
      for (;;) {
        const message = yield* Effect.tryPromise({
          try: async () => {
            const line = await received.next();
            if (line.done || line.value.length > 32 * 1024 * 1024)
              throw new Error("Missing Visual worker result");
            return JSON.parse(line.value) as VisualWorkerOutput;
          },
          catch: () => new Error("The offline Visual worker exited before responding"),
        });
        if (message.kind === "result") return message.result;
        if (message.kind === "error") return yield* Effect.fail(new Error(message.message));
        const content = yield* read(message.reference).pipe(Effect.orElseSucceed(() => null));
        yield* send({ kind: "source", content });
      }
    }).pipe(Effect.timeout("45 seconds")),
  );
});
