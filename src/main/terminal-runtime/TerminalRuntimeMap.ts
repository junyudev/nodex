import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { TerminalSessionSnapshot, TerminalSize } from "../../shared/types";
import { appendTextTail } from "../../shared/bounded-text";
import {
  TerminalPty,
  type TerminalPtyConfig,
  type TerminalPtyExit,
} from "../platform/node/TerminalPty";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export const TERMINAL_RUNTIME_BUFFER_LIMIT = 16_000;

export class TerminalRuntimeError extends Schema.TaggedError<TerminalRuntimeError>()(
  "TerminalRuntimeError",
  {
    operation: Schema.String,
    sessionId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface TerminalRuntimeConfig extends TerminalPtyConfig {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly projectSessionId: string | null;
  readonly title: string | null;
}

export type TerminalRuntimeEvent =
  | { readonly kind: "data"; readonly sessionId: string; readonly data: string }
  | { readonly kind: "exit"; readonly sessionId: string; readonly exit: TerminalPtyExit };

export class TerminalRuntime extends Context.Service<
  TerminalRuntime,
  {
    readonly sessionId: string;
    readonly snapshot: SubscriptionRef.SubscriptionRef<TerminalSessionSnapshot>;
    readonly events: Stream.Stream<TerminalRuntimeEvent>;
    readonly exit: Effect.Effect<TerminalPtyExit>;
    readonly updateSnapshot: (
      update: (snapshot: TerminalSessionSnapshot) => TerminalSessionSnapshot,
    ) => Effect.Effect<void>;
    readonly write: (data: string) => Effect.Effect<void, TerminalRuntimeError>;
    readonly resize: (size: TerminalSize) => Effect.Effect<void, TerminalRuntimeError>;
    readonly kill: Effect.Effect<void, TerminalRuntimeError>;
  }
>()("nodex/main/terminal-runtime/TerminalRuntime") {}

export class TerminalRuntimeMap extends Context.Service<
  TerminalRuntimeMap,
  {
    readonly open: (
      config: TerminalRuntimeConfig,
    ) => Effect.Effect<TerminalRuntime["Service"], TerminalRuntimeError>;
    readonly runtime: (
      sessionId: string,
    ) => Effect.Effect<TerminalRuntime["Service"], TerminalRuntimeError>;
    readonly close: (sessionId: string) => Effect.Effect<void>;
  }
>()("nodex/main/terminal-runtime/TerminalRuntimeMap") {}

const normalizeSize = (size: TerminalSize): TerminalSize => ({
  cols: Math.max(2, Math.floor(size.cols)),
  rows: Math.max(1, Math.floor(size.rows)),
});

const runtimeLayer = (
  config: TerminalRuntimeConfig,
): Layer.Layer<TerminalRuntime, TerminalRuntimeError, TerminalPty> =>
  Layer.effect(
    TerminalRuntime,
    Effect.gen(function* () {
      const pty = yield* TerminalPty;
      const handle = yield* pty.spawn(config).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalRuntimeError({
              operation: cause.operation,
              sessionId: config.sessionId,
              cause,
            }),
        ),
      );
      const snapshot = yield* SubscriptionRef.make<TerminalSessionSnapshot>({
        sessionId: config.sessionId,
        conversationId: config.conversationId,
        projectSessionId: config.projectSessionId,
        osPid: handle.pid,
        cpuPercent: null,
        rssKb: null,
        childProcessCount: null,
        processMetricsSampledAtMs: null,
        cwd: config.cwd,
        shell: config.command,
        title: config.title,
        backendKind: "local",
        buffer: "",
        truncated: false,
        exited: false,
        exitCode: null,
        viewLease: null,
      });
      const events = yield* PubSub.sliding<TerminalRuntimeEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
      const outputFiber = handle.output.pipe(
        Stream.runForEach((data) =>
          SubscriptionRef.update(snapshot, (current) => {
            const next = appendTextTail({
              current: current.buffer,
              delta: data,
              maxChars: TERMINAL_RUNTIME_BUFFER_LIMIT,
            });
            return {
              ...current,
              buffer: next.text,
              truncated: current.truncated || next.didTruncate,
            };
          }).pipe(
            Effect.andThen(
              PubSub.publish(events, { kind: "data", sessionId: config.sessionId, data }),
            ),
          ),
        ),
      );
      const exitFiber = handle.exit.pipe(
        Effect.tap((exit) =>
          SubscriptionRef.update(snapshot, (current) => ({
            ...current,
            exited: true,
            exitCode: exit.exitCode,
            osPid: null,
          })).pipe(
            Effect.andThen(
              PubSub.publish(events, { kind: "exit", sessionId: config.sessionId, exit }),
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(outputFiber);
      yield* Effect.forkScoped(exitFiber);
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));

      const requireRunning = Effect.fn("TerminalRuntime.requireRunning")(function* () {
        const current = yield* SubscriptionRef.get(snapshot);
        if (!current.exited) return;
        return yield* new TerminalRuntimeError({
          operation: "closed",
          sessionId: config.sessionId,
          cause: new Error("Terminal session has exited"),
        });
      });
      return TerminalRuntime.of({
        sessionId: config.sessionId,
        snapshot,
        events: Stream.fromPubSub(events),
        exit: handle.exit,
        updateSnapshot: (update) => SubscriptionRef.update(snapshot, update),
        write: (data) =>
          requireRunning().pipe(
            Effect.andThen(handle.write(data)),
            Effect.mapError((cause) =>
              cause instanceof TerminalRuntimeError
                ? cause
                : new TerminalRuntimeError({
                    operation: "write",
                    sessionId: config.sessionId,
                    cause,
                  }),
            ),
          ),
        resize: (size) => {
          const normalized = normalizeSize(size);
          return requireRunning().pipe(
            Effect.andThen(handle.resize(normalized.cols, normalized.rows)),
            Effect.mapError((cause) =>
              cause instanceof TerminalRuntimeError
                ? cause
                : new TerminalRuntimeError({
                    operation: "resize",
                    sessionId: config.sessionId,
                    cause,
                  }),
            ),
          );
        },
        kill: requireRunning().pipe(
          Effect.andThen(handle.kill),
          Effect.mapError((cause) =>
            cause instanceof TerminalRuntimeError
              ? cause
              : new TerminalRuntimeError({
                  operation: "kill",
                  sessionId: config.sessionId,
                  cause,
                }),
          ),
        ),
      });
    }),
  );

const unavailable = (sessionId: string) =>
  new TerminalRuntimeError({
    operation: "lookup",
    sessionId,
    cause: new Error("Terminal session is not registered"),
  });

export const live: Layer.Layer<TerminalRuntimeMap, never, TerminalPty> = Layer.effect(
  TerminalRuntimeMap,
  Effect.gen(function* () {
    const configs = yield* Ref.make<ReadonlyMap<string, TerminalRuntimeConfig>>(new Map());
    const runtimes = yield* LayerMap.make(
      (sessionId: string): Layer.Layer<TerminalRuntime, TerminalRuntimeError, TerminalPty> =>
        Layer.unwrap(
          Ref.get(configs).pipe(
            Effect.map((current) => {
              const config = current.get(sessionId);
              return config === undefined
                ? Layer.effect(TerminalRuntime, Effect.fail(unavailable(sessionId)))
                : runtimeLayer(config);
            }),
          ),
        ),
      { idleTimeToLive: Duration.infinity },
    );
    const runtime = Effect.fn("TerminalRuntimeMap.runtime")(
      (sessionId: string): Effect.Effect<TerminalRuntime["Service"], TerminalRuntimeError> =>
        Effect.scoped(runtimes.contextEffect(sessionId)).pipe(
          Effect.map((context) => Context.get(context, TerminalRuntime)),
        ),
    );
    const open = Effect.fn("TerminalRuntimeMap.open")((config: TerminalRuntimeConfig) =>
      Ref.modify(configs, (current) => {
        if (current.has(config.sessionId)) return [false, current] as const;
        const next = new Map(current);
        next.set(config.sessionId, config);
        return [true, next] as const;
      }).pipe(
        Effect.andThen((registered) =>
          runtime(config.sessionId).pipe(
            Effect.onError(() => {
              if (!registered) return Effect.void;
              return Ref.update(configs, (latest) => {
                if (latest.get(config.sessionId) !== config) return latest;
                const rolledBack = new Map(latest);
                rolledBack.delete(config.sessionId);
                return rolledBack;
              });
            }),
          ),
        ),
      ),
    );
    return TerminalRuntimeMap.of({
      open,
      runtime,
      close: (sessionId) =>
        Ref.update(configs, (current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }).pipe(Effect.andThen(runtimes.invalidate(sessionId))),
    });
  }),
);
