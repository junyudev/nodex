import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { AppBadge, live as appBadgeLive } from "../platform/electron/AppBadge";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { DatabaseNotifierRuntime } from "./DatabaseNotifierRuntime";

/** Changes to chats arrive in bursts; one read per burst keeps the badge current. */
const SETTLE = "150 millis";

export interface UnreadBadgeOptions {
  /** The unread chat count, or null while it cannot be read. */
  readonly count: Effect.Effect<number | null, unknown>;
  /** Anything that can change which chats are unread or shown. */
  readonly changes: Stream.Stream<unknown>;
  readonly setBadge: (count: number) => Effect.Effect<void>;
}

/**
 * Keeps the app icon's badge equal to the number of unread chats in the chat list. The first read
 * always sets it, replacing a badge an earlier run left behind, and the badge is cleared when the
 * Profile's Scope closes, since nothing keeps it current after that.
 */
export const run = Effect.fn("UnreadBadge.run")(function* (options: UnreadBadgeOptions) {
  let shown: number | null = null;
  yield* Effect.addFinalizer(() => (shown ? options.setBadge(0) : Effect.void));
  const refresh = Effect.gen(function* () {
    const count = yield* options.count;
    if (count === null || count === shown) return;
    shown = count;
    yield* options.setBadge(count);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Unread badge could not refresh", cause)));
  yield* options.changes.pipe(
    Stream.debounce(SETTLE),
    Stream.runForEach(() => refresh),
    Effect.forkScoped({ startImmediately: true }),
  );
});

export const live: Layer.Layer<
  never,
  never,
  CoreAuthority | DatabaseNotifierRuntime | MainConfig | ProjectWorkspace
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const core = yield* CoreAuthority;
    const database = yield* DatabaseNotifierRuntime;
    const workspace = yield* ProjectWorkspace;
    const badge = yield* AppBadge;
    yield* run({
      count: SubscriptionRef.get(core.state).pipe(
        Effect.flatMap((state) =>
          state.kind === "ready" ? workspace.unreadChatCount : Effect.succeed(null),
        ),
      ),
      // Core readiness first emits its current state, so the badge is read once at start.
      changes: Stream.mergeAll(
        [
          SubscriptionRef.changes(core.state),
          database.projectSessionInvalidations,
          database.projectInvalidations,
        ] as ReadonlyArray<Stream.Stream<unknown>>,
        { concurrency: 3 },
      ),
      setBadge: badge.set,
    });
  }),
).pipe(Layer.provide(appBadgeLive));
