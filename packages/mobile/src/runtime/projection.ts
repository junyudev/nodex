import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRef from "effect/reactivity/AtomRef";

/** A synchronous presentation snapshot. Lifecycle work belongs to its scoped service. */
export function createProjection<T>(initial: T) {
  const ref = AtomRef.make(initial);
  const atom = Atom.readable((get) => {
    get.addFinalizer(ref.subscribe((value) => get.setSelf(value)));
    return ref.value;
  });
  return {
    atom,
    getState: () => ref.value,
    setState(patch: T | Partial<T>, replace = false) {
      const previous = ref.value;
      const next = replace ? (patch as T) : ({ ...previous, ...patch } as T);
      if (Object.is(previous, next)) return;
      if (
        typeof next === "object" &&
        next !== null &&
        typeof previous === "object" &&
        previous !== null
      ) {
        const keys = Object.keys(next) as (keyof T)[];
        if (
          keys.length === Object.keys(previous).length &&
          keys.every((key) => Object.is(previous[key], next[key]))
        )
          return;
      }
      ref.set(next);
    },
    subscribe(listener: (value: T, previous: T) => void) {
      let previous = ref.value;
      return ref.subscribe((value) => {
        const before = previous;
        previous = value;
        listener(value, before);
      });
    },
    // A snapshot is replaceable: slow observers need the latest value, not an event backlog.
    changes: Stream.callback<T>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const unsubscribe = ref.subscribe((value) => {
              Queue.offerUnsafe(queue, value);
            });
            Queue.offerUnsafe(queue, ref.value);
            return unsubscribe;
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ),
  };
}

export type Projection<T> = ReturnType<typeof createProjection<T>>;
