import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ServerNotificationParamsByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  buildThreadTitleGenerationPrompt,
  CODEX_THREAD_TITLE_CONFIG,
  CODEX_THREAD_TITLE_MODEL,
  CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
  CODEX_THREAD_TITLE_TIMEOUT_MS,
  parseGeneratedThreadTitleResponse,
} from "../codex/thread-title-generator";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

type ThreadStartParams = ClientRequestParamsByMethod["thread/start"];
type ThreadStartResponse = ClientRequestResponsesByMethod["thread/start"];
type TurnStartParams = ClientRequestParamsByMethod["turn/start"];
type TurnStartResponse = ClientRequestResponsesByMethod["turn/start"];
type TitleNotification =
  | {
      readonly _tag: "Delta";
      readonly params: ServerNotificationParamsByMethod["item/agentMessage/delta"];
    }
  | {
      readonly _tag: "ItemCompleted";
      readonly params: ServerNotificationParamsByMethod["item/completed"];
    }
  | {
      readonly _tag: "TurnError";
      readonly params: ServerNotificationParamsByMethod["error"];
    }
  | {
      readonly _tag: "TurnCompleted";
      readonly params: ServerNotificationParamsByMethod["turn/completed"];
    };

export interface CodexStructuredThreadTitleInput {
  readonly prompt: string;
  readonly cwd: string | null;
  readonly serviceName?: string;
}

export class CodexStructuredThreadTitleError extends Data.TaggedError(
  "CodexStructuredThreadTitleError",
)<{
  readonly reason:
    | "notification-overflow"
    | "output-overflow"
    | "request-failed"
    | "runtime-closed"
    | "timeout"
    | "turn-failed";
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: string;
  readonly threadId?: string;
  readonly turnId?: string;
}> {}

export interface CodexStructuredThreadTitleOptions {
  readonly hostId: string;
  /** Captures the exact Endpoint generation that owns this helper Thread. */
  readonly generation: Effect.Effect<number, CodexStructuredThreadTitleError>;
  readonly events: Stream.Stream<CodexEndpointEvent>;
  readonly startThread: (
    params: ThreadStartParams,
    generation: number,
  ) => Effect.Effect<ThreadStartResponse, CodexStructuredThreadTitleError>;
  readonly startTurn: (
    params: TurnStartParams,
    generation: number,
  ) => Effect.Effect<TurnStartResponse, CodexStructuredThreadTitleError>;
  readonly interruptTurn: (
    threadId: string,
    turnId: string,
    generation: number,
  ) => Effect.Effect<unknown, CodexStructuredThreadTitleError>;
  readonly unsubscribeThread: (
    threadId: string,
    generation: number,
  ) => Effect.Effect<unknown, CodexStructuredThreadTitleError>;
  readonly timeout?: Duration.Input;
}

export class CodexStructuredThreadTitle extends Context.Service<
  CodexStructuredThreadTitle,
  {
    readonly generate: (
      input: CodexStructuredThreadTitleInput,
    ) => Effect.Effect<string | null, CodexStructuredThreadTitleError>;
  }
>()("nodex/main/codex-application/CodexStructuredThreadTitle") {}

/** The structured result is a title, not a general-purpose transcript. */
export const CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES = 16 * 1024;
export const CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_QUEUE_CAPACITY = 32;
export const CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_MAX_BYTES = 64 * 1024;
export const CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_BUFFER_BYTES = 256 * 1024;

interface BufferedTitleNotification {
  readonly approximateBytes: number;
  readonly notification: TitleNotification;
}

interface TitleNotificationBufferState {
  readonly bufferedBytes: number;
  readonly overflowed: boolean;
}

interface TitleNotificationInbox {
  readonly next: Effect.Effect<TitleNotification, CodexStructuredThreadTitleError>;
  readonly offer: (notification: TitleNotification) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

const titleNotification = (
  event: CodexEndpointEvent,
  hostId: string,
  generation: number,
): TitleNotification | null => {
  if (event.kind !== "notification" || event.hostId !== hostId || event.generation !== generation) {
    return null;
  }
  switch (event.value.method) {
    case "item/agentMessage/delta":
      return {
        _tag: "Delta",
        params: event.value.params as ServerNotificationParamsByMethod["item/agentMessage/delta"],
      };
    case "item/completed":
      return {
        _tag: "ItemCompleted",
        params: event.value.params as ServerNotificationParamsByMethod["item/completed"],
      };
    case "error":
      return {
        _tag: "TurnError",
        params: event.value.params as ServerNotificationParamsByMethod["error"],
      };
    case "turn/completed":
      return {
        _tag: "TurnCompleted",
        params: event.value.params as ServerNotificationParamsByMethod["turn/completed"],
      };
    default:
      return null;
  }
};

const titleNotificationThreadId = (notification: TitleNotification): string =>
  notification.params.threadId;

const titleNotificationTurnId = (notification: TitleNotification): string =>
  notification._tag === "TurnCompleted" ? notification.params.turn.id : notification.params.turnId;

/**
 * Counts UTF-8 bytes without allocating a second copy of the generated text. A result greater
 * than `limit` means the title protocol exceeded its semantic output budget.
 */
const cappedUtf8Bytes = (value: string, limit: number): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    const width =
      code < 0x80
        ? 1
        : code < 0x800
          ? 2
          : code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
            ? 4
            : 3;
    if (bytes > limit - width) return limit + 1;
    bytes += width;
    if (width === 4) index += 1;
  }
  return bytes;
};

const requestError = (operation: string, cause: unknown, threadId?: string) =>
  new CodexStructuredThreadTitleError({
    reason: "request-failed",
    message: `Structured thread title ${operation} failed`,
    cause,
    ...(threadId === undefined ? {} : { threadId }),
  });

const notificationOverflowError = (
  threadId: string,
  turnId: string,
  observedBytes: number,
  limit: number,
) =>
  new CodexStructuredThreadTitleError({
    reason: "notification-overflow",
    message: `Structured title notification exceeded its ${limit}-byte admission budget.`,
    threadId,
    turnId,
    cause: { observedBytes, limit },
  });

const outputOverflowError = (threadId: string, turnId: string) =>
  new CodexStructuredThreadTitleError({
    reason: "output-overflow",
    message: `Structured title output exceeded its ${CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES}-byte budget.`,
    threadId,
    turnId,
  });

const terminalError = (
  params: ServerNotificationParamsByMethod["turn/completed"],
  observedError: ServerNotificationParamsByMethod["error"]["error"] | null,
) => {
  const status = params.turn.status;
  const error = params.turn.error ?? observedError;
  const details = [error?.message, error?.additionalDetails]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const prefix =
    status === "failed"
      ? "Structured turn failed"
      : status === "interrupted"
        ? "Structured turn was interrupted"
        : `Structured turn ended with status ${status}`;
  return new CodexStructuredThreadTitleError({
    reason: "turn-failed",
    message: details ? `${prefix}: ${details}` : `${prefix}.`,
    cause: error ?? undefined,
    status,
    threadId: params.threadId,
    turnId: params.turn.id,
  });
};

const textFromCompletedItem = (
  params: ServerNotificationParamsByMethod["item/completed"],
): string | null => {
  if (params.item.type !== "agentMessage") return null;
  return params.item.text;
};

/**
 * The title helper subscribes before `turn/start` returns, so it needs a tiny bounded inbox for
 * the response race. Overflow is terminal: losing a title event would otherwise turn into a
 * misleading title or a hung helper thread.
 */
const makeTitleNotificationInbox = (threadId: string): Effect.Effect<TitleNotificationInbox> =>
  Effect.gen(function* () {
    const notifications = yield* Queue.dropping<BufferedTitleNotification>(
      CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_QUEUE_CAPACITY,
    );
    const state = yield* SynchronizedRef.make<TitleNotificationBufferState>({
      bufferedBytes: 0,
      overflowed: false,
    });
    const overflow = yield* Deferred.make<never, CodexStructuredThreadTitleError>();

    const overflowed = (
      current: TitleNotificationBufferState,
      notification: TitleNotification,
      observedBytes: number,
      limit: number,
    ): Effect.Effect<readonly [undefined, TitleNotificationBufferState]> =>
      Deferred.fail(
        overflow,
        notificationOverflowError(
          threadId,
          titleNotificationTurnId(notification),
          observedBytes,
          limit,
        ),
      ).pipe(
        Effect.as([
          undefined,
          {
            ...current,
            overflowed: true,
          },
        ] as const),
      );

    const offer = (notification: TitleNotification): Effect.Effect<void> => {
      const approximateBytes = cappedApproximateValueBytes(
        notification,
        CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_MAX_BYTES,
      );
      return SynchronizedRef.modifyEffect(state, (current) => {
        if (current.overflowed) return Effect.succeed([undefined, current] as const);
        if (approximateBytes > CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_MAX_BYTES) {
          return overflowed(
            current,
            notification,
            approximateBytes,
            CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_MAX_BYTES,
          );
        }
        if (
          current.bufferedBytes >
          CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_BUFFER_BYTES - approximateBytes
        ) {
          return overflowed(
            current,
            notification,
            current.bufferedBytes + approximateBytes,
            CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_BUFFER_BYTES,
          );
        }
        return Queue.offer(notifications, { approximateBytes, notification }).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.succeed([
                  undefined,
                  {
                    bufferedBytes: current.bufferedBytes + approximateBytes,
                    overflowed: false,
                  },
                ] as const)
              : overflowed(
                  current,
                  notification,
                  current.bufferedBytes + approximateBytes,
                  CODEX_STRUCTURED_THREAD_TITLE_NOTIFICATION_QUEUE_CAPACITY,
                ),
          ),
        );
      });
    };

    const take = Effect.uninterruptibleMask((restore) =>
      restore(Queue.take(notifications)).pipe(
        Effect.flatMap((buffered) =>
          SynchronizedRef.update(state, (current) => ({
            ...current,
            bufferedBytes: Math.max(0, current.bufferedBytes - buffered.approximateBytes),
          })).pipe(Effect.as(buffered.notification)),
        ),
      ),
    );

    return {
      offer,
      next: Effect.raceFirst(take, Deferred.await(overflow)),
      shutdown: Queue.shutdown(notifications).pipe(Effect.asVoid),
    };
  });

export const make = (
  options: CodexStructuredThreadTitleOptions,
): Effect.Effect<
  CodexStructuredThreadTitle["Service"],
  never,
  CodexInternalThreadRegistry | ThreadCreationRuntime | Scope.Scope
> =>
  Effect.gen(function* () {
    const internalThreads = yield* CodexInternalThreadRegistry;
    const threadStarts = yield* ThreadCreationRuntime;
    const closed = yield* Latch.make();
    yield* Effect.addFinalizer(() => closed.open);

    const awaitTitle = (
      threadId: string,
      turnId: string,
      notifications: TitleNotificationInbox,
    ): Effect.Effect<string | null, CodexStructuredThreadTitleError> =>
      Effect.gen(function* () {
        const chunks: string[] = [];
        let outputBytes = 0;
        let observedError: ServerNotificationParamsByMethod["error"]["error"] | null = null;

        for (;;) {
          const notification = yield* notifications.next;
          if (titleNotificationThreadId(notification) !== threadId) continue;
          if (titleNotificationTurnId(notification) !== turnId) continue;

          if (notification._tag === "TurnCompleted") {
            if (notification.params.turn.status !== "completed") {
              return yield* Effect.fail(terminalError(notification.params, observedError));
            }
            return yield* Effect.try({
              try: () =>
                parseGeneratedThreadTitleResponse(chunks.length === 0 ? null : chunks.join("")),
              catch: (cause) => requestError("result parsing", cause, threadId),
            });
          }
          if (notification._tag === "TurnError") {
            observedError = notification.params.error;
            continue;
          }

          const completedText =
            notification._tag === "ItemCompleted"
              ? textFromCompletedItem(notification.params)
              : null;
          const text =
            completedText ?? (notification._tag === "Delta" ? notification.params.delta : null);
          if (text === null) continue;

          const textBytes = cappedUtf8Bytes(
            text,
            completedText === null
              ? CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES - outputBytes
              : CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES,
          );
          if (
            textBytes >
            (completedText === null
              ? CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES - outputBytes
              : CODEX_STRUCTURED_THREAD_TITLE_MAX_OUTPUT_BYTES)
          ) {
            return yield* Effect.fail(outputOverflowError(threadId, turnId));
          }
          if (completedText !== null) {
            chunks.length = 0;
            outputBytes = 0;
          }
          chunks.push(text);
          outputBytes += textBytes;
        }
      });

    const run = (input: CodexStructuredThreadTitleInput) =>
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = buildThreadTitleGenerationPrompt(input.prompt.trim());
          if (!prompt) return null;
          const generation = yield* options.generation;

          const acceptMetadataOnlyThread = (response: ThreadStartResponse) => {
            if (Array.isArray(response.thread.turns) && response.thread.turns.length === 0) {
              return internalThreads.leaseStructuredTitle(response.thread.id);
            }
            return options
              .unsubscribeThread(response.thread.id, generation)
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(
                    requestError(
                      "metadata admission",
                      new Error("Structured title Thread start returned inline history"),
                      response.thread.id,
                    ),
                  ),
                ),
              );
          };

          const thread = yield* Effect.acquireRelease(
            threadStarts.materialize(
              options.hostId,
              generation,
              options
                .startThread(
                  {
                    model: CODEX_THREAD_TITLE_MODEL,
                    modelProvider: null,
                    cwd: input.cwd,
                    approvalPolicy: "never",
                    permissions: ":read-only",
                    runtimeWorkspaceRoots: [],
                    config: CODEX_THREAD_TITLE_CONFIG,
                    personality: null,
                    ephemeral: true,
                    threadSource: "system",
                    experimentalRawEvents: false,
                    dynamicTools: null,
                    serviceTier: null,
                    ...(input.serviceName === undefined ? {} : { serviceName: input.serviceName }),
                  },
                  generation,
                )
                .pipe(Effect.tap(acceptMetadataOnlyThread)),
              (response) => response.thread.id,
            ),
            (response) =>
              options.unsubscribeThread(response.thread.id, generation).pipe(Effect.ignore),
          );
          const threadId = thread.thread.id;
          const targetTurnId = yield* Ref.make<string | null>(null);
          const notifications = yield* makeTitleNotificationInbox(threadId);
          yield* Effect.addFinalizer(() => notifications.shutdown);
          yield* options.events.pipe(
            Stream.runForEach((event) => {
              const notification = titleNotification(event, options.hostId, generation);
              if (notification === null || titleNotificationThreadId(notification) !== threadId) {
                return Effect.void;
              }
              return Ref.get(targetTurnId).pipe(
                Effect.flatMap((expectedTurnId) =>
                  expectedTurnId !== null &&
                  titleNotificationTurnId(notification) !== expectedTurnId
                    ? Effect.void
                    : notifications.offer(notification),
                ),
              );
            }),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;

          const waitForTurn = Effect.acquireUseRelease(
            options
              .startTurn(
                {
                  threadId,
                  clientUserMessageId: randomUUID(),
                  input: [{ type: "text", text: prompt, text_elements: [] }],
                  cwd: null,
                  approvalPolicy: null,
                  permissions: ":read-only",
                  runtimeWorkspaceRoots: [],
                  model: null,
                  effort: null,
                  serviceTier: null,
                  summary: "none",
                  personality: null,
                  outputSchema: CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
                  collaborationMode: null,
                },
                generation,
              )
              .pipe(Effect.tap((response) => Ref.set(targetTurnId, response.turn.id))),
            (response) => awaitTitle(threadId, response.turn.id, notifications),
            (response, exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : options.interruptTurn(threadId, response.turn.id, generation).pipe(Effect.ignore),
          );
          return yield* Effect.raceFirst(
            waitForTurn,
            Effect.sleep(options.timeout ?? CODEX_THREAD_TITLE_TIMEOUT_MS).pipe(
              Effect.andThen(
                Effect.fail(
                  new CodexStructuredThreadTitleError({
                    reason: "timeout",
                    message: "Timed out waiting for structured result.",
                    threadId,
                  }),
                ),
              ),
            ),
          );
        }),
      );

    return CodexStructuredThreadTitle.of({
      generate: (input) =>
        Effect.raceFirst(
          run(input),
          closed.await.pipe(
            Effect.andThen(
              Effect.fail(
                new CodexStructuredThreadTitleError({
                  reason: "runtime-closed",
                  message: "The structured thread title runtime is closing",
                }),
              ),
            ),
          ),
        ),
    });
  });
