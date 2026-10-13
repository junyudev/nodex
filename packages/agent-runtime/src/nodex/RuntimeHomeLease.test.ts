// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";
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
