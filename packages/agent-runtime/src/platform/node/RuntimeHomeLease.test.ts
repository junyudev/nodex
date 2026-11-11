// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import { acquire } from "./RuntimeHomeLease.ts";

it.live("refuses malformed ownership and never removes a different owner's token", () =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "nodex-writer-token-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    );
    const lock = path.join(home, ".writer.lock");
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* acquire(home);
        const directoryMode = (yield* Effect.promise(() => fs.stat(lock))).mode & 0o777;
        const ownerMode =
          (yield* Effect.promise(() => fs.stat(path.join(lock, "owner.json")))).mode & 0o777;
        expect(directoryMode).toBe(0o700);
        expect(ownerMode).toBe(0o600);
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(lock, "owner.json"),
            JSON.stringify({ pid: process.pid, token: "replacement" }),
          ),
        );
      }),
    );
    expect(
      JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(lock, "owner.json"), "utf8"))),
    ).toEqual({ pid: process.pid, token: "replacement" });
    yield* Effect.promise(() => fs.writeFile(path.join(lock, "owner.json"), "{}"));
    expect((yield* Effect.scoped(acquire(home)).pipe(Effect.flip)).message).toContain("malformed");
    expect(yield* Effect.promise(() => fs.readFile(path.join(lock, "owner.json"), "utf8"))).toBe(
      "{}",
    );
  }),
);

it.effect("reports a live writer without leaking its lease token or arguments", () =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "nodex-writer-conflict-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    );
    yield* acquire(home);
    const owner = JSON.parse(
      yield* Effect.promise(() =>
        fs.readFile(path.join(home, ".writer.lock", "owner.json"), "utf8"),
      ),
    );
    const delays: number[] = [];
    const clock = yield* Clock.Clock;
    const error = yield* Effect.scoped(acquire(home)).pipe(
      Effect.provideService(Clock.Clock, {
        ...clock,
        sleep: (delay) =>
          Effect.sync(() => {
            delays.push(Duration.toMillis(delay));
          }),
      }),
      Effect.flip,
    );
    expect(delays).toEqual([100, 200, 400, 800, 1600]);
    expect(error.conflict).toMatchObject({
      pid: process.pid,
      alive: true,
      startedAt: expect.stringMatching(/^[0-9]{4}-/u),
      executable: process.execPath,
      heldMs: expect.any(Number),
    });
    expect(error.message).toContain(home);
    expect(error.message).toContain("Agent Runtime");
    expect(error.message).not.toContain(owner.token);
  }),
);

it.effect("acquires the lease when the previous writer releases it during backoff", () =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "nodex-writer-restart-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    );
    const previous = yield* Scope.fork(yield* Effect.scope);
    yield* acquire(home).pipe(Effect.provideService(Scope.Scope, previous));
    const ownerPath = path.join(home, ".writer.lock", "owner.json");
    const read = () => Effect.promise(() => fs.readFile(ownerPath, "utf8"));
    const previousOwner = yield* read();

    const clock = yield* Clock.Clock;
    yield* acquire(home).pipe(
      Effect.provideService(Clock.Clock, {
        ...clock,
        sleep: () => Scope.close(previous, Exit.void),
      }),
    );
    expect(yield* read()).not.toBe(previousOwner);
  }),
);
