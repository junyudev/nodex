/* @effect-diagnostics newPromise:off -- Gates the concrete native Promise boundary without timers. */
export function deferredRelease() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((succeed, fail) => {
    resolve = succeed;
    reject = fail;
  });
  return { promise, resolve, reject };
}
