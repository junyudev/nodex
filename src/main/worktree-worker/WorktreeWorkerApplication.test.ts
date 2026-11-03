import path from "node:path";
import { createCodexRequestCanceledError } from "../codex/codex-git-command";
import { LocalThreadHandoffPreparationError } from "../codex/codex-local-thread-handoff-git";
import { WindowsProcessTreeReleaseError } from "../process-tree";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { executeCodexWorktreeWorkerOperation } from "../codex/codex-worktree-worker-operation";
import { CodexWorktreeShellReleaseError } from "../codex/codex-worktree-shell-environment";
import type { CodexWorktreeWorkerSuccess } from "../codex/codex-worktree-worker-protocol";
import type { CodexWorktreeWorkerThreadMessage } from "./worktree-worker-protocol";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  createCodexWorktreeWorkerRequestMessage,
} from "./worktree-worker-protocol";
import {
  runWorktreeWorkerApplication,
  type WorktreeWorkerTransport,
} from "./WorktreeWorkerApplication";

vi.mock("../codex/codex-worktree-worker-operation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../codex/codex-worktree-worker-operation")>();
  return {
    ...actual,
    executeCodexWorktreeWorkerOperation: vi.fn(actual.executeCodexWorktreeWorkerOperation),
  };
});

function releaseGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

for (const [failureKind, interrupted] of [
  ["canceled", true],
  ["shell-release", true],
  ["git-release", true],
  ["operation", true],
  ["handoff-restored", true],
  ["handoff-uncertain", true],
  ["shell-release", false],
  ["git-release", false],
  ["operation", false],
] as const) {
  it.effect(
    `reports ${failureKind} after ${interrupted ? "interrupted" : "active"} operations drain`,
    () =>
      Effect.gen(function* () {
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof import("../codex/codex-worktree-worker-operation")>(
            "../codex/codex-worktree-worker-operation",
          ),
        );
        const ready = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const aborted = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const gate = releaseGate();
        const messages: CodexWorktreeWorkerThreadMessage[] = [];
        let listener: ((message: unknown) => void) | null = null;
        let closed = 0;
        let unsubscribed = 0;
        let application: Fiber.Fiber<void, unknown> | undefined;
        let operationSignal: AbortSignal | undefined;
        const cancellation = createCodexRequestCanceledError();
        const nativeFailure = new Error("Native handles did not become signaled");
        const releaseFailure = new CodexWorktreeShellReleaseError(
          "setup",
          "owned-temporary-scripts",
          [cancellation, nativeFailure],
        );
        const failure =
          failureKind === "canceled"
            ? cancellation
            : failureKind === "shell-release"
              ? releaseFailure
              : failureKind === "git-release"
                ? new WindowsProcessTreeReleaseError(1234, nativeFailure)
                : failureKind === "operation"
                  ? new Error("Git operation failed while canceled")
                  : new LocalThreadHandoffPreparationError(
                      new Error("Could not restore the source checkout"),
                      failureKind === "handoff-restored",
                    );
        const operation =
          failure instanceof LocalThreadHandoffPreparationError ? "prepare-handoff" : "git-root";
        try {
          vi.mocked(executeCodexWorktreeWorkerOperation).mockImplementationOnce(
            (_request, options) =>
              new Promise<CodexWorktreeWorkerSuccess>((_resolve, reject) => {
                operationSignal = options.signal;
                const complete = (): void => {
                  void gate.promise.then(() => reject(failure), reject);
                };
                if (interrupted) {
                  options.signal.addEventListener(
                    "abort",
                    () => {
                      Deferred.doneUnsafe(aborted, Effect.void);
                      complete();
                    },
                    { once: true },
                  );
                } else complete();
                Deferred.doneUnsafe(started, Effect.void);
              }),
          );
          const transport: WorktreeWorkerTransport = {
            post: (message) => {
              messages.push(message);
              if (message.type === "ready") Deferred.doneUnsafe(ready, Effect.void);
              if (message.type === "result") Deferred.doneUnsafe(terminal, Effect.void);
            },
            close: () => {
              closed += 1;
            },
            subscribe: (next) => {
              listener = next;
              return () => {
                listener = null;
                unsubscribed += 1;
              };
            },
          };
          application = yield* Effect.forkChild(
            runWorktreeWorkerApplication({ epoch: 3, hostId: "local", transport }),
          );
          yield* Deferred.await(ready);
          yield* Effect.sync(() =>
            listener!(
              createCodexWorktreeWorkerRequestMessage({
                id: "owned-request",
                request:
                  operation === "git-root"
                    ? {
                        operation,
                        input: { requestId: "owned-request", hostId: "local", cwd: process.cwd() },
                      }
                    : {
                        operation,
                        input: {
                          requestId: "owned-request",
                          hostId: "local",
                          managedRoot: process.cwd(),
                          allocatedWorktreePath: path.join(process.cwd(), "owned-handoff"),
                          nodexHome: process.cwd(),
                          projectId: "project",
                          threadId: "thread",
                          threadTitle: "Owned handoff",
                          sourceCwd: process.cwd(),
                          sourceWorkspaceRoot: process.cwd(),
                          sourceManagedWorktreePath: null,
                          destinationCheckoutRoot: null,
                        },
                      },
              }),
            ),
          );
          yield* Deferred.await(started);
          if (interrupted) {
            yield* Effect.sync(() =>
              listener!({
                type: "cancel",
                protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
                id: "owned-request",
                operation,
              }),
            );
            yield* Deferred.await(aborted);
          }
          yield* Effect.yieldNow;
          assert.deepStrictEqual(
            messages.filter((message) => message.type === "result"),
            [],
          );
          if (interrupted) {
            yield* Effect.sync(() =>
              listener!({
                type: "shutdown",
                protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
              }),
            );
            yield* Effect.yieldNow;
            assert.strictEqual(application.pollUnsafe(), undefined);
            assert.strictEqual(closed, 0);
          }
          gate.resolve();
          yield* Deferred.await(terminal);
          assert.strictEqual(operationSignal?.aborted, interrupted);
          if (!interrupted) {
            yield* Effect.sync(() =>
              listener!({
                type: "shutdown",
                protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
              }),
            );
          }
          yield* Fiber.join(application);
          const results = messages.filter((message) => message.type === "result");
          assert.strictEqual(results.length, 1);
          const result = results[0]!;
          assert.strictEqual(result.id, "owned-request");
          assert.strictEqual(result.result.type, "error");
          if (result.result.type !== "error")
            throw new Error("Expected a terminal cancellation outcome");
          assert.strictEqual(
            result.result.code,
            failureKind === "canceled"
              ? "canceled"
              : failureKind === "shell-release" || failureKind === "git-release"
                ? "release-unconfirmed"
                : "operation-failed",
          );
          if (failureKind !== "canceled") assert.include(result.result.message, failure.message);
          if (failure instanceof LocalThreadHandoffPreparationError)
            assert.strictEqual(result.result.preparationRestored, failure.preparationRestored);
          assert.strictEqual(closed, 1);
          assert.strictEqual(unsubscribed, 1);
        } finally {
          gate.resolve();
          if (application) yield* Fiber.interrupt(application);
          vi.mocked(executeCodexWorktreeWorkerOperation)
            .mockReset()
            .mockImplementation(actual.executeCodexWorktreeWorkerOperation);
        }
      }),
  );
}

it.effect("owns transport admission and release with the worker Scope", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    let closeCount = 0;
    let unsubscribeCount = 0;
    let listener: ((message: unknown) => void) | null = null;
    const transport: WorktreeWorkerTransport = {
      close: () => {
        closeCount += 1;
      },
      post: (message) => {
        messages.push(message);
        if (message.type === "ready") {
          listener?.({
            type: "shutdown",
            protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
          });
        }
      },
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
          unsubscribeCount += 1;
        };
      },
    };

    yield* runWorktreeWorkerApplication({ epoch: 3, hostId: "local", transport });

    assert.deepStrictEqual(messages, [
      {
        type: "ready",
        epoch: 3,
        hostId: "local",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      },
    ]);
    assert.strictEqual(unsubscribeCount, 1);
    assert.strictEqual(closeCount, 1);
  }),
);
