import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  CodexPromptRailIndexCommandResult,
  CodexPromptRailReveal,
  CodexPromptRailRevealCommandResult,
} from "../../../shared/codex-prompt-rail-history";
import { isValidCodexPromptRailDescendingOffset } from "../../../shared/codex-prompt-rail-history";
import { MainConfig } from "../../app/MainConfig";
import {
  CodexPromptRailHistory,
  type CodexPromptRailHistoryError,
  type CodexPromptRailHistoryUnavailable,
} from "../../codex-application/CodexPromptRailHistory";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export interface CodexPromptRailIpcOptions {
  readonly authorizeSender?: (event: IpcMainInvokeEvent) => boolean;
}

export class CodexPromptRailIpcError extends Schema.TaggedError<CodexPromptRailIpcError>()(
  "CodexPromptRailIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type PromptRailCancelled = {
  readonly status: "cancelled";
  readonly requestId: string;
};

type PromptRailUnavailable = {
  readonly status: "unavailable";
  readonly requestId: string;
  readonly availability: CodexPromptRailHistoryUnavailable["availability"];
};

const requestKey = (event: IpcMainInvokeEvent, requestId: string): string =>
  `${event.sender.id}\u0000${requestId}`;

export const live = (
  options: CodexPromptRailIpcOptions = {},
): Layer.Layer<never, never, CodexPromptRailHistory | ElectronIpc | MainConfig | WindowRuntime> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const history = yield* CodexPromptRailHistory;
      const ipc = yield* ElectronIpc;
      const windows = yield* WindowRuntime;
      const pending = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<void>>());

      const authorize = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () => {
            if (options.authorizeSender) {
              if (!options.authorizeSender(event)) throw new Error("Unauthorized prompt rail");
              return;
            }
            requireTrustedAppRendererSender(event, "Prompt rail history", config.rendererUrl);
            if (!windows.has(event.sender.id)) {
              throw new Error("Prompt rail history requires an active Nodex window");
            }
          },
          catch: (cause) => new CodexPromptRailIpcError({ operation: "authorize-renderer", cause }),
        });

      const validateRequest = (input: {
        readonly requestId: string;
        readonly threadId: string;
        readonly expectedTopologyGeneration: number;
      }) =>
        Effect.try({
          try: () => {
            if (
              input.requestId.length === 0 ||
              input.requestId.length > 128 ||
              input.requestId.trim() !== input.requestId
            ) {
              throw new Error("Prompt rail request identity is invalid");
            }
            if (input.threadId.trim().length === 0) {
              throw new Error("Prompt rail thread identity is invalid");
            }
            if (
              !Number.isSafeInteger(input.expectedTopologyGeneration) ||
              input.expectedTopologyGeneration < 0
            ) {
              throw new Error("Prompt rail topology generation is invalid");
            }
          },
          catch: (cause) => new CodexPromptRailIpcError({ operation: "validate-request", cause }),
        });

      const validateRevealTarget = (
        target: IpcApi["codex:thread:prompt-rail:reveal"]["args"][0]["target"],
      ) =>
        Effect.try({
          try: () => {
            if (
              target.kind === "shell" &&
              !isValidCodexPromptRailDescendingOffset(target.shell.descendingOffset)
            ) {
              throw new Error("Prompt rail shell offset is invalid");
            }
          },
          catch: (cause) => new CodexPromptRailIpcError({ operation: "validate-request", cause }),
        });

      const interruptWhenRendererIsDestroyed = <A, E>(
        event: IpcMainInvokeEvent,
        operation: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.raceFirst(
          operation,
          Effect.callback<never>((resume) => {
            if (event.sender.isDestroyed()) {
              resume(Effect.interrupt);
              return;
            }
            const interrupt = (): void => resume(Effect.interrupt);
            event.sender.once("destroyed", interrupt);
            return Effect.sync(() => event.sender.removeListener("destroyed", interrupt));
          }),
        );

      const runOwned = <A, B>(input: {
        readonly event: IpcMainInvokeEvent;
        readonly requestId: string;
        readonly operation: string;
        readonly task: Effect.Effect<
          A,
          CodexPromptRailHistoryError | CodexPromptRailHistoryUnavailable
        >;
        readonly completed: (value: A) => B;
        /** A semantic commit wins over a concurrent cancel even if task cleanup has not returned. */
        readonly committed?: () => A | undefined;
      }): Effect.Effect<B | PromptRailCancelled | PromptRailUnavailable, CodexPromptRailIpcError> =>
        Effect.gen(function* () {
          const key = requestKey(input.event, input.requestId);
          const cancelled = yield* Deferred.make<void>();
          const registered = yield* Ref.modify(pending, (requests) =>
            HashMap.has(requests, key)
              ? [false, requests]
              : [true, HashMap.set(requests, key, cancelled)],
          );
          if (!registered) {
            return yield* new CodexPromptRailIpcError({
              operation: "register-request",
              cause: new Error("Prompt rail request identity is already active"),
            });
          }

          const task = interruptWhenRendererIsDestroyed(
            input.event,
            input.task.pipe(
              Effect.map(input.completed),
              Effect.catchTag("CodexPromptRailHistoryUnavailable", (cause) =>
                Effect.succeed({
                  status: "unavailable" as const,
                  requestId: input.requestId,
                  availability: cause.availability,
                }),
              ),
              Effect.mapError(
                (cause) => new CodexPromptRailIpcError({ operation: input.operation, cause }),
              ),
            ),
          );
          return yield* Effect.raceFirst(
            task,
            Deferred.await(cancelled).pipe(
              Effect.map(() => {
                const committed = input.committed?.();
                return committed === undefined
                  ? { status: "cancelled" as const, requestId: input.requestId }
                  : input.completed(committed);
              }),
            ),
          ).pipe(
            Effect.ensuring(
              Ref.update(pending, (requests) =>
                Option.match(HashMap.get(requests, key), {
                  onNone: () => requests,
                  onSome: (current) =>
                    current === cancelled ? HashMap.remove(requests, key) : requests,
                }),
              ),
            ),
          );
        });

      yield* ipc.handleControl(
        "codex:thread:prompt-rail:index",
        (
          event,
          request: IpcApi["codex:thread:prompt-rail:index"]["args"][0],
        ): Effect.Effect<CodexPromptRailIndexCommandResult, unknown> =>
          authorize(event).pipe(
            Effect.andThen(validateRequest(request)),
            Effect.andThen(
              runOwned({
                event,
                requestId: request.requestId,
                operation: "load-index",
                task: history.loadIndex(request.threadId, {
                  expectedTopologyGeneration: request.expectedTopologyGeneration,
                  force: request.force,
                }),
                completed: (index): CodexPromptRailIndexCommandResult => ({
                  status: "completed",
                  requestId: request.requestId,
                  expectedTopologyGeneration: request.expectedTopologyGeneration,
                  index,
                }),
              }),
            ),
          ),
      );

      yield* ipc.handleControl(
        "codex:thread:prompt-rail:reveal",
        (
          event,
          request: IpcApi["codex:thread:prompt-rail:reveal"]["args"][0],
        ): Effect.Effect<CodexPromptRailRevealCommandResult, unknown> =>
          authorize(event).pipe(
            Effect.andThen(validateRequest(request)),
            Effect.andThen(validateRevealTarget(request.target)),
            Effect.andThen(
              Effect.suspend(() => {
                let committedReveal: CodexPromptRailReveal | undefined;
                const onCommitted = (reveal: CodexPromptRailReveal): void => {
                  committedReveal = reveal;
                };
                return runOwned({
                  event,
                  requestId: request.requestId,
                  operation: "reveal",
                  task:
                    request.target.kind === "shell"
                      ? history.reveal({
                          requestId: request.requestId,
                          threadId: request.threadId,
                          hostId: request.hostId,
                          generation: request.generation,
                          expectedTopologyGeneration: request.expectedTopologyGeneration,
                          shell: request.target.shell,
                          onCommitted,
                        })
                      : history.revealKnownTurn({
                          requestId: request.requestId,
                          threadId: request.threadId,
                          hostId: request.hostId,
                          generation: request.generation,
                          expectedTopologyGeneration: request.expectedTopologyGeneration,
                          turnId: request.target.turnId,
                          onCommitted,
                        }),
                  completed: (reveal): CodexPromptRailRevealCommandResult => ({
                    status: "completed",
                    requestId: request.requestId,
                    expectedTopologyGeneration: request.expectedTopologyGeneration,
                    reveal,
                  }),
                  committed: () => committedReveal,
                });
              }),
            ),
          ),
      );

      yield* ipc.handleControl(
        "codex:thread:prompt-rail:cancel",
        (event, requestId: IpcApi["codex:thread:prompt-rail:cancel"]["args"][0]) =>
          authorize(event).pipe(
            Effect.andThen(Ref.get(pending)),
            Effect.flatMap((requests) =>
              Option.match(HashMap.get(requests, requestKey(event, requestId)), {
                onNone: () => Effect.succeed(false),
                onSome: (cancelled) => Deferred.succeed(cancelled, undefined).pipe(Effect.as(true)),
              }),
            ),
          ),
      );
    }),
  );
