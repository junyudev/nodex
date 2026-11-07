import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

export interface BrowserWebContentsListenerRuntime {
  readonly acquire: (webContentsId: number, acquire: () => () => void) => boolean;
  readonly has: (webContentsId: number) => boolean;
  readonly release: (webContentsId: number) => void;
  readonly size: () => number;
}

function makeRuntimeState(): {
  readonly close: () => void;
  readonly runtime: BrowserWebContentsListenerRuntime;
} {
  let accepting = true;
  const releases = new Map<number, () => void>();

  const release = (webContentsId: number): void => {
    const teardown = releases.get(webContentsId);
    if (!teardown) return;
    releases.delete(webContentsId);
    teardown();
  };

  return {
    close: () => {
      accepting = false;
      for (const webContentsId of [...releases.keys()]) {
        release(webContentsId);
      }
    },
    runtime: {
      acquire: (webContentsId, acquire) => {
        if (!accepting || releases.has(webContentsId)) return false;
        releases.set(webContentsId, acquire());
        return true;
      },
      has: (webContentsId) => releases.has(webContentsId),
      release,
      size: () => releases.size,
    },
  };
}

/** Owns every Browser guest listener release under the enclosing Main Scope. */
export const makeBrowserWebContentsListenerRuntime: Effect.Effect<
  BrowserWebContentsListenerRuntime,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const state = makeRuntimeState();
  yield* Effect.addFinalizer(() => Effect.sync(state.close));
  return state.runtime;
});
