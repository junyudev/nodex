import { mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app, protocol } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { VISUAL_SCHEME, VISUAL_SCHEME_PRIVILEGES } from "../../shared/visual/bridge";
import { VISUAL_LIMITS } from "../../shared/visual/contract";
import { runMain } from "../app/MainEntry";
import type { VisualWorkerInput, VisualWorkerOutput } from "./VisualWorkerProtocol";

/** This process holds only the input job and its derived frames. It never initializes a Profile. */
export function runVisualWorker(): void {
  const temporary = mkdtempSync(join(tmpdir(), "nodex-visual-"));
  app.setPath("userData", temporary);
  app.setPath("sessionData", temporary);
  app.setPath("logs", temporary);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  protocol.registerSchemesAsPrivileged([
    { scheme: VISUAL_SCHEME, privileges: VISUAL_SCHEME_PRIVILEGES },
  ]);
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => {
    rmSync(temporary, { recursive: true, force: true });
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const input = lines[Symbol.asyncIterator]();
  const next = Effect.tryPromise({
    try: async () => {
      const { done, value } = await input.next();
      if (done || value.length > VISUAL_LIMITS.resolvedBytes * 6)
        throw new Error("Visual worker input is unavailable");
      return JSON.parse(value) as VisualWorkerInput;
    },
    catch: (error) => error,
  });
  const send = (message: VisualWorkerOutput) =>
    Effect.tryPromise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(JSON.stringify(message) + "\n", (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
  const program = Effect.gen(function* () {
    yield* Effect.promise(() => app.whenReady());
    app.dock?.hide();
    const first = yield* next;
    if (
      first.kind !== "render" ||
      typeof first.job.source !== "string" ||
      !first.job.appearances.length ||
      first.job.appearances.length > 2 ||
      !first.job.appearances.every((value) => value === "light" || value === "dark")
    )
      return yield* Effect.fail(new Error("Invalid Visual job"));
    const [{ createVisualService }, { resolveVisualSources }] = yield* Effect.promise(() =>
      Promise.all([import("./VisualService"), import("./VisualSources")]),
    );
    const result = yield* createVisualService().check(
      first.job.source,
      ({ program }) =>
        resolveVisualSources(program, (reference) =>
          Effect.gen(function* () {
            yield* send({ kind: "source", reference });
            const response = yield* next;
            if (response.kind !== "source" || !response.content)
              return yield* Effect.fail(new Error("The Page source is unavailable"));
            return response.content;
          }),
        ),
      first.job.appearances,
    );
    yield* send({
      kind: "result",
      result: {
        diagnostics: result.diagnostics,
        captures: result.captures.map(({ appearance, hash, frame, png }) => ({
          appearance,
          hash,
          width: frame.width,
          height: frame.height,
          svg: frame.svg,
          png: Buffer.from(png).toString("base64"),
        })),
      },
    });
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return send({
        kind: "error",
        message: error instanceof Error ? error.message.slice(0, 500) : "Visual worker failed",
      });
    }),
    Effect.ensuring(
      Effect.sync(() => {
        lines.close();
        app.quit();
      }),
    ),
  );
  runMain(program);
}
