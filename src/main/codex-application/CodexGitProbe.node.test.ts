import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { make } from "./CodexGitProbe";

it.effect("runs bounded Git probes with the immutable Main environment", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const environment = { PATH: "/git-bin", NODEX_PROBE: "1" };
    const probe = make({
      environment,
      command: async (args, cwd, options) => {
        calls.push({ args, cwd, options });
        return { stdout: " /workspace/repo\n", stderr: "" };
      },
    });

    assert.strictEqual(
      yield* probe.readPath(" /workspace/repo ", ["rev-parse", "--show-toplevel"]),
      "/workspace/repo",
    );
    assert.deepEqual(calls, [
      {
        args: ["rev-parse", "--show-toplevel"],
        cwd: "/workspace/repo",
        options: {
          env: environment,
          maxOutputBytes: 256 * 1_024,
          signal: (calls[0] as { options: { signal: AbortSignal } }).options.signal,
          timeoutMs: 8_000,
        },
      },
    ]);
  }),
);

it.effect("distinguishes a non-repository from unrelated Git failures", () =>
  Effect.gen(function* () {
    for (const message of [
      "fatal: not a git repository",
      "fatal: cannot use bare repository",
      "fatal: invalid gitfile format",
      "fatal: no path in gitfile",
      "fatal: invalid gitdir",
    ]) {
      const nonGit = make({
        environment: {},
        command: async () => {
          throw new Error(message);
        },
      });
      assert.isTrue(yield* nonGit.isNonGitWorkspace("/workspace"));
    }
    const unavailable = make({
      environment: {},
      command: async () => {
        throw new Error("spawn git ENOENT");
      },
    });

    assert.isFalse(yield* unavailable.isNonGitWorkspace("/workspace"));
    assert.isNull(yield* unavailable.readPath("/workspace", ["rev-parse", "HEAD"]));
    assert.isNull(yield* unavailable.readPath(" ", ["rev-parse", "HEAD"]));
  }),
);

it.effect("uses the execution-host Git probe for remote workspaces", () =>
  Effect.gen(function* () {
    const calls: Array<{ hostId: string; cwd: string }> = [];
    const probe = make({
      environment: {},
      remoteIsNonGitWorkspace: (hostId, cwd) =>
        Effect.sync(() => {
          calls.push({ hostId, cwd });
          return true;
        }),
    });

    assert.isTrue(yield* probe.isNonGitWorkspaceOnHost("ssh:builder", "/remote/repo"));
    assert.deepEqual(calls, [{ hostId: "ssh:builder", cwd: "/remote/repo" }]);
  }),
);

it.effect("forwards fiber interruption to the Git process adapter", () =>
  Effect.gen(function* () {
    let aborted = false;
    const probe = make({
      environment: {},
      command: (_args, _cwd, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const fiber = yield* Effect.forkChild(probe.readPath("/workspace", ["rev-parse", "HEAD"]));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    assert.isTrue(aborted);
  }),
);
