import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

export interface WebContentsDestructionSource {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

interface DestructionOwner {
  readonly callbacks: Set<() => void>;
  readonly destroyed: () => void;
}

/**
 * The Main graph shares this Layer: one native destroyed listener per WebContents.
 * Effect owners use subscribeScoped or wait; callback adapters must release subscribe's
 * registration when their port, lease, or subscription ends before the renderer.
 */
export const makeWebContentsDestructionSubscriptions = Effect.gen(function* () {
  let closed = false;
  const owners = new Map<WebContentsDestructionSource, DestructionOwner>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      for (const [source, owner] of owners) {
        source.removeListener("destroyed", owner.destroyed);
        owner.callbacks.clear();
      }
      owners.clear();
    }),
  );

  const subscribe = (
    source: WebContentsDestructionSource,
    onDestroyed: () => void,
  ): (() => void) => {
    if (closed || source.isDestroyed()) {
      onDestroyed();
      return () => {};
    }
    let owner = owners.get(source);
    if (!owner) {
      const callbacks = new Set<() => void>();
      const destroyed = () => {
        owners.delete(source);
        const pending = [...callbacks];
        callbacks.clear();
        const errors: unknown[] = [];
        for (const callback of pending) {
          try {
            callback();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "WebContents cleanup failed");
      };
      owner = { callbacks, destroyed };
      owners.set(source, owner);
      source.once("destroyed", destroyed);
    }
    const callback = () => onDestroyed();
    owner.callbacks.add(callback);
    return () => {
      if (!owner.callbacks.delete(callback) || owner.callbacks.size > 0) return;
      source.removeListener("destroyed", owner.destroyed);
      if (owners.get(source) === owner) owners.delete(source);
    };
  };

  const subscribeScoped = (source: WebContentsDestructionSource, onDestroyed: () => void) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe(source, onDestroyed)),
      (release) => Effect.sync(release),
    );
  const wait = (source: WebContentsDestructionSource): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const release = subscribe(source, () => resume(Effect.void));
      return Effect.sync(release);
    });
  return { subscribe, subscribeScoped, wait };
});

export class WebContentsDestructionSubscriptions extends Context.Service<
  WebContentsDestructionSubscriptions,
  Effect.Success<typeof makeWebContentsDestructionSubscriptions>
>()("nodex/main/platform/electron/WebContentsDestructionSubscriptions") {
  static readonly live = Layer.effect(this, makeWebContentsDestructionSubscriptions);
}
