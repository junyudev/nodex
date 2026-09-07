import * as Effect from "effect/Effect";
import type {
  PresentationAnchor,
  WorkbenchSceneReference,
} from "../../shared/nodex-app-tools/workbench";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";

export type WorkbenchSceneSelection =
  | { readonly status: "selected"; readonly reference: WorkbenchSceneReference }
  | {
      readonly status: "unavailable" | "ambiguous_window" | "ambiguous_scene";
      readonly candidates: readonly WorkbenchSceneReference[];
    };

/** Resolves presentation coordinates without inferring focus or granting content access. */
export const make = Effect.gen(function* () {
  const bridge = yield* WorkbenchAgentBridge;
  return Effect.fn("WorkbenchSceneSelection.select")(function* (input: {
    readonly sessionId: string;
    readonly anchor: PresentationAnchor | null;
    readonly mode: "anchored" | "refresh";
    readonly target?: WorkbenchSceneReference;
  }): Effect.fn.Return<WorkbenchSceneSelection> {
    if (input.target) return { status: "selected", reference: input.target };
    const anchor = input.anchor;
    if (anchor && input.mode === "anchored") {
      if (!anchor.sceneOwner) return { status: "unavailable", candidates: [] };
      return {
        status: "selected",
        reference: {
          windowSessionId: anchor.windowSessionId,
          rendererGeneration: anchor.rendererGeneration,
          sceneOwner: anchor.sceneOwner,
        },
      };
    }
    const windows = anchor
      ? [{ windowSessionId: anchor.windowSessionId, rendererGeneration: anchor.rendererGeneration }]
      : bridge.registered();
    const observations = yield* Effect.forEach(
      windows,
      (reference) =>
        bridge.request(reference, { kind: "discover", sessionId: input.sessionId }).pipe(
          Effect.map((result) => ({ reference, result })),
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: 4 },
    );
    const candidates = observations.flatMap((observation) => {
      if (!observation) return [];
      const owners =
        anchor && input.mode === "refresh"
          ? observation.result.selectedSceneOwner
            ? [observation.result.selectedSceneOwner]
            : []
          : observation.result.sceneOwners;
      return owners.map((sceneOwner) => ({ ...observation.reference, sceneOwner }));
    });
    // A missing renderer response is not evidence that another window is the unique owner.
    if (observations.some((observation) => observation === null))
      return { status: "unavailable", candidates };
    if (candidates.length === 0) return { status: "unavailable", candidates };
    if (new Set(candidates.map((candidate) => candidate.windowSessionId)).size > 1)
      return { status: "ambiguous_window", candidates };
    if (candidates.length > 1) return { status: "ambiguous_scene", candidates };
    if (!anchor) return { status: "unavailable", candidates };
    return { status: "selected", reference: candidates[0]! };
  });
});
