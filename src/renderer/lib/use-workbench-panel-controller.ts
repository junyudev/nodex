import { useCallback, useMemo, useState } from "react";
import {
  type WorkbenchEphemeralPanelState,
  type WorkbenchEphemeralPanelStateField,
  type WorkbenchEphemeralPanelStateUpdate,
} from "./workbench-ephemeral-panel-state";
import { useWorkbenchEphemeralPanels } from "./use-workbench-window-state";
import type { PanelId, ProjectSession } from "../../shared/types";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  ensureWorkbenchSceneLeafToRight,
  makeWorkbenchSceneKey,
  mergeWorkbenchSceneLeaf,
  moveWorkbenchSceneSurface,
  patchWorkbenchScenePanel,
  removeWorkbenchSceneSurface,
  reorderWorkbenchSceneSurfaces,
  resizeWorkbenchSceneBranch,
  splitWorkbenchSceneLeaf,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import {
  makeWorkbenchPanelSlotKey,
  makeWorkbenchSessionPanelOwnerKey,
  makeWorkbenchSessionPanelSlotKey,
} from "./workbench-panel-slot-key";
import {
  createWorkbenchPanelTabOpenerStore,
  type WorkbenchPanelTabOpenerStore,
} from "./workbench-panel-tab-opener-state";
import {
  findWorkbenchPanelLeaf,
  findWorkbenchPanelLeafForTab,
} from "../../shared/workbench-panel-layout";
import type {
  AgentPanelTab,
  AutomationPanelTab,
  ImageEditorPanelTab,
  McpAppPanelTab,
  PlanPanelTab,
  ProcessOutputPanelTab,
  SideChatPanelTab,
} from "./workbench-panel-tab-model";

type UpdateCommands = {
  [Field in WorkbenchEphemeralPanelStateField as `update${Capitalize<Field>}`]: (
    update: WorkbenchEphemeralPanelStateUpdate<WorkbenchEphemeralPanelState[Field]>,
  ) => void;
};

export type WorkbenchPanelController = WorkbenchEphemeralPanelState &
  UpdateCommands & {
    readonly pruneOwner: (ownerKey: string) => void;
    readonly pruneSession: (sessionId: string) => void;
    readonly tabOpenerStore: WorkbenchPanelTabOpenerStore;
    readonly durable: WorkbenchDurablePanelCommands;
    readonly sceneDurable: WorkbenchSceneDurablePanelCommands | null;
    readonly selectRenderableTab: (input: WorkbenchRenderableTabSelectionInput) => boolean;
    readonly removeEphemeralTab: (
      input: WorkbenchEphemeralTabRemovalInput,
    ) => WorkbenchEphemeralTab | null;
    readonly upsertEphemeralTab: (tab: WorkbenchEphemeralTab) => void;
  };

export interface WorkbenchRenderableTabSelectionInput {
  readonly sessionId: string;
  readonly panelId: PanelId;
  readonly leafId: string;
  readonly tabId: string;
  readonly durableTabIds: ReadonlySet<string>;
}

export type WorkbenchEphemeralTab =
  | SideChatPanelTab
  | McpAppPanelTab
  | PlanPanelTab
  | AutomationPanelTab
  | AgentPanelTab
  | ProcessOutputPanelTab
  | ImageEditorPanelTab;

export interface WorkbenchEphemeralTabRemovalInput {
  readonly sessionId: string;
  readonly panelId: PanelId;
  readonly leafId: string;
  readonly tabId: string;
}

export interface WorkbenchPanelControllerInput {
  readonly mutateScene: (
    owner: WorkbenchSceneOwner,
    mutation: (scene: WorkbenchSceneSnapshot) => WorkbenchSceneSnapshot,
  ) => WorkbenchSceneSnapshot;
}

export interface WorkbenchSceneDurablePanelCommands {
  readonly apply: NonNullable<WorkbenchPanelControllerInput["mutateScene"]>;
  readonly createSurface: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof createWorkbenchSceneSurface>[1] & {
      readonly openerSurfaceId?: string;
    },
  ) => WorkbenchSceneSnapshot;
  readonly updateSurface: (
    owner: WorkbenchSceneOwner,
    surfaceId: string,
    patch: Parameters<typeof updateWorkbenchSceneSurface>[2],
  ) => WorkbenchSceneSnapshot;
  readonly patchPanel: (
    owner: WorkbenchSceneOwner,
    panelId: Parameters<typeof patchWorkbenchScenePanel>[1],
    patch: Parameters<typeof patchWorkbenchScenePanel>[2],
  ) => WorkbenchSceneSnapshot;
  readonly activateSurface: (
    owner: WorkbenchSceneOwner,
    panelId: Parameters<typeof activateWorkbenchSceneSurface>[1],
    leafId: string,
    surfaceId?: string | null,
  ) => WorkbenchSceneSnapshot;
  readonly removeSurface: (
    owner: WorkbenchSceneOwner,
    surfaceId: string,
    options?: Parameters<typeof removeWorkbenchSceneSurface>[2],
  ) => WorkbenchSceneSnapshot;
  readonly moveSurface: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof moveWorkbenchSceneSurface>[1],
  ) => WorkbenchSceneSnapshot;
  readonly reorderSurfaces: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof reorderWorkbenchSceneSurfaces>[1] & {
      readonly movedSurfaceId?: string;
    },
  ) => WorkbenchSceneSnapshot;
  readonly splitLeaf: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof splitWorkbenchSceneLeaf>[1],
  ) => WorkbenchSceneSnapshot;
  readonly mergeLeaf: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof mergeWorkbenchSceneLeaf>[1],
  ) => WorkbenchSceneSnapshot;
  readonly resizeBranch: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof resizeWorkbenchSceneBranch>[1],
  ) => WorkbenchSceneSnapshot;
  readonly ensureLeafToRight: (
    owner: WorkbenchSceneOwner,
    input: Parameters<typeof ensureWorkbenchSceneLeafToRight>[1],
  ) => string;
}

export interface WorkbenchDurablePanelCommands {
  readonly apply: (
    session: ProjectSession,
    mutation: (scene: WorkbenchSceneSnapshot) => WorkbenchSceneSnapshot,
  ) => WorkbenchSceneSnapshot;
  readonly createTab: (
    session: ProjectSession,
    input: {
      readonly panelId: PanelId;
      readonly presentation?: Parameters<typeof createWorkbenchSceneSurface>[1]["presentation"];
      readonly targetLeafId?: string;
      readonly targetIndex?: number;
      readonly openerTabId?: string;
      readonly tab: WorkbenchSurfaceDescriptor;
    },
  ) => WorkbenchSceneSnapshot;
  readonly updateTab: (
    session: ProjectSession,
    tabId: string,
    surface: WorkbenchSurfaceDescriptor,
  ) => WorkbenchSceneSnapshot;
  readonly patchPanel: (
    session: ProjectSession,
    panelId: PanelId,
    patch: Parameters<typeof patchWorkbenchScenePanel>[2],
  ) => WorkbenchSceneSnapshot;
  readonly activateTab: (
    session: ProjectSession,
    panelId: PanelId,
    leafId: string,
    tabId?: string | null,
  ) => WorkbenchSceneSnapshot;
  readonly reorderTabs: (
    session: ProjectSession,
    input: {
      readonly panelId: PanelId;
      readonly leafId: string;
      readonly orderedTabIds: string[];
      readonly movedTabId?: string;
    },
  ) => WorkbenchSceneSnapshot;
  readonly mergeLeaf: (
    session: ProjectSession,
    input: Parameters<typeof mergeWorkbenchSceneLeaf>[1],
  ) => WorkbenchSceneSnapshot;
  readonly removeTab: (
    session: ProjectSession,
    tabId: string,
    options?: {
      readonly preserveEmptyLeafIds?: string[];
      readonly preferredActiveLeafId?: string | null;
      readonly preferredActiveTabId?: string | null;
    },
  ) => WorkbenchSceneSnapshot;
  readonly moveTab: (
    session: ProjectSession,
    input: {
      readonly tabId: string;
      readonly targetPanelId: PanelId;
      readonly targetLeafId?: string;
      readonly targetIndex?: number;
      readonly preserveEmptyLeafIds?: string[];
      readonly splitTarget?: Parameters<typeof moveWorkbenchSceneSurface>[1]["splitTarget"];
    },
  ) => WorkbenchSceneSnapshot;
  readonly splitLeaf: (
    session: ProjectSession,
    input: {
      readonly panelId: PanelId;
      readonly leafId: string;
      readonly side: Parameters<typeof splitWorkbenchSceneLeaf>[1]["side"];
      readonly tabId?: string;
    },
  ) => WorkbenchSceneSnapshot;
  readonly resizeBranch: (
    session: ProjectSession,
    input: Parameters<typeof resizeWorkbenchSceneBranch>[1],
  ) => WorkbenchSceneSnapshot;
  readonly ensureLeafToRight: (
    session: ProjectSession,
    input: Parameters<typeof ensureWorkbenchSceneLeafToRight>[1],
  ) => string;
}

function sessionSceneOwner(session: ProjectSession): WorkbenchSceneOwner {
  return { kind: "session", sessionId: session.id };
}

function makeScenePanelTabOpenerScopeKey(
  owner: WorkbenchSceneOwner,
  panelId: PanelId,
  leafId: string,
): string {
  return makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(owner), panelId, leafId);
}

function findScenePanelTabSlot(
  scene: WorkbenchSceneSnapshot,
  tabId: string,
): {
  readonly panelId: PanelId;
  readonly leafId: string;
  readonly index: number;
  readonly activeTabId: string | null;
} | null {
  for (const panelId of ["right", "bottom"] as const) {
    const leaf = findWorkbenchPanelLeafForTab(scene.panels[panelId].layout, tabId);
    if (leaf) {
      return {
        panelId,
        leafId: leaf.id,
        index: leaf.tabIds.indexOf(tabId),
        activeTabId: leaf.activeTabId,
      };
    }
  }
  return null;
}

function recordScenePanelTabActivated(
  store: WorkbenchPanelTabOpenerStore,
  owner: WorkbenchSceneOwner,
  scene: WorkbenchSceneSnapshot,
  panelId: PanelId,
  leafId: string,
  tabId?: string | null,
): void {
  const leaf = findWorkbenchPanelLeaf(scene.panels[panelId].layout, leafId);
  if (!leaf) return;
  const selectedTabId = tabId && leaf.tabIds.includes(tabId) ? tabId : leaf.activeTabId;
  store.recordActivated(
    makeScenePanelTabOpenerScopeKey(owner, panelId, leaf.id),
    selectedTabId,
    leaf.tabIds,
  );
}

function capitalize<Value extends string>(value: Value): Capitalize<Value> {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}` as Capitalize<Value>;
}

const EPHEMERAL_PANEL_FIELDS = [
  "previewTabsByPanel",
  "previewSurfacesByPanel",
  "sideChatTabsBySession",
  "sideChatActiveTabByPanel",
  "mcpAppTabsBySession",
  "mcpAppActiveTabByPanel",
  "planTabsBySession",
  "planActiveTabByPanel",
  "automationTabsBySession",
  "automationActiveTabByPanel",
  "backgroundAgentTabsBySession",
  "backgroundAgentActiveTabByPanel",
  "processOutputTabsBySession",
  "processOutputActiveTabByPanel",
  "imageEditorTabsBySession",
  "imageEditorActiveTabByPanel",
  "pendingProcessOutputOpen",
  "activePlanKeyBySession",
  "panelCollapsedOverrides",
] as const satisfies readonly WorkbenchEphemeralPanelStateField[];

export function useWorkbenchPanelController({
  mutateScene,
}: WorkbenchPanelControllerInput): WorkbenchPanelController {
  const [tabOpenerStore] = useState(createWorkbenchPanelTabOpenerStore);
  const { state, dispatch, owner } = useWorkbenchEphemeralPanels();
  const update = useCallback(
    <Field extends WorkbenchEphemeralPanelStateField>(
      field: Field,
      value: WorkbenchEphemeralPanelStateUpdate<WorkbenchEphemeralPanelState[Field]>,
    ) => {
      dispatch({
        type: "update",
        field,
        update: value,
      } as Parameters<typeof dispatch>[0]);
    },
    [dispatch],
  );
  const pruneSession = useCallback(
    (sessionId: string) => {
      dispatch({ type: "prune-session", sessionId });
      tabOpenerStore.pruneOwner(makeWorkbenchSessionPanelOwnerKey(sessionId));
    },
    [dispatch, tabOpenerStore],
  );
  const pruneOwner = useCallback(
    (ownerKey: string) => {
      dispatch({ type: "prune-owner", ownerKey });
      tabOpenerStore.pruneOwner(ownerKey);
    },
    [dispatch, tabOpenerStore],
  );
  const commands = useMemo(
    () =>
      Object.fromEntries(
        EPHEMERAL_PANEL_FIELDS.map((field) => [
          `update${capitalize(field)}`,
          (value: WorkbenchEphemeralPanelStateUpdate<WorkbenchEphemeralPanelState[typeof field]>) =>
            update(field, value),
        ]),
      ) as unknown as UpdateCommands,
    [update],
  );
  const durable = useMemo<WorkbenchDurablePanelCommands>(
    () => ({
      apply: (session, mutation) => mutateScene(sessionSceneOwner(session), mutation),
      createTab: (session, input) => {
        const owner = sessionSceneOwner(session);
        const capture = { tabAlreadyExists: false, openerLeafId: null as string | null };
        const next = mutateScene(owner, (scene) => {
          capture.tabAlreadyExists = findScenePanelTabSlot(scene, input.tab.id) !== null;
          capture.openerLeafId = input.openerTabId
            ? (findScenePanelTabSlot(scene, input.openerTabId)?.leafId ?? null)
            : null;
          return createWorkbenchSceneSurface(scene, {
            panelId: input.panelId,
            presentation: input.presentation,
            targetLeafId: input.targetLeafId,
            targetIndex: input.targetIndex,
            surface: input.tab,
          });
        });
        if (capture.tabAlreadyExists) return next;
        const createdLeaf = findWorkbenchPanelLeafForTab(
          next.panels[input.panelId].layout,
          input.tab.id,
        );
        if (!createdLeaf) return next;
        const scopeKey = makeScenePanelTabOpenerScopeKey(owner, input.panelId, createdLeaf.id);
        if (
          input.openerTabId &&
          capture.openerLeafId === createdLeaf.id &&
          createdLeaf.tabIds.includes(input.openerTabId)
        ) {
          tabOpenerStore.recordOpened(scopeKey, {
            tabId: input.tab.id,
            openerTabId: input.openerTabId,
            openedInBackground: input.presentation === "background",
          });
        }
        if (input.presentation !== "background") {
          tabOpenerStore.recordActivated(scopeKey, input.tab.id, createdLeaf.tabIds);
        }
        return next;
      },
      updateTab: (session, tabId, surface) =>
        mutateScene(sessionSceneOwner(session), (scene) =>
          updateWorkbenchSceneSurface(scene, tabId, surface),
        ),
      patchPanel: (session, panelId, patch) =>
        mutateScene(sessionSceneOwner(session), (scene) =>
          patchWorkbenchScenePanel(scene, panelId, patch),
        ),
      activateTab: (session, panelId, leafId, tabId) => {
        const owner = sessionSceneOwner(session);
        const next = mutateScene(owner, (scene) =>
          activateWorkbenchSceneSurface(scene, panelId, leafId, tabId),
        );
        recordScenePanelTabActivated(tabOpenerStore, owner, next, panelId, leafId, tabId);
        return next;
      },
      reorderTabs: (session, input) => {
        const owner = sessionSceneOwner(session);
        const capture = { previousOrder: [] as readonly string[] };
        const next = mutateScene(owner, (scene) => {
          capture.previousOrder =
            findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
          return reorderWorkbenchSceneSurfaces(scene, {
            panelId: input.panelId,
            leafId: input.leafId,
            orderedSurfaceIds: input.orderedTabIds,
          });
        });
        const nextOrder =
          findWorkbenchPanelLeaf(next.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
        if (
          input.movedTabId &&
          JSON.stringify(capture.previousOrder) !== JSON.stringify(nextOrder)
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId),
            input.movedTabId,
          );
        }
        return next;
      },
      mergeLeaf: (session, input) => {
        const owner = sessionSceneOwner(session);
        const capture = { tabIds: [] as readonly string[] };
        const scopeKey = makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId);
        const next = mutateScene(owner, (scene) => {
          capture.tabIds =
            findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
          return mergeWorkbenchSceneLeaf(scene, input);
        });
        if (findWorkbenchPanelLeaf(next.panels[input.panelId].layout, input.leafId)) return next;
        for (const tabId of capture.tabIds) tabOpenerStore.recordMoved(scopeKey, tabId);
        tabOpenerStore.pruneScope(scopeKey);
        return next;
      },
      removeTab: (session, tabId, options) => {
        const owner = sessionSceneOwner(session);
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = findScenePanelTabSlot(scene, tabId);
          return removeWorkbenchSceneSurface(scene, tabId, {
            preserveEmptyLeafIds: options?.preserveEmptyLeafIds,
            preferredActiveLeafId: options?.preferredActiveLeafId,
            preferredActiveSurfaceId: options?.preferredActiveTabId,
          });
        });
        const sourceSlot = capture.sourceSlot;
        if (!sourceSlot) return next;
        const scopeKey = makeScenePanelTabOpenerScopeKey(
          owner,
          sourceSlot.panelId,
          sourceSlot.leafId,
        );
        const nextLeaf = findWorkbenchPanelLeaf(
          next.panels[sourceSlot.panelId].layout,
          sourceSlot.leafId,
        );
        if (sourceSlot.activeTabId === tabId && nextLeaf) {
          tabOpenerStore.recordActivated(scopeKey, nextLeaf.activeTabId, nextLeaf.tabIds);
        }
        tabOpenerStore.recordClosed(scopeKey, tabId);
        if (!nextLeaf) tabOpenerStore.pruneScope(scopeKey);
        return next;
      },
      moveTab: (session, input) => {
        const owner = sessionSceneOwner(session);
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = findScenePanelTabSlot(scene, input.tabId);
          return moveWorkbenchSceneSurface(scene, {
            surfaceId: input.tabId,
            targetPanelId: input.targetPanelId,
            targetLeafId: input.targetLeafId,
            targetIndex: input.targetIndex,
            preserveEmptyLeafIds: input.preserveEmptyLeafIds,
            splitTarget: input.splitTarget,
          });
        });
        const sourceSlot = capture.sourceSlot;
        const targetSlot = findScenePanelTabSlot(next, input.tabId);
        if (
          sourceSlot &&
          targetSlot &&
          (sourceSlot.panelId !== targetSlot.panelId ||
            sourceSlot.leafId !== targetSlot.leafId ||
            sourceSlot.index !== targetSlot.index)
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, sourceSlot.panelId, sourceSlot.leafId),
            input.tabId,
          );
        }
        return next;
      },
      splitLeaf: (session, input) => {
        const owner = sessionSceneOwner(session);
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = input.tabId ? findScenePanelTabSlot(scene, input.tabId) : null;
          return splitWorkbenchSceneLeaf(scene, {
            panelId: input.panelId,
            leafId: input.leafId,
            side: input.side,
            surfaceId: input.tabId,
          });
        });
        const targetSlot = input.tabId ? findScenePanelTabSlot(next, input.tabId) : null;
        if (
          input.tabId &&
          capture.sourceSlot &&
          targetSlot &&
          capture.sourceSlot.leafId !== targetSlot.leafId
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId),
            input.tabId,
          );
        }
        return next;
      },
      resizeBranch: (session, input) =>
        mutateScene(sessionSceneOwner(session), (scene) =>
          resizeWorkbenchSceneBranch(scene, input),
        ),
      ensureLeafToRight: (session, input) => {
        let leafId = input.leafId;
        mutateScene(sessionSceneOwner(session), (scene) => {
          const result = ensureWorkbenchSceneLeafToRight(scene, input);
          leafId = result.leafId;
          return result.scene;
        });
        return leafId;
      },
    }),
    [mutateScene, tabOpenerStore],
  );
  const sceneDurable = useMemo<WorkbenchSceneDurablePanelCommands>(
    () => ({
      apply: mutateScene,
      createSurface: (owner, input) => {
        let existed = false;
        let openerLeafId: string | null = null;
        const next = mutateScene(owner, (scene) => {
          existed = findScenePanelTabSlot(scene, input.surface.id) !== null;
          openerLeafId = input.openerSurfaceId
            ? (findScenePanelTabSlot(scene, input.openerSurfaceId)?.leafId ?? null)
            : null;
          return createWorkbenchSceneSurface(scene, input);
        });
        if (existed) return next;
        const createdSlot = findScenePanelTabSlot(next, input.surface.id);
        if (!createdSlot) return next;
        const leaf = findWorkbenchPanelLeaf(
          next.panels[createdSlot.panelId].layout,
          createdSlot.leafId,
        );
        if (!leaf) return next;
        const scopeKey = makeScenePanelTabOpenerScopeKey(
          owner,
          createdSlot.panelId,
          createdSlot.leafId,
        );
        if (
          input.openerSurfaceId &&
          openerLeafId === createdSlot.leafId &&
          leaf.tabIds.includes(input.openerSurfaceId)
        ) {
          tabOpenerStore.recordOpened(scopeKey, {
            tabId: input.surface.id,
            openerTabId: input.openerSurfaceId,
            openedInBackground: input.presentation === "background",
          });
        }
        if (input.presentation !== "background") {
          tabOpenerStore.recordActivated(scopeKey, input.surface.id, leaf.tabIds);
        }
        return next;
      },
      updateSurface: (owner, surfaceId, patch) =>
        mutateScene(owner, (scene) => updateWorkbenchSceneSurface(scene, surfaceId, patch)),
      patchPanel: (owner, panelId, patch) =>
        mutateScene(owner, (scene) => patchWorkbenchScenePanel(scene, panelId, patch)),
      activateSurface: (owner, panelId, leafId, surfaceId) => {
        const next = mutateScene(owner, (scene) =>
          activateWorkbenchSceneSurface(scene, panelId, leafId, surfaceId),
        );
        recordScenePanelTabActivated(tabOpenerStore, owner, next, panelId, leafId, surfaceId);
        return next;
      },
      removeSurface: (owner, surfaceId, options) => {
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = findScenePanelTabSlot(scene, surfaceId);
          return removeWorkbenchSceneSurface(scene, surfaceId, options);
        });
        const sourceSlot = capture.sourceSlot;
        if (!sourceSlot) return next;
        const scopeKey = makeScenePanelTabOpenerScopeKey(
          owner,
          sourceSlot.panelId,
          sourceSlot.leafId,
        );
        const nextLeaf = findWorkbenchPanelLeaf(
          next.panels[sourceSlot.panelId].layout,
          sourceSlot.leafId,
        );
        if (sourceSlot.activeTabId === surfaceId && nextLeaf) {
          tabOpenerStore.recordActivated(scopeKey, nextLeaf.activeTabId, nextLeaf.tabIds);
        }
        tabOpenerStore.recordClosed(scopeKey, surfaceId);
        if (!nextLeaf) tabOpenerStore.pruneScope(scopeKey);
        return next;
      },
      moveSurface: (owner, input) => {
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = findScenePanelTabSlot(scene, input.surfaceId);
          return moveWorkbenchSceneSurface(scene, input);
        });
        const sourceSlot = capture.sourceSlot;
        const targetSlot = findScenePanelTabSlot(next, input.surfaceId);
        if (
          sourceSlot &&
          targetSlot &&
          (sourceSlot.panelId !== targetSlot.panelId ||
            sourceSlot.leafId !== targetSlot.leafId ||
            sourceSlot.index !== targetSlot.index)
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, sourceSlot.panelId, sourceSlot.leafId),
            input.surfaceId,
          );
        }
        return next;
      },
      reorderSurfaces: (owner, input) => {
        const capture = { previousOrder: [] as readonly string[] };
        const next = mutateScene(owner, (scene) => {
          capture.previousOrder =
            findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
          return reorderWorkbenchSceneSurfaces(scene, input);
        });
        const nextOrder =
          findWorkbenchPanelLeaf(next.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
        if (
          input.movedSurfaceId &&
          JSON.stringify(capture.previousOrder) !== JSON.stringify(nextOrder)
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId),
            input.movedSurfaceId,
          );
        }
        return next;
      },
      splitLeaf: (owner, input) => {
        const capture = { sourceSlot: null as ReturnType<typeof findScenePanelTabSlot> };
        const next = mutateScene(owner, (scene) => {
          capture.sourceSlot = input.surfaceId
            ? findScenePanelTabSlot(scene, input.surfaceId)
            : null;
          return splitWorkbenchSceneLeaf(scene, input);
        });
        const targetSlot = input.surfaceId ? findScenePanelTabSlot(next, input.surfaceId) : null;
        if (
          input.surfaceId &&
          capture.sourceSlot &&
          targetSlot &&
          capture.sourceSlot.leafId !== targetSlot.leafId
        ) {
          tabOpenerStore.recordMoved(
            makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId),
            input.surfaceId,
          );
        }
        return next;
      },
      mergeLeaf: (owner, input) => {
        const capture = { tabIds: [] as readonly string[] };
        const scopeKey = makeScenePanelTabOpenerScopeKey(owner, input.panelId, input.leafId);
        const next = mutateScene(owner, (scene) => {
          capture.tabIds =
            findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId)?.tabIds ?? [];
          return mergeWorkbenchSceneLeaf(scene, input);
        });
        if (findWorkbenchPanelLeaf(next.panels[input.panelId].layout, input.leafId)) return next;
        for (const tabId of capture.tabIds) tabOpenerStore.recordMoved(scopeKey, tabId);
        tabOpenerStore.pruneScope(scopeKey);
        return next;
      },
      resizeBranch: (owner, input) =>
        mutateScene(owner, (scene) => resizeWorkbenchSceneBranch(scene, input)),
      ensureLeafToRight: (owner, input) => {
        let leafId = input.leafId;
        mutateScene(owner, (scene) => {
          const result = ensureWorkbenchSceneLeafToRight(scene, input);
          leafId = result.leafId;
          return result.scene;
        });
        return leafId;
      },
    }),
    [mutateScene, tabOpenerStore],
  );
  const selectRenderableTab = useCallback(
    ({
      sessionId,
      panelId,
      leafId,
      tabId,
      durableTabIds,
    }: WorkbenchRenderableTabSelectionInput): boolean => {
      const state = owner.read().ephemeralPanels;
      const slotKeys = [
        makeWorkbenchSessionPanelSlotKey(sessionId, panelId, leafId),
        makeWorkbenchSessionPanelSlotKey(sessionId, panelId),
      ];
      const candidates = [
        {
          field: "sideChatActiveTabByPanel" as const,
          tabs: state.sideChatTabsBySession[sessionId] ?? [],
        },
        {
          field: "mcpAppActiveTabByPanel" as const,
          tabs: state.mcpAppTabsBySession[sessionId] ?? [],
        },
        {
          field: "planActiveTabByPanel" as const,
          tabs: state.planTabsBySession[sessionId] ?? [],
        },
        {
          field: "automationActiveTabByPanel" as const,
          tabs: state.automationTabsBySession[sessionId] ?? [],
        },
        {
          field: "backgroundAgentActiveTabByPanel" as const,
          tabs: state.backgroundAgentTabsBySession[sessionId] ?? [],
        },
        {
          field: "processOutputActiveTabByPanel" as const,
          tabs: state.processOutputTabsBySession[sessionId] ?? [],
        },
        {
          field: "imageEditorActiveTabByPanel" as const,
          tabs: state.imageEditorTabsBySession[sessionId] ?? [],
        },
      ];
      const openerScopeKey = makeWorkbenchSessionPanelSlotKey(sessionId, panelId, leafId);
      const visibleTabIds = [
        ...durableTabIds,
        ...candidates.flatMap((candidate) =>
          candidate.tabs
            .filter(
              (tab) =>
                tab.panelId === panelId && (tab.leafId === undefined || tab.leafId === leafId),
            )
            .map((tab) => tab.id),
        ),
      ];
      for (const candidate of candidates) {
        const tab = candidate.tabs.find((item) => item.id === tabId);
        if (!tab) continue;
        dispatch({
          type: "select-slot",
          slotKeys,
          activeField: candidate.field,
          tabId,
          sessionId,
          ...("planKey" in tab ? { planKey: tab.planKey } : {}),
        });
        tabOpenerStore.recordActivated(openerScopeKey, tabId, visibleTabIds);
        return true;
      }
      if (!durableTabIds.has(tabId)) return false;
      dispatch({
        type: "select-slot",
        slotKeys,
        activeField: null,
        tabId: null,
        sessionId,
      });
      tabOpenerStore.recordActivated(openerScopeKey, tabId, visibleTabIds);
      return true;
    },
    [dispatch, owner, tabOpenerStore],
  );
  const removeEphemeralTab = useCallback(
    ({
      sessionId,
      panelId,
      leafId,
      tabId,
    }: WorkbenchEphemeralTabRemovalInput): WorkbenchEphemeralTab | null => {
      const state = owner.read().ephemeralPanels;
      const candidates = [
        {
          tabsField: "sideChatTabsBySession" as const,
          activeField: "sideChatActiveTabByPanel" as const,
          tabs: state.sideChatTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "mcpAppTabsBySession" as const,
          activeField: "mcpAppActiveTabByPanel" as const,
          tabs: state.mcpAppTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "planTabsBySession" as const,
          activeField: "planActiveTabByPanel" as const,
          tabs: state.planTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "automationTabsBySession" as const,
          activeField: "automationActiveTabByPanel" as const,
          tabs: state.automationTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "backgroundAgentTabsBySession" as const,
          activeField: "backgroundAgentActiveTabByPanel" as const,
          tabs: state.backgroundAgentTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "processOutputTabsBySession" as const,
          activeField: "processOutputActiveTabByPanel" as const,
          tabs: state.processOutputTabsBySession[sessionId] ?? [],
        },
        {
          tabsField: "imageEditorTabsBySession" as const,
          activeField: "imageEditorActiveTabByPanel" as const,
          tabs: state.imageEditorTabsBySession[sessionId] ?? [],
        },
      ];
      for (const candidate of candidates) {
        const tab = candidate.tabs.find((item) => item.id === tabId);
        if (!tab) continue;
        const targetLeafId = tab.leafId ?? leafId;
        const slotKeys = [
          makeWorkbenchSessionPanelSlotKey(sessionId, panelId, targetLeafId),
          makeWorkbenchSessionPanelSlotKey(sessionId, panelId),
        ];
        dispatch({
          type: "remove-ephemeral-tab",
          tabsField: candidate.tabsField,
          activeField: candidate.activeField,
          sessionId,
          tabId,
          slotKeys,
          ...("planKey" in tab ? { planKey: tab.planKey } : {}),
        });
        tabOpenerStore.recordClosed(
          makeWorkbenchSessionPanelSlotKey(sessionId, panelId, targetLeafId),
          tabId,
        );
        return tab;
      }
      return null;
    },
    [dispatch, owner, tabOpenerStore],
  );
  const upsertEphemeralTab = useCallback(
    (tab: WorkbenchEphemeralTab) => {
      const upsert = <Tab extends WorkbenchEphemeralTab>(current: readonly Tab[]): Tab[] => {
        const existing = current.find((candidate) => candidate.id === tab.id);
        if (!existing) return [...current, tab as Tab];
        return current.map((candidate) =>
          candidate.id === tab.id
            ? ({
                ...candidate,
                ...tab,
                stateKey: candidate.stateKey + 1,
              } as Tab)
            : candidate,
        );
      };
      let activeField:
        | "sideChatActiveTabByPanel"
        | "mcpAppActiveTabByPanel"
        | "planActiveTabByPanel"
        | "automationActiveTabByPanel"
        | "backgroundAgentActiveTabByPanel"
        | "processOutputActiveTabByPanel"
        | "imageEditorActiveTabByPanel";
      if ("sideChat" in tab) {
        activeField = "sideChatActiveTabByPanel";
        dispatch({
          type: "update",
          field: "sideChatTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else if ("mcpApp" in tab) {
        activeField = "mcpAppActiveTabByPanel";
        dispatch({
          type: "update",
          field: "mcpAppTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else if ("planPanel" in tab) {
        activeField = "planActiveTabByPanel";
        dispatch({
          type: "update",
          field: "planTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else if ("automationPanel" in tab) {
        activeField = "automationActiveTabByPanel";
        dispatch({
          type: "update",
          field: "automationTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else if ("processOutputPanel" in tab) {
        activeField = "processOutputActiveTabByPanel";
        dispatch({
          type: "update",
          field: "processOutputTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else if ("imageEditor" in tab) {
        activeField = "imageEditorActiveTabByPanel";
        dispatch({
          type: "update",
          field: "imageEditorTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      } else {
        activeField = "backgroundAgentActiveTabByPanel";
        dispatch({
          type: "update",
          field: "backgroundAgentTabsBySession",
          update: (current) => ({
            ...current,
            [tab.sessionId]: upsert(current[tab.sessionId] ?? []),
          }),
        });
      }
      dispatch({
        type: "select-slot",
        slotKeys: [
          makeWorkbenchSessionPanelSlotKey(tab.sessionId, tab.panelId, tab.leafId),
          makeWorkbenchSessionPanelSlotKey(tab.sessionId, tab.panelId),
        ],
        activeField,
        tabId: tab.id,
        sessionId: tab.sessionId,
        ...("planKey" in tab ? { planKey: tab.planKey } : {}),
      });
      if (tab.leafId) {
        tabOpenerStore.recordActivated(
          makeWorkbenchSessionPanelSlotKey(tab.sessionId, tab.panelId, tab.leafId),
          tab.id,
          [tab.id],
        );
      }
    },
    [dispatch, tabOpenerStore],
  );

  return useMemo(
    () => ({
      ...state,
      ...commands,
      pruneOwner,
      pruneSession,
      tabOpenerStore,
      durable,
      sceneDurable,
      selectRenderableTab,
      removeEphemeralTab,
      upsertEphemeralTab,
    }),
    [
      commands,
      durable,
      sceneDurable,
      pruneOwner,
      pruneSession,
      removeEphemeralTab,
      selectRenderableTab,
      state,
      tabOpenerStore,
      upsertEphemeralTab,
    ],
  );
}
