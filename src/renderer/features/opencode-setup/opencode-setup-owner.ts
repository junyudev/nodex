import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import type { OpenCodeSetupRuntime } from "../../lib/opencode-setup-runtime";

export interface OpenCodeSetupSnapshot {
  /** Main's latest host setup; null until the first read or event arrives. */
  readonly state: OpenCodeSetupState | null;
  readonly loadError: string | null;
  /** A request from this window that Main has not answered yet. */
  readonly request: "install" | "cancel" | null;
  readonly requestError: {
    readonly request: "install" | "cancel";
    readonly message: string;
  } | null;
  /** Advances each time the host executable is observed becoming ready after it was not. */
  readonly readyEpoch: number;
}

export interface OpenCodeSetupOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => OpenCodeSetupSnapshot;
  /** Re-reads Main, which re-checks the host executable when no installation is running. */
  readonly refresh: () => void;
  readonly install: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  /** A mounted progress view; outcomes are announced only when an install started here has none. */
  readonly retainViewer: () => () => void;
}

export const EMPTY_OPENCODE_SETUP_SNAPSHOT: OpenCodeSetupSnapshot = {
  state: null,
  loadError: null,
  request: null,
  requestError: null,
  readyEpoch: 0,
};

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const attempt = <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return run();
  } catch (cause) {
    return Promise.reject(cause);
  }
};

/**
 * One window's view of Main-owned host setup. Main stays the only writer: results and events are
 * admitted by revision, so a late read can never replace a newer progress update.
 */
export function createOpenCodeSetupOwner(
  runtime: OpenCodeSetupRuntime,
  announce: (state: OpenCodeSetupState) => void,
): OpenCodeSetupOwner {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_OPENCODE_SETUP_SNAPSHOT;
  let stopEvents: (() => void) | null = null;
  let viewers = 0;
  let startedHere = false;
  let reading = false;

  const publish = (next: OpenCodeSetupSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const admit = (state: OpenCodeSetupState, patch: Partial<OpenCodeSetupSnapshot> = {}) => {
    const previous = snapshot.state;
    if (previous && state.revision <= previous.revision) {
      if (Object.keys(patch).length > 0) publish({ ...snapshot, ...patch });
      return;
    }
    const becameReady =
      previous !== null &&
      previous.executable.status !== "ready" &&
      state.executable.status === "ready";
    // An installation ends by succeeding, failing, or finding an executable it must not replace.
    const finished =
      startedHere &&
      state.installation.phase !== "running" &&
      (previous?.installation.phase === "running" || state.installation.phase !== "idle");
    if (finished) startedHere = false;
    publish({
      ...snapshot,
      ...patch,
      state,
      loadError: null,
      readyEpoch: snapshot.readyEpoch + (becameReady ? 1 : 0),
    });
    if (finished && viewers === 0) announce(state);
  };
  const refresh = () => {
    // A read already in flight answers with state at least as new as this request needs.
    if (reading) return;
    reading = true;
    void attempt(runtime.read)
      .then(
        (state) => admit(state),
        (cause: unknown) => {
          if (!snapshot.state) publish({ ...snapshot, loadError: describe(cause) });
        },
      )
      .finally(() => {
        reading = false;
      });
  };
  const start = () => {
    try {
      stopEvents = runtime.subscribe((state) => admit(state));
    } catch (cause) {
      snapshot = { ...snapshot, loadError: describe(cause) };
    }
    refresh();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopEvents?.();
        stopEvents = null;
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    install: async () => {
      if (snapshot.request) return;
      startedHere = true;
      publish({ ...snapshot, request: "install", requestError: null });
      try {
        const state = await attempt(runtime.install);
        admit(state, snapshot.request === "install" ? { request: null } : {});
      } catch (cause) {
        startedHere = false;
        publish({
          ...snapshot,
          request: snapshot.request === "install" ? null : snapshot.request,
          requestError: { request: "install", message: describe(cause) },
        });
      }
    },
    cancel: async () => {
      if (snapshot.request === "cancel") return;
      publish({ ...snapshot, request: "cancel", requestError: null });
      try {
        const state = await attempt(runtime.cancel);
        startedHere = false;
        admit(state, { request: null });
      } catch (cause) {
        publish({
          ...snapshot,
          request: null,
          requestError: { request: "cancel", message: describe(cause) },
        });
      }
    },
    retainViewer: () => {
      viewers += 1;
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        viewers -= 1;
      };
    },
  };
}
