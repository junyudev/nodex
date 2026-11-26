import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";
import type { ReadyPageBlockDocumentDescriptor } from "./owned-block-document";

export interface PageStageHistoryModalContext {
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly pageId: string;
  readonly descriptor: ReadyPageBlockDocumentDescriptor;
  readonly pageTitle?: string;
  readonly pageMarkdown: string;
  readonly workspaceRoot: string | null;
}

export function matchesPageStageHistory(
  context: PageStageHistoryModalContext | null,
  sceneOwner: WorkbenchSceneOwner,
  surfaceId: string,
  pageId: string,
): boolean {
  return (
    !!context &&
    context.surfaceId === surfaceId &&
    context.pageId === pageId &&
    makeWorkbenchSceneKey(context.sceneOwner) === makeWorkbenchSceneKey(sceneOwner)
  );
}
