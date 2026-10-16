import * as Effect from "effect/Effect";

interface DestructionSource {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

interface DestructionOwner {
  readonly callbacks: Set<() => void>;
  readonly destroyed: () => void;
}

/** Concurrent renderer operations share one native listener, released with the last operation. */
export const makeWebContentsDestructionSubscriptions = Effect.gen(function* () {
  const owners = new Map<DestructionSource, DestructionOwner>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const [source, owner] of owners) {
        source.removeListener("destroyed", owner.destroyed);
        owner.callbacks.clear();
      }
      owners.clear();
    }),
  );

  const subscribe = (source: DestructionSource, onDestroyed: () => void): (() => void) => {
    if (source.isDestroyed()) {
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
        for (const callback of pending) callback();
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
      owners.delete(source);
    };
  };

  return { subscribe };
});
