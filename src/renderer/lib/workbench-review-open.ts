import {
  WorkbenchPendingReviewOpenSchema,
  type WorkbenchPendingReviewOpen,
} from "../../shared/nodex-app-tools/workbench-reveal";
import {
  makeWorkbenchSceneKey,
  resolveWorkbenchSceneSurface,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import { canonicalizeReviewPath } from "../features/review/model/review-path";
import type { ReviewOpenIntent } from "../features/review/model/review-view-state";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

export function readWorkbenchReviewOpen(state: unknown): WorkbenchPendingReviewOpen | null {
  if (!state || typeof state !== "object" || !("pendingReviewOpen" in state)) return null;
  const parsed = WorkbenchPendingReviewOpenSchema.safeParse(state.pendingReviewOpen);
  return parsed.success ? parsed.data : null;
}

export function workbenchReviewOpenIntent(request: WorkbenchPendingReviewOpen): ReviewOpenIntent {
  const intent = request.intent;
  const source: ReviewOpenIntent["source"] =
    intent.view === "last-turn"
      ? { kind: "last-turn", threadId: intent.threadId }
      : intent.view === "branch"
        ? { kind: "git", mode: "branch", baseRef: intent.baseBranch ?? "" }
        : { kind: "git", mode: intent.view };
  return {
    operationId: request.operationId,
    source,
    ...(intent.path ? { targetPath: canonicalizeReviewPath(intent.path) } : {}),
  };
}

/** Consumes only the exact pending request; a later open or another surface is untouched. */
export function consumeWorkbenchReviewOpen(
  owner: WorkbenchWindowOwner,
  sceneOwner: WorkbenchSceneOwner,
  surfaceId: string,
  operationId: string,
): void {
  const existing = owner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)];
  if (!existing) return;
  owner.setScene(sceneOwner, (scene) => {
    if (!scene) return existing;
    const surface = resolveWorkbenchSceneSurface(scene, surfaceId);
    if (!surface || readWorkbenchReviewOpen(surface.state)?.operationId !== operationId)
      return scene;
    const { pendingReviewOpen: _pending, ...state } = surface.state as Record<string, unknown>;
    return updateWorkbenchSceneSurface(scene, surfaceId, { state });
  });
}
