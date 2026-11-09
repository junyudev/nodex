import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { AppBadge, live as appBadgeLive } from "../platform/electron/AppBadge";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { DatabaseNotifierRuntime } from "./DatabaseNotifierRuntime";

/** Changes to chats arrive in bursts; one read per burst keeps the badge current. */
const SETTLE = "150 millis";

/** One open Space's part of the badge, read through that Space's own Core. */
export interface UnreadChatCount {
  /** The reader's unread chats in the Space, or null while it cannot be read. */
  readonly count: Effect.Effect<number | null, unknown>;
  /** Anything that can change which of its chats are unread or shown. */
  readonly changes: Stream.Stream<unknown>;
}

export class UnreadBadge extends Context.Service<
  UnreadBadge,
  {
    /** Counts one open Space in the app badge for as long as the caller's Scope lasts. */
    readonly count: (
      spaceId: string,
      source: UnreadChatCount,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/host-runtime/UnreadBadge") {}

/**
 * Keeps the app icon's badge equal to the reader's unread chats across every Space this desktop
 * has open, each counted by its own Core. A Space whose count cannot be read keeps its last one
 * until it can, and leaving a Space takes its chats out. The first count always sets the badge,
 * replacing one an earlier run left behind, and it is cleared when the Profile's Scope closes,
 * since nothing keeps it current after that.
 */
export const make = Effect.fn("UnreadBadge.make")(function* (
  setBadge: (count: number) => Effect.Effect<void>,
) {
  const sources = new Map<string, UnreadChatCount>();
  const counts = new Map<string, number>();
  let shown: number | null = null;
  const wakes = yield* Queue.sliding<void>(1);
  const wake = Queue.offer(wakes, undefined).pipe(Effect.asVoid);
  yield* Effect.addFinalizer(() => (shown ? setBadge(0) : Effect.void));
  const refresh = Effect.gen(function* () {
    yield* Effect.forEach(
      [...sources],
      ([spaceId, source]) =>
        source.count.pipe(
          Effect.tap((count) =>
            Effect.sync(() => {
              if (count !== null && sources.get(spaceId) === source) counts.set(spaceId, count);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("A Space's unread chats could not be counted", cause),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    if (counts.size === 0 && shown === null) return;
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (total === shown) return;
    shown = total;
    yield* setBadge(total);
  });
  yield* Stream.fromQueue(wakes).pipe(
    Stream.debounce(SETTLE),
    Stream.runForEach(() => refresh),
    Effect.forkScoped({ startImmediately: true }),
  );
  return UnreadBadge.of({
    count: (spaceId, source) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            sources.set(spaceId, source);
          }),
          () =>
            Effect.suspend(() => {
              if (sources.get(spaceId) !== source) return Effect.void;
              sources.delete(spaceId);
              counts.delete(spaceId);
              return wake;
            }),
        );
        yield* source.changes.pipe(
          Stream.runForEach(() => wake),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* wake;
      }),
  });
});

/** The badge, with the personal Space this Profile hosts counted from its start to its end. */
export const live: Layer.Layer<
  UnreadBadge,
  never,
  CoreAuthority | DatabaseNotifierRuntime | MainConfig | ProjectWorkspace
> = Layer.effect(
  UnreadBadge,
  Effect.gen(function* () {
    const core = yield* CoreAuthority;
    const database = yield* DatabaseNotifierRuntime;
    const workspace = yield* ProjectWorkspace;
    const badge = yield* AppBadge;
    const service = yield* make(badge.set);
    yield* service.count(core.identity.libraryId, {
      count: SubscriptionRef.get(core.state).pipe(
        Effect.flatMap((state) =>
          state.kind === "ready" ? workspace.unreadChatCount : Effect.succeed(null),
        ),
      ),
      changes: Stream.mergeAll(
        [
          SubscriptionRef.changes(core.state),
          database.projectSessionInvalidations,
          database.projectInvalidations,
        ] as ReadonlyArray<Stream.Stream<unknown>>,
        { concurrency: 3 },
      ),
    });
    return service;
  }),
).pipe(Layer.provide(appBadgeLive));
