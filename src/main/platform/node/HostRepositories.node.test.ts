/* @effect-diagnostics asyncFunction:off -- Real Git/filesystem admission proves private clone resolution. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { hostRepositories } from "./HostRepositories";

const exec = promisify(execFile);
it.effect("only a verified clone mapping resolves a shared repository into an execution path", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(async () =>
      realpath(await mkdtemp(join(tmpdir(), "nodex-host-repos-"))),
    );
    const coreHome = join(root, "core");
    const clone = join(root, "clone");
    const remote = "https://git.example/acme/repo";
    const input = {
      coreHome,
      executionHome: join(root, "execution"),
      repositories: { [remote]: clone },
      environment: { PATH: process.env.PATH ?? "" },
    };
    yield* Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(coreHome, { mode: 0o700 });
        await mkdir(clone);
        await exec("git", ["init", "-b", "main"], { cwd: clone });
        await exec("git", ["remote", "add", "origin", "git@git.example:acme/repo.git"], {
          cwd: clone,
        });
      });
      const paths = yield* Effect.promise(() => hostRepositories(input));
      expect(yield* paths.resolve([{ kind: "repository", remote, order: 0 }])).toEqual([clone]);
      expect(paths.projectlessRoot).toBe(join(root, "execution/tasks"));
      expect(
        (yield* paths
          .resolve([{ kind: "repository", remote: "https://git.example/other", order: 0 }])
          .pipe(Effect.flip)).message,
      ).toMatch(/Map this repository/u);
      expect(
        (yield* paths.resolve([{ kind: "directory", path: clone, order: 0 }]).pipe(Effect.flip))
          .message,
      ).toMatch(/repository identities/u);
      yield* Effect.promise(async () => {
        await expect(
          hostRepositories({ ...input, repositories: { "https://git.example/acme/other": clone } }),
        ).rejects.toThrow(/does not have/u);
        await expect(
          hostRepositories({ ...input, coreHome: join(clone, "private-core") }),
        ).rejects.toThrow(/disjoint/u);
      });
    }).pipe(Effect.ensuring(Effect.promise(() => rm(root, { force: true, recursive: true }))));
  }),
);
