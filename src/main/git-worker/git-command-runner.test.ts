import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect } from "vite-plus/test";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import { GitCommandPlatform, type GitCommandProcessResult } from "./git-command-platform";
import {
  isGitReadCommand,
  makeGitCommandRunner,
  type GitCommandRunner,
  type GitRepositoryExecutionIdentity,
} from "./git-command-runner";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<GitRepositoryExecutionIdentity> {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-git-runner-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-q", root]);
  const commonDir = (
    await execFileAsync("git", ["-C", root, "rev-parse", "--git-common-dir"])
  ).stdout.trim();
  return {
    hostId: "local",
    root,
    commonDir: path.resolve(root, commonDir),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const withRunner = <A>(run: (runner: GitCommandRunner) => Promise<A>) =>
  makeGitCommandRunner({ environment: process.env }).pipe(
    Effect.flatMap((runner) => Effect.promise(() => run(runner))),
    // the helper owns a fresh test application Scope.
    Effect.provide(GitCommandPlatformNode.nodeLive),
  );

const processResult = (code = 0): GitCommandProcessResult => ({
  code,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  failureReason: null,
});

describe("GitCommandRunner", () => {
  it.live("runs with non-interactive, stable, no-optional-locks Git policy", () =>
    withRunner(async (runner) => {
      const repository = await createRepository();
      const result = await runner.run(repository, ["nodex-env"], {
        configOverrides: [
          'alias.nodex-env=!test "$GIT_OPTIONAL_LOCKS" = 0' +
            ' && test "$GIT_TERMINAL_PROMPT" = 0' +
            ' && test "$LC_MESSAGES" = C' +
            ' && test "$LANGUAGE" = C',
        ],
      });

      expect(result).toMatchObject({
        success: true,
        code: 0,
        failureReason: null,
        timedOut: false,
      });
    }),
  );

  it.live("returns timeout as structured data without fabricating exit code zero", () =>
    withRunner(async (runner) => {
      const repository = await createRepository();
      const result = await runner.run(repository, ["nodex-sleep"], {
        configOverrides: ["alias.nodex-sleep=!sleep 1"],
        timeoutMs: 20,
      });

      expect(result).toMatchObject({
        success: false,
        code: null,
        failureReason: "timed_out",
        timedOut: true,
        aborted: false,
      });
    }),
  );

  it.live("distinguishes cancellation and output limits", () =>
    withRunner(async (runner) => {
      const repository = await createRepository();
      const controller = new AbortController();
      const canceled = runner.run(repository, ["nodex-sleep"], {
        configOverrides: ["alias.nodex-sleep=!sleep 1"],
        signal: controller.signal,
      });
      controller.abort();

      await expect(canceled).resolves.toMatchObject({
        success: false,
        failureReason: "canceled",
        aborted: true,
        timedOut: false,
      });

      const capped = await runner.run(repository, ["nodex-output"], {
        configOverrides: ["alias.nodex-output=!yes x | head -c 4096"],
        outputBytesCap: 256,
      });
      expect(capped).toMatchObject({
        success: false,
        failureReason: "output_limit",
        outputLimitExceeded: true,
      });
      expect(capped.stdoutBytes + capped.stderrBytes).toBeGreaterThan(256);
      expect(Buffer.byteLength(capped.stdout)).toBe(256);
    }),
  );

  it.live("streams binary stdout verbatim and retains the exact bounded prefix", () =>
    withRunner(async (runner) => {
      const repository = await createRepository();
      const binary = Buffer.from([0xff, 0x00, 0x61]);
      const object = await runner.run(repository, ["hash-object", "-w", "--stdin"], {
        stdin: binary,
      });
      expect(object.success).toBe(true);

      const chunks: Buffer[] = [];
      const streamed = await runner.run(repository, ["cat-file", "--batch"], {
        stdin: `${object.stdout.trim()}\n`,
        stdoutStream: {
          maxBytes: null,
          onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
        },
      });
      const output = Buffer.concat(chunks);
      expect(streamed).toMatchObject({ success: true, stdout: "", failureReason: null });
      expect(output.subarray(-4)).toEqual(Buffer.from([0xff, 0x00, 0x61, 0x0a]));

      const cappedChunks: Buffer[] = [];
      const cap = output.byteLength - 2;
      const capped = await runner.run(repository, ["cat-file", "--batch"], {
        stdin: `${object.stdout.trim()}\n`,
        stdoutStream: {
          maxBytes: cap,
          onChunk: (chunk) => cappedChunks.push(Buffer.from(chunk)),
        },
      });
      expect(capped).toMatchObject({
        success: false,
        failureReason: "output_limit",
        outputLimitExceeded: true,
      });
      expect(Buffer.concat(cappedChunks)).toEqual(output.subarray(0, cap));
      expect(capped.stdoutBytes).toBeGreaterThan(cap);
    }),
  );

  it.effect("serializes one repository while allowing another to run", () =>
    Effect.gen(function* () {
      const firstGate = yield* Deferred.make<void>();
      const otherGate = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const otherStarted = yield* Deferred.make<void>();
      const starts: string[] = [];
      const platform = GitCommandPlatform.of({
        run: (input) => {
          const operation = input.args.at(-1);
          if (operation === "first") {
            return Effect.sync(() => starts.push("first")).pipe(
              Effect.andThen(Deferred.succeed(firstStarted, undefined)),
              Effect.andThen(Deferred.await(firstGate)),
              Effect.as(processResult()),
            );
          }
          if (operation === "other") {
            return Effect.sync(() => starts.push("other")).pipe(
              Effect.andThen(Deferred.succeed(otherStarted, undefined)),
              Effect.andThen(Deferred.await(otherGate)),
              Effect.as(processResult()),
            );
          }
          if (operation === "second") {
            return Effect.sync(() => starts.push("second")).pipe(Effect.as(processResult()));
          }
          return Effect.succeed(processResult(1));
        },
      });
      const runner = yield* makeGitCommandRunner({ environment: {} }).pipe(
        Effect.provideService(GitCommandPlatform, platform),
      );
      const repositoryA = { hostId: "local" as const, root: "/a", commonDir: "/a/.git" };
      const repositoryB = { hostId: "local" as const, root: "/b", commonDir: "/b/.git" };

      const first = runner.run(repositoryA, ["first"]);
      const second = runner.run(repositoryA, ["second"]);
      const other = runner.run(repositoryB, ["other"]);
      yield* Deferred.await(firstStarted);
      yield* Deferred.await(otherStarted);
      expect(starts).toEqual(["first", "other"]);

      yield* Deferred.succeed(firstGate, undefined);
      yield* Effect.promise(() => first);
      yield* Effect.promise(() => second);
      expect(starts).toEqual(["first", "other", "second"]);
      yield* Deferred.succeed(otherGate, undefined);
      yield* Effect.promise(() => other);
    }),
  );

  it.effect("interrupts queued and active commands with caller and owner Scope", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.Scope;
      const runnerScope = yield* Scope.fork(parentScope);
      const activeStarted = yield* Deferred.make<void>();
      const activeInterrupted = yield* Deferred.make<void>();
      const starts: string[] = [];
      const platform = GitCommandPlatform.of({
        run: (input) => {
          const operation = input.args.at(-1);
          if (operation === "active") {
            return Effect.sync(() => starts.push("active")).pipe(
              Effect.andThen(Deferred.succeed(activeStarted, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(activeInterrupted, undefined)),
            );
          }
          if (operation === "queued") {
            return Effect.sync(() => starts.push("queued")).pipe(Effect.as(processResult()));
          }
          return Effect.succeed(processResult(1));
        },
      });
      const runner = yield* makeGitCommandRunner({ environment: {} }).pipe(
        Effect.provideService(GitCommandPlatform, platform),
        Scope.provide(runnerScope),
      );
      const repository = { hostId: "local" as const, root: "/a", commonDir: "/a/.git" };
      const active = runner.run(repository, ["active"]);
      yield* Deferred.await(activeStarted);
      const controller = new AbortController();
      const queued = runner.run(repository, ["queued"], { signal: controller.signal });
      controller.abort();

      yield* Effect.promise(() =>
        expect(queued).resolves.toMatchObject({ failureReason: "canceled", aborted: true }),
      );
      expect(starts).toEqual(["active"]);

      yield* Scope.close(runnerScope, Exit.void);
      yield* Deferred.await(activeInterrupted);
      yield* Effect.promise(() => expect(active).rejects.toBeDefined());
      expect(starts).toEqual(["active"]);
    }),
  );

  it("classifies only bounded background reads for the default timeout", () => {
    expect(isGitReadCommand(["status", "--porcelain=v1"])).toBe(true);
    expect(isGitReadCommand(["cat-file", "-e", "HEAD:file"])).toBe(true);
    expect(isGitReadCommand(["ls-files", "--others"])).toBe(true);
    expect(isGitReadCommand(["ls-files", "--cached"])).toBe(false);
    expect(isGitReadCommand(["diff", "--no-ext-diff"])).toBe(false);
    expect(isGitReadCommand(["apply", "patch.diff"])).toBe(false);
  });

  it.live("rejects global options outside the typed config override seam", () =>
    withRunner(async (runner) => {
      const repository = await createRepository();
      await expect(
        runner.run(repository, ["-c", "core.fsmonitor=false", "status"]),
      ).rejects.toThrow("must begin with a subcommand");
    }),
  );
});
