import type { ContentRoutingContext } from "../../shared/content-routing-context";
import {
  findWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
} from "../../shared/workbench-panel-layout";
import type { WorkbenchTabCreateInput, WorkbenchTabProjection } from "./types";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import {
  resolveLeafIdForPanelTab,
  resolveSessionPanelActiveLeafId,
  resolveSessionPanelSurfaceTarget,
  type WorkbenchSurfaceRelativePlacement,
} from "./workbench-panel-placement";
import { getRenderablePanelPreviewTab } from "./workbench-panel-projection";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import {
  makePreviewWorkbenchTabProjection,
  sameWorkbenchPreviewInstance,
  workbenchSurfaceFromPreviewTab,
  type ProjectSessionPreviewTab,
} from "./workbench-panel-preview";
import type { useWorkbenchPanelLifecycle } from "./use-workbench-panel-lifecycle";
import type { prepareWorkbenchSceneSurfaceClose } from "./workbench-scene-command-lifecycle";

export interface OpenPageFileTabInput {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly fileId: string;
  readonly logicalPath: string | null;
  readonly title: string;
  readonly placement?: WorkbenchSurfaceRelativePlacement;
  readonly openMode?: "preview" | "durable";
}
export type OpenPageFileTabHandler = (input: OpenPageFileTabInput) => Promise<boolean>;

type Lifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  "setActivePanelTab" | "pinPreviewTab"
>;

export function findPageFileTab(
  session: Pick<WorkbenchSessionRenderProjection, "tabs">,
  input: Pick<OpenPageFileTabInput, "pageId" | "fileId">,
): WorkbenchTabProjection | null {
  // Project routes all resolve to this Profile's one Library.
  return (
    session.tabs.find(
      (tab) =>
        tab.kind === "page_file" &&
        tab.config.pageId === input.pageId &&
        tab.config.fileId === input.fileId,
    ) ?? null
  );
}

/** Uses the same preview slot, save boundary, and durable commands as the other Session tabs. */
export async function openSessionPageFileTab(
  input: OpenPageFileTabInput,
  ports: {
    readonly readSession: () => WorkbenchSessionRenderProjection;
    readonly readPreviews: () => WorkbenchPanelController["previewTabsByPanel"];
    readonly controller: Pick<
      WorkbenchPanelController,
      "updatePreviewTabsByPanel" | "updateTabOrderByPanelGroup"
    > & { readonly durable: Pick<WorkbenchPanelController["durable"], "ensureLeafToRight"> };
    readonly lifecycle: Lifecycle;
    readonly rightPanelFullWidth: boolean;
    readonly createTab: (input: WorkbenchTabCreateInput) => Promise<WorkbenchTabProjection | null>;
    readonly prepareClose: typeof prepareWorkbenchSceneSurfaceClose;
  },
): Promise<boolean> {
  const session = ports.readSession();
  const existing = findPageFileTab(session, input);
  if (existing) {
    await ports.lifecycle.setActivePanelTab(existing.panelId, existing.id, {
      leafId: resolveLeafIdForPanelTab(session, existing.panelId, existing.id),
      openPanel: true,
    });
    return true;
  }
  const previews = ports.readPreviews();
  const entries = (["right", "bottom"] as const).flatMap((panelId) =>
    listWorkbenchPanelLeaves(session.panels[panelId].layout).flatMap((leaf) => {
      const tab = getRenderablePanelPreviewTab(session, panelId, leaf.id, previews);
      return tab ? [{ panelId, leafId: leaf.id, tab }] : [];
    }),
  );
  const matching = entries.find(
    ({ tab }) =>
      tab.kind === "page_file" &&
      tab.config.pageId === input.pageId &&
      tab.config.fileId === input.fileId,
  );
  if (matching) {
    if (input.openMode !== "preview") {
      await ports.lifecycle.pinPreviewTab(matching.panelId, matching.tab.id, matching.leafId);
      return findPageFileTab(ports.readSession(), input) !== null;
    }
    await ports.lifecycle.setActivePanelTab(matching.panelId, matching.tab.id, {
      leafId: matching.leafId,
      openPanel: true,
    });
    return true;
  }
  const source = entries.find(({ tab }) => tab.id === input.placement?.sourceSurfaceId);
  const target = resolveSessionPanelSurfaceTarget(session, "right", input.placement, {
    rightPanelFullWidth: ports.rightPanelFullWidth,
    sourceSlot: source,
  });
  const panelId = target.kind === "existing" ? target.panelId : "right";
  const leafId =
    target.kind === "existing"
      ? target.leafId
      : target.kind === "ensure-right"
        ? ports.controller.durable.ensureLeafToRight(session, {
            panelId,
            leafId: target.sourceLeafId,
          })
        : resolveSessionPanelActiveLeafId(session, panelId);
  const leaf = findWorkbenchPanelLeaf(session.panels[panelId].layout, leafId);
  const sourceIndex =
    input.placement?.kind === "same-group"
      ? leaf?.tabIds.indexOf(input.placement.sourceSurfaceId)
      : undefined;
  const targetIndex =
    sourceIndex !== undefined && sourceIndex >= 0
      ? sourceIndex + 1
      : source && input.placement?.kind === "same-group"
        ? (source.tab.previewTargetIndex ?? leaf?.tabIds.length ?? 0) + 1
        : undefined;
  // Replacing the source's preview slot must not remove the Page the File came from.
  if (source?.tab.kind === "page_stage" && source.panelId === panelId && source.leafId === leafId) {
    await ports.lifecycle.pinPreviewTab(panelId, source.tab.id, leafId);
    if (!ports.readSession().tabs.some((tab) => tab.id === source.tab.id)) return false;
  }
  const before = getRenderablePanelPreviewTab(
    ports.readSession(),
    panelId,
    leafId,
    ports.readPreviews(),
  );
  if (before) {
    const canClose = await ports.prepareClose(
      { kind: "session", sessionId: session.id },
      workbenchSurfaceFromPreviewTab(before),
    );
    if (!canClose) return false;
    const current = getRenderablePanelPreviewTab(
      ports.readSession(),
      panelId,
      leafId,
      ports.readPreviews(),
    );
    if (!sameWorkbenchPreviewInstance(before, current)) return false;
  }
  const config = {
    routingContext: input.routingContext,
    pageId: input.pageId,
    fileId: input.fileId,
    logicalPath: input.logicalPath,
    titleSnapshot: input.title,
  };
  const slotKey = makeWorkbenchSessionPanelSlotKey(session.id, panelId, leafId);
  if (input.openMode === "preview") {
    const tab: ProjectSessionPreviewTab = {
      ...makePreviewWorkbenchTabProjection(session, panelId, {
        kind: "page_file",
        title: input.title,
        config,
      }),
      previewTargetIndex: targetIndex,
    };
    ports.controller.updatePreviewTabsByPanel((current) => ({ ...current, [slotKey]: tab }));
    if (input.placement?.kind === "same-group") {
      const sourceId = input.placement.sourceSurfaceId;
      ports.controller.updateTabOrderByPanelGroup((current) => {
        const ids = [...(current[slotKey] ?? leaf?.tabIds ?? [])].filter(
          (id) => id !== before?.id && id !== tab.id,
        );
        if (!ids.includes(sourceId) && source) ids.push(sourceId);
        const index = ids.indexOf(sourceId);
        if (index < 0) return current;
        ids.splice(index + 1, 0, tab.id);
        return { ...current, [slotKey]: ids };
      });
    }
    await ports.lifecycle.setActivePanelTab(panelId, tab.id, { leafId, openPanel: true });
    return true;
  }
  const created = await ports.createTab({
    sessionId: session.id,
    panelId,
    targetLeafId: leafId,
    targetIndex,
    openerTabId: input.placement?.sourceSurfaceId,
    kind: "page_file",
    title: input.title,
    config,
  });
  if (!created) return false;
  ports.controller.updatePreviewTabsByPanel((current) => {
    if (!sameWorkbenchPreviewInstance(current[slotKey], before)) return current;
    const next = { ...current };
    delete next[slotKey];
    return next;
  });
  await ports.lifecycle.setActivePanelTab(panelId, created.id, { leafId, openPanel: true });
  return true;
}
