import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import { executeCodexWorktreeWorkerOperation } from "../codex/codex-worktree-worker-operation";
import { LocalThreadHandoffPreparationError } from "../codex/codex-local-thread-handoff-git";
import {
  type CodexLocalShellEnvironmentRuntimeError,
  make as makeShellEnvironment,
} from "../codex/CodexLocalShellEnvironmentRuntime";
import type { CodexLocalShellEnvironmentOptions } from "../codex/codex-worktree-shell-environment";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  isCodexWorktreeWorkerHostMessage,
  type CodexWorktreeWorkerHostMessage,
  type CodexWorktreeWorkerThreadMessage,
} from "./worktree-worker-protocol";

export interface WorktreeWorkerTransport {
  readonly close: () => void;
  readonly post: (message: CodexWorktreeWorkerThreadMessage) => void;
  readonly reportCancellation: boolean;
  readonly subscribe: (listener: (message: unknown) => void, onClose: () => void) => () => void;
}

export interface WorktreeWorkerApplicationOptions {
  readonly epoch: number;
  readonly hostId: string;
  readonly shellEnvironment?: CodexLocalShellEnvironmentOptions;
  readonly transport: WorktreeWorkerTransport;
}

export class WorktreeWorkerApplicationError extends Schema.TaggedError<WorktreeWorkerApplicationError>()(
  "WorktreeWorkerApplicationError",
  { cause: Schema.Defect(), message: Schema.String },
) {}

const isInterruptedOnly = (cause: Cause.Cause<never>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

export const runWorktreeWorkerApplication = (
  options: WorktreeWorkerApplicationOptions,
): Effect.Effect<void, WorktreeWorkerApplicationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { transport } = options;
      let closing = false;
      const activeOperations = new Map<string, string>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closing = true;
          activeOperations.clear();
          transport.close();
        }),
      );
      const shellEnvironment = yield* makeShellEnvironment(options.shellEnvironment);
      const loadBaseEnvironment = yield* FiberSet.makeRuntimePromise<
        never,
        NodeJS.ProcessEnv,
        CodexLocalShellEnvironmentRuntimeError
      >();
      const shutdown = yield* Deferred.make<void, WorktreeWorkerApplicationError>();
      const requests = yield* FiberMap.make<string, void>();
      const runRequest = yield* FiberMap.runtime(requests)();
      const runControl = yield* FiberSet.makeRuntime<never, void, never>();
      const fail = (cause: unknown): void => {
        const error = new WorktreeWorkerApplicationError({
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        runControl(Deferred.fail(shutdown, error));
      };
      const canceledResult = (
        message: Extract<CodexWorktreeWorkerHostMessage, { type: "request" }>,
      ): CodexWorktreeWorkerThreadMessage => ({
        type: "result",
        id: message.id,
        operation: message.request.operation,
        result: {
          type: "error",
          code: "canceled",
          message: "Request canceled",
          retryable: true,
        },
      });
      const execute = (message: Extract<CodexWorktreeWorkerHostMessage, { type: "request" }>) =>
        Effect.promise((signal) =>
          executeCodexWorktreeWorkerOperation(message.request, {
            loadBaseEnvironment: () => loadBaseEnvironment(shellEnvironment.load),
            signal,
            onEvent: (event) =>
              transport.post({
                type: "event",
                id: message.id,
                operation: message.request.operation,
                event,
              }),
          }),
        ).pipe(
          Effect.tap((success) =>
            Effect.sync(() =>
              transport.post({
                type: "result",
                id: message.id,
                operation: message.request.operation,
                result: { type: "ok", success },
              }),
            ),
          ),
          Effect.catchCause((cause) => {
            if (isInterruptedOnly(cause)) {
              return options.transport.reportCancellation
                ? Effect.sync(() => transport.post(canceledResult(message)))
                : Effect.void;
            }
            const error = Cause.squash(cause);
            return Effect.sync(() =>
              transport.post({
                type: "result",
                id: message.id,
                operation: message.request.operation,
                result: {
                  type: "error",
                  code: "operation-failed",
                  message: String(error),
                  retryable: true,
                  ...(message.request.operation === "prepare-handoff" &&
                  error instanceof LocalThreadHandoffPreparationError
                    ? { preparationRestored: error.preparationRestored }
                    : {}),
                },
              }),
            );
          }),
          Effect.ensuring(
            Effect.sync(() => {
              activeOperations.delete(message.id);
            }),
          ),
          Effect.asVoid,
        );
      const onMessage = (raw: unknown): void => {
        if (!isCodexWorktreeWorkerHostMessage(raw)) {
          fail(new Error("Worktree worker received an invalid host message"));
          return;
        }
        if (raw.type === "shutdown") {
          if (closing) return;
          closing = true;
          runControl(Deferred.succeed(shutdown, undefined));
          return;
        }
        if (raw.type === "cancel") {
          if (activeOperations.get(raw.id) === raw.operation) {
            runControl(FiberMap.remove(requests, raw.id));
          }
          return;
        }
        if (closing) return;
        if (activeOperations.has(raw.id)) {
          fail(new Error("Worktree worker received a duplicate request id"));
          return;
        }
        if (raw.request.input.hostId !== options.hostId) {
          transport.post({
            type: "result",
            id: raw.id,
            operation: raw.request.operation,
            result: {
              type: "error",
              code: "invalid-request",
              message: "Worktree request does not belong to this execution host",
              retryable: false,
            },
          });
          return;
        }
        activeOperations.set(raw.id, raw.request.operation);
        runRequest(raw.id, execute(raw), { onlyIfMissing: true });
      };
      const onTransportClose = (): void => {
        if (closing) return;
        closing = true;
        runControl(Deferred.succeed(shutdown, undefined));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => transport.subscribe(onMessage, onTransportClose)),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      transport.post({
        type: "ready",
        epoch: options.epoch,
        hostId: options.hostId,
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      });
      yield* Deferred.await(shutdown);
    }),
  );
