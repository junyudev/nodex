import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { withCancelableProbeOperation } from "../../../scripts/codex-probe-session";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
};

it.effect(
  "joins asynchronous scenario cleanup before interruption completes",
  () =>
    Effect.gen(function* () {
      const ready = deferred();
      const cleaning = deferred();
      const release = deferred();
      let profileRoot = "";
      let credentialPath = "";
      let socketPath = "";
      let settled = false;
      const running = yield* Effect.forkChild(
        withCancelableProbeOperation((signal) =>
          withCoreScenario({ scenarioId: "agent/cli-workflow" }, async ({ profile }) => {
            profileRoot = profile.runRoot;
            credentialPath = path.join(profile.codexHome, "auth.json");
            socketPath = path.join(profile.nodexHome, "run/core/core.sock");
            await mkdir(profile.codexHome, { recursive: true });
            await writeFile(credentialPath, "synthetic test credential", { mode: 0o600 });
            const aborted = new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            ready.resolve();
            await aborted;
            cleaning.resolve();
            await release.promise;
          }).catch((error: unknown) => {
            ready.reject(error);
            throw error;
          }),
        ),
      );
      try {
        yield* Effect.promise(() => ready.promise);
        expect(existsSync(socketPath)).toBe(true);
        expect(existsSync(credentialPath)).toBe(true);
        const interruption = yield* Effect.forkChild(
          Fiber.interrupt(running).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => cleaning.promise);
        yield* Effect.yieldNow;
        expect(settled).toBe(false);
        expect(existsSync(socketPath)).toBe(true);
        release.resolve();
        yield* Fiber.join(interruption);
        expect(settled).toBe(true);
        expect(existsSync(socketPath)).toBe(false);
        expect(existsSync(credentialPath)).toBe(false);
        expect(existsSync(profileRoot)).toBe(false);
      } finally {
        release.resolve();
        yield* Fiber.interrupt(running);
      }
    }),
  30_000,
);
