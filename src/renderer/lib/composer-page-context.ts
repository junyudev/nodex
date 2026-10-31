import type { WorkbenchRendererObservation } from "../../shared/nodex-app-tools/workbench";
import { workbenchPageEditorKey } from "./workbench-page-editor-key";

export interface ComposerBesidePage {
  readonly pageId: string;
  readonly titleSnapshot: string;
  readonly editorKeys: readonly string[];
}

/** Only Page tabs actually shown beside this Session's conversation offer draft context. */
export function selectComposerBesidePages(
  observation: WorkbenchRendererObservation | null,
): readonly ComposerBesidePage[] {
  if (!observation || observation.sceneOwner.kind !== "session") return [];
  const pages = new Map<string, ComposerBesidePage>();
  for (const tab of observation.tabs) {
    if (
      tab.panelId !== "right" ||
      !tab.visible ||
      !tab.selected ||
      tab.surface?.kind !== "page_stage"
    )
      continue;
    const pageId = tab.surface.config.pageId;
    const previous = pages.get(pageId);
    const editorKey = workbenchPageEditorKey(observation.sceneOwner, tab.tabId);
    pages.set(pageId, {
      pageId,
      titleSnapshot: previous?.titleSnapshot ?? tab.surface.titleSnapshot,
      editorKeys: [...(previous?.editorKeys ?? []), editorKey],
    });
  }
  return [...pages.values()];
}
