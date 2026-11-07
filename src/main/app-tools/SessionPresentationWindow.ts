import * as Effect from "effect/Effect";
import type { WorkbenchWindowReference } from "../../shared/nodex-app-tools/workbench";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";

const SHOWS_SESSION = 2;
const HAS_SHOWN_SESSION = 1;
const NEVER_SHOWN_SESSION = 0;

const sameWindow = (left: WorkbenchWindowReference, right: WorkbenchWindowReference) =>
  left.windowSessionId === right.windowSessionId &&
  left.rendererGeneration === right.rendererGeneration;

/**
 * Chooses a window for a presentation no live submission window anchored, such as a Turn that
 * continues after a restart. Windows are ranked by their relation to the Session; focus only breaks
 * ties, so a window already showing the Session is never passed over for a focused one.
 */
export const make = Effect.gen(function* () {
  const bridge = yield* WorkbenchAgentBridge;
  return Effect.fn("SessionPresentationWindow.select")(function* (
    sessionId: string,
  ): Effect.fn.Return<WorkbenchWindowReference | null> {
    const windows = bridge.registered();
    if (windows.length < 2) return windows[0] ?? null;
    const sessionKey = makeWorkbenchSceneKey({ kind: "session", sessionId });
    const ranked = yield* Effect.forEach(
      windows,
      (window) =>
        bridge.request(window, { kind: "discover", sessionId }).pipe(
          Effect.map(({ selectedSceneOwner, sceneOwners }) => {
            const selected = selectedSceneOwner && makeWorkbenchSceneKey(selectedSceneOwner);
            if (
              selected === sessionKey ||
              sceneOwners.some((owner) => makeWorkbenchSceneKey(owner) === selected)
            )
              return { window, rank: SHOWS_SESSION };
            return {
              window,
              rank: sceneOwners.length > 0 ? HAS_SHOWN_SESSION : NEVER_SHOWN_SESSION,
            };
          }),
          // A window that cannot answer in time cannot be relied on to present the tab either.
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: "unbounded" },
    );
    const answered = ranked.filter((entry) => entry !== null);
    const best = Math.max(...answered.map((entry) => entry.rank));
    const candidates = answered.filter((entry) => entry.rank === best).map((entry) => entry.window);
    const focused = bridge.lastFocused();
    return (
      candidates.find((window) => focused !== null && sameWindow(window, focused)) ??
      candidates[0] ??
      null
    );
  });
});
