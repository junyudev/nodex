import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { CodexWorktreeWorkerCreateInput } from "./codex-worktree-worker-protocol";
import { makeCodexRemoteWorktreeWorker } from "./codex-remote-worktree-worker";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  type CodexWorktreeWorkerHostMessage,
} from "../worktree-worker/worktree-worker-protocol";

const createInput = (): CodexWorktreeWorkerCreateInput => ({
  requestId: "request-1",
  hostId: "ssh:devbox",
  repositoryPath: "/repo",
  nodexHome: "/nodex",
  managedRoot: "/nodex/worktrees",
  projectId: "project-1",
  targetId: "pending-1",
  threadTitle: "Implement feature",
  startingState: { type: "branch", branchName: "main" },
  localEnvironmentConfigPath: "/repo/.codex/environments/environment.toml",
  setUpSyncedBranch: true,
  propagateLocalWorkspaceFiles: false,
});

const makeSshChild = (protocolVersion: number = CODEX_WORKTREE_WORKER_PROTOCOL_VERSION) => {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const messages: CodexWorktreeWorkerHostMessage[] = [];
  const forcedSignals: NodeJS.Signals[] = [];
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  child.kill = (signal) => {
    forcedSignals.push(signal);
    finish(null, signal);
    return true;
  };
  let inputBuffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk;
    while (true) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as CodexWorktreeWorkerHostMessage;
      messages.push(message);
      if (message.type === "shutdown") {
        finish(0, null);
        continue;
      }
      if (message.type !== "request") continue;
      child.stdout.write(
        `${JSON.stringify({
          type: "ready",
          epoch: 1,
          hostId: "ssh:devbox",
          protocolVersion,
        })}\n`,
      );
      if (protocolVersion !== CODEX_WORKTREE_WORKER_PROTOCOL_VERSION) continue;
      child.stdout.write(
        `${JSON.stringify({
          type: "event",
          id: message.id,
          operation: "create",
          event: {
            operation: "create",
            type: "path-allocated",
            worktreeGitRoot: "/nodex/worktrees/feature/repo",
            worktreeWorkspaceRoot: "/nodex/worktrees/feature/repo",
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          id: message.id,
          operation: "create",
          result: {
            type: "ok",
            success: {
              operation: "create",
              value: {
                worktreeGitRoot: "/nodex/worktrees/feature/repo",
                worktreeWorkspaceRoot: "/nodex/worktrees/feature/repo",
                setupError: null,
                shellEnvironment: null,
              },
            },
          },
        })}\n`,
      );
    }
  });
  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    forcedSignals,
    messages,
  };
};

it.effect("rejects protocol drift before opening an SSH worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const openWorker = vi.fn(async (): Promise<ChildProcessWithoutNullStreams> => {
        throw new Error("SSH should not open");
      });
      const worker = yield* makeCodexRemoteWorktreeWorker({
        hostId: "ssh:devbox",
        openWorker: () => openWorker(),
      });
      const result = yield* Effect.exit(
        worker.request({ operation: "create", input: createInput() }),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        assert.include(
          String(Cause.squash(result.cause)),
          'Nodex built an invalid worktree "create" request: input.localEnvironmentConfigPath:',
        );
      }
      assert.strictEqual(openWorker.mock.calls.length, 0);
    }),
  ),
);

it.effect("reports both versions when the SSH worker uses a different protocol", () =>
  Effect.gen(function* () {
    const oldVersion = CODEX_WORKTREE_WORKER_PROTOCOL_VERSION - 1;
    const fixture = makeSshChild(oldVersion);
    const scope = yield* Scope.make();
    try {
      const worker = yield* makeCodexRemoteWorktreeWorker({
        hostId: "ssh:devbox",
        openWorker: () => Promise.resolve(fixture.child),
      }).pipe(Scope.provide(scope));
      const result = yield* Effect.exit(
        worker.request({
          operation: "create",
          input: { ...createInput(), localEnvironmentConfigPath: null },
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        assert.include(
          String(Cause.squash(result.cause)),
          `protocol version mismatch (expected ${CODEX_WORKTREE_WORKER_PROTOCOL_VERSION}, received ${oldVersion})`,
        );
      }
    } finally {
      // Retirement cannot confirm a request that never received a terminal result.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void))));
    }
  }),
);

it.effect("frames remote requests and releases the SSH child through its Scope", () =>
  Effect.gen(function* () {
    const fixture = makeSshChild();
    const events: string[] = [];
    const input = {
      ...createInput(),
      threadTitle: "  Implement feature  ",
      startingState: { type: "branch", branchName: "main", onMissing: "create-branch" },
      localEnvironmentConfigPath: null,
    } satisfies CodexWorktreeWorkerCreateInput;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* makeCodexRemoteWorktreeWorker({
          hostId: "ssh:devbox",
          openWorker: () => Promise.resolve(fixture.child),
        });
        return yield* worker.request(
          {
            operation: "create",
            input,
          },
          {
            onEvent: (event) => Effect.sync(() => events.push(event.type)),
          },
        );
      }),
    );

    assert.deepEqual(events, ["path-allocated"]);
    assert.strictEqual(result.setupError, null);
    assert.deepEqual(
      fixture.messages.map((message) => message.type),
      ["request", "shutdown"],
    );
    const sent = fixture.messages[0];
    assert.strictEqual(sent?.type, "request");
    if (sent?.type === "request") assert.deepEqual(sent.request, { operation: "create", input });
    assert.deepEqual(fixture.forcedSignals, []);
  }),
);
