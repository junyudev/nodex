import type { WorkbenchSurfaceReveal } from "../../shared/nodex-app-tools/workbench-reveal";
import {
  WorkbenchSceneSnapshotSchema,
  WorkbenchSurfaceDescriptorSchema,
} from "../../shared/schemas/workbench-scene";
import {
  canonicalWorkbenchFilesConfig,
  workbenchFileResourceId,
} from "../../shared/workbench-resource-identity";
import { workbenchSurfaceFromPreviewTab } from "./workbench-panel-preview";
import type {
  WorkbenchCommand,
  WorkbenchCommandEnvelope,
  WorkbenchCommandError,
  WorkbenchCommandReceipt,
} from "../../shared/nodex-app-tools/workbench-commands";
import type {
  WorkbenchObservedTab,
  WorkbenchRendererObservation,
} from "../../shared/nodex-app-tools/workbench";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import {
  findWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
  type WorkbenchPanelSplitSide,
} from "../../shared/workbench-panel-layout";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  getWorkbenchSurfaceReuseKey,
  isWorkbenchScenePanelSurfaceAllowed,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  maximizeWorkbenchSceneLeaf,
  mergeWorkbenchSceneLeaf,
  moveWorkbenchSceneSurface,
  patchWorkbenchScenePanel,
  removeWorkbenchSceneSurface,
  reorderWorkbenchSceneSurfaces,
  resolveWorkbenchSceneSurface,
  insertWorkbenchSceneLeaf,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
  type WorkbenchSceneSurfaceRemoveOptions,
} from "../../shared/workbench-scene";
import type { PanelId } from "../../shared/types";
import type { WorkbenchSceneLocation } from "../../shared/workbench-layout";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import {
  reduceWorkbenchEphemeralPanelState,
  type WorkbenchEphemeralPanelState,
} from "./workbench-ephemeral-panel-state";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import { getPanelTabPlacement, isPanelTabClosable } from "./workbench-panel-tab-model";
import { resolvePanelTabCloseReplacement } from "./panel-tab-close-routing";
import type { WorkbenchPanelTabOpenerState } from "./workbench-panel-tab-opener-state";
import {
  WorkbenchPresentationConflict,
  type WorkbenchWindowOwner,
  type WorkbenchWindowPresentationState,
} from "./workbench-window-owner";

const auxiliaryFields = [
  ["sideChatTabsBySession", "sideChatActiveTabByPanel"],
  ["mcpAppTabsBySession", "mcpAppActiveTabByPanel"],
  ["planTabsBySession", "planActiveTabByPanel"],
  ["automationTabsBySession", "automationActiveTabByPanel"],
  ["backgroundAgentTabsBySession", "backgroundAgentActiveTabByPanel"],
  ["processOutputTabsBySession", "processOutputActiveTabByPanel"],
  ["imageEditorTabsBySession", "imageEditorActiveTabByPanel"],
] as const;
type AuxiliaryField = (typeof auxiliaryFields)[number][0];
export type WorkbenchCommandAuxiliaryTab =
  WorkbenchEphemeralPanelState[AuxiliaryField][string][number];

export interface WorkbenchCommandTab {
  readonly observed: WorkbenchObservedTab;
  readonly surface: WorkbenchSurfaceDescriptor | null;
  readonly auxiliary: WorkbenchCommandAuxiliaryTab | null;
}

export interface WorkbenchSceneCommandLifecycle {
  readonly didApply?: (
    sceneOwner: WorkbenchSceneOwner,
    command: WorkbenchCommand,
    before: WorkbenchWindowPresentationState,
    after: WorkbenchWindowPresentationState,
    result: { readonly tabId: string | null; readonly groupId: string | null },
    options: WorkbenchSceneCommandOptions,
  ) => void;
  readonly getOpenerState?: (
    sceneOwner: WorkbenchSceneOwner,
    panelId: PanelId,
    groupId: string,
  ) => WorkbenchPanelTabOpenerState;
  /** Saves pending content or confirms disposal; cancellation leaves the tab intact without an error. */
  readonly prepareClose: (
    sceneOwner: WorkbenchSceneOwner,
    tab: WorkbenchCommandTab,
  ) => Promise<boolean | "cancelled">;
  /** Runs only after the exact owner removed the descriptor. Uses runtime-owner intents, never guest/PTY destruction. */
  readonly close: (sceneOwner: WorkbenchSceneOwner, tab: WorkbenchCommandTab) => Promise<void>;
}

export class WorkbenchSceneCommandRejected extends Error {
  constructor(readonly code: WorkbenchCommandError) {
    super(code);
    this.name = "WorkbenchSceneCommandRejected";
  }
}

const reject = (code: WorkbenchCommandError): never => {
  throw new WorkbenchSceneCommandRejected(code);
};
const sameOrder = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const panelSlot = (sceneOwner: WorkbenchSceneOwner, panelId: PanelId, groupId?: string) =>
  makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(sceneOwner), panelId, groupId);

function removeKeys<Value>(
  record: Readonly<Record<string, Value>>,
  keys: readonly string[],
): Record<string, Value> {
  if (!keys.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function resolveTab(
  state: WorkbenchWindowPresentationState,
  scene: WorkbenchSceneSnapshot,
  tabId: string,
): WorkbenchCommandTab {
  const observed = readWorkbenchAgentContext(state, scene.owner)?.tabs.find(
    (tab) => tab.tabId === tabId,
  );
  if (!observed) return reject("tab_not_found");
  const sessionId = scene.owner.kind === "session" ? scene.owner.sessionId : null;
  const auxiliary = sessionId
    ? (auxiliaryFields
        .flatMap<WorkbenchCommandAuxiliaryTab>(
          ([field]) => state.ephemeralPanels[field][sessionId] ?? [],
        )
        .find((tab) => tab.id === tabId) ?? null)
    : null;
  const slotKey =
    observed.panelId && observed.groupId
      ? panelSlot(scene.owner, observed.panelId, observed.groupId)
      : null;
  const fallbackKey = observed.panelId ? panelSlot(scene.owner, observed.panelId) : null;
  const preview =
    (slotKey ? state.ephemeralPanels.previewTabsByPanel[slotKey] : undefined) ??
    (fallbackKey ? state.ephemeralPanels.previewTabsByPanel[fallbackKey] : undefined);
  const previewSurface = slotKey
    ? state.ephemeralPanels.previewSurfacesByPanel[slotKey]
    : undefined;
  const surface =
    resolveWorkbenchSceneSurface(scene, tabId) ??
    (preview?.id === tabId ? workbenchSurfaceFromPreviewTab(preview) : null) ??
    (previewSurface?.id === tabId ? previewSurface : null);
  return { observed, surface, auxiliary };
}

function requireGroup(
  observation: WorkbenchRendererObservation,
  panelId: PanelId,
  groupId: string,
) {
  const group = observation.groups.find(
    (candidate) => candidate.panelId === panelId && candidate.groupId === groupId,
  );
  if (!group) return reject("group_not_found");
  return group;
}

function requireMovable(tab: WorkbenchCommandTab) {
  if (tab.observed.protected) reject("protected_primary");
  if (tab.auxiliary && !isPanelTabClosable(tab.auxiliary)) reject("invalid_placement");
  if (!tab.observed.panelId || !tab.observed.groupId) reject("invalid_placement");
}

/** Moves and splits follow the same placement the tab strip offers as drag targets. */
function requirePlacement(tab: WorkbenchCommandTab, panelId: PanelId) {
  requireMovable(tab);
  if (tab.auxiliary && !getPanelTabPlacement(tab.auxiliary).includes(panelId))
    reject("invalid_placement");
}

function clearPreview(
  ephemeral: WorkbenchEphemeralPanelState,
  sceneOwner: WorkbenchSceneOwner,
  tab: WorkbenchCommandTab,
) {
  const { panelId, groupId, tabId } = tab.observed;
  if (!panelId || !groupId || !tab.observed.preview || tab.auxiliary) return ephemeral;
  const keys = [panelSlot(sceneOwner, panelId, groupId), panelSlot(sceneOwner, panelId)];
  const previewTabsByPanel = removeKeys(
    ephemeral.previewTabsByPanel,
    keys.filter((key) => ephemeral.previewTabsByPanel[key]?.id === tabId),
  );
  const previewSurfacesByPanel = removeKeys(
    ephemeral.previewSurfacesByPanel,
    keys.filter((key) => ephemeral.previewSurfacesByPanel[key]?.id === tabId),
  );
  return previewTabsByPanel === ephemeral.previewTabsByPanel &&
    previewSurfacesByPanel === ephemeral.previewSurfacesByPanel
    ? ephemeral
    : { ...ephemeral, previewTabsByPanel, previewSurfacesByPanel };
}

function selectTab(
  ephemeral: WorkbenchEphemeralPanelState,
  sceneOwner: WorkbenchSceneOwner,
  tab: WorkbenchCommandTab,
): WorkbenchEphemeralPanelState {
  const { panelId, groupId, tabId } = tab.observed;
  if (
    !panelId ||
    !groupId ||
    sceneOwner.kind !== "session" ||
    (tab.observed.preview && !tab.auxiliary)
  )
    return ephemeral;
  const fields = auxiliaryFields.find(([field]) =>
    ephemeral[field][sceneOwner.sessionId]?.some((candidate) => candidate.id === tabId),
  );
  return reduceWorkbenchEphemeralPanelState(ephemeral, {
    type: "select-slot",
    slotKeys: [panelSlot(sceneOwner, panelId, groupId), panelSlot(sceneOwner, panelId)],
    activeField: fields?.[1] ?? null,
    tabId: fields ? tabId : null,
    sessionId: sceneOwner.sessionId,
    ...(tab.auxiliary && "planKey" in tab.auxiliary ? { planKey: tab.auxiliary.planKey } : {}),
  });
}

function removeAuxiliary(
  ephemeral: WorkbenchEphemeralPanelState,
  sceneOwner: WorkbenchSceneOwner,
  tab: WorkbenchCommandTab,
): WorkbenchEphemeralPanelState {
  if (
    sceneOwner.kind !== "session" ||
    !tab.auxiliary ||
    !tab.observed.panelId ||
    !tab.observed.groupId
  )
    return ephemeral;
  const fields = auxiliaryFields.find(([field]) =>
    ephemeral[field][sceneOwner.sessionId]?.some(
      (candidate) => candidate.id === tab.observed.tabId,
    ),
  );
  if (!fields) return ephemeral;
  return reduceWorkbenchEphemeralPanelState(ephemeral, {
    type: "remove-ephemeral-tab",
    tabsField: fields[0],
    activeField: fields[1],
    sessionId: sceneOwner.sessionId,
    tabId: tab.observed.tabId,
    slotKeys: [
      panelSlot(sceneOwner, tab.observed.panelId, tab.observed.groupId),
      panelSlot(sceneOwner, tab.observed.panelId),
    ],
    ...("planKey" in tab.auxiliary ? { planKey: tab.auxiliary.planKey } : {}),
  });
}

function moveTransient(
  ephemeral: WorkbenchEphemeralPanelState,
  sceneOwner: WorkbenchSceneOwner,
  tab: WorkbenchCommandTab,
  panelId: PanelId,
  groupId: string,
): WorkbenchEphemeralPanelState {
  if (tab.auxiliary && sceneOwner.kind === "session") {
    const next = { ...ephemeral };
    for (const [field, activeField] of auxiliaryFields) {
      const source = ephemeral[field][sceneOwner.sessionId];
      if (!source?.some((item) => item.id === tab.observed.tabId)) continue;
      const moved = source.map((item) =>
        item.id === tab.observed.tabId ? { ...item, panelId, leafId: groupId } : item,
      );
      Object.assign(next, { [field]: { ...ephemeral[field], [sceneOwner.sessionId]: moved } });
      next[activeField] = removeKeys(ephemeral[activeField], [
        panelSlot(sceneOwner, tab.observed.panelId!, tab.observed.groupId!),
        panelSlot(sceneOwner, tab.observed.panelId!),
      ]);
    }
    return selectTab(next, sceneOwner, { ...tab, observed: { ...tab.observed, panelId, groupId } });
  }
  const oldKey = panelSlot(sceneOwner, tab.observed.panelId!, tab.observed.groupId!);
  const fallbackKey = panelSlot(sceneOwner, tab.observed.panelId!);
  const nextKey = panelSlot(sceneOwner, panelId, groupId);
  const preview = ephemeral.previewTabsByPanel[oldKey] ?? ephemeral.previewTabsByPanel[fallbackKey];
  const next = clearPreview(ephemeral, sceneOwner, tab);
  if (sceneOwner.kind === "session" && preview?.id === tab.observed.tabId) {
    return {
      ...next,
      previewTabsByPanel: { ...next.previewTabsByPanel, [nextKey]: { ...preview, panelId } },
    };
  }
  if (!tab.surface) return reject("tab_not_found");
  return {
    ...next,
    previewSurfacesByPanel: { ...next.previewSurfacesByPanel, [nextKey]: tab.surface },
  };
}

interface PreparedCommand {
  readonly scene: WorkbenchSceneSnapshot;
  readonly ephemeralPanels: WorkbenchEphemeralPanelState;
  readonly closing: readonly WorkbenchCommandTab[];
  readonly tabId: string | null;
  readonly groupId: string | null;
}

export interface WorkbenchSceneCommandOptions {
  readonly reveal?: WorkbenchSurfaceReveal;
  readonly open?: {
    readonly presentation?: "activate" | "background";
    readonly targetIndex?: number;
    readonly openerTabId?: string;
  };
  /** A UI replacement may keep an empty group until its already-prepared replacement is inserted. */
  readonly remove?: WorkbenchSceneSurfaceRemoveOptions;
  /** UI navigation prepares its destination topology under the same expected-revision fence. */
  readonly preparedScene?: WorkbenchSceneSnapshot;
  readonly location?: WorkbenchSceneLocation;
  readonly surfaceId?: string;
}

function pageFileInsertionIndex(
  scene: WorkbenchSceneSnapshot,
  panelId: PanelId,
  groupId: string,
  surface: WorkbenchSurfaceDescriptor,
): number | undefined {
  if (surface.kind !== "page_file") return undefined;
  const ids = findWorkbenchPanelLeaf(scene.panels[panelId].layout, groupId)?.tabIds ?? [];
  const index = ids.findIndex((id) => {
    const source = resolveWorkbenchSceneSurface(scene, id);
    return source?.kind === "page_stage" && source.config.pageId === surface.config.pageId;
  });
  return index >= 0 ? index + 1 : undefined;
}

/** One Scene reducer used by the UI executor and the Agent's generation-fenced adapter. */
export function prepareWorkbenchSceneCommand(
  state: WorkbenchWindowPresentationState,
  sceneOwner: WorkbenchSceneOwner,
  command: WorkbenchCommand,
  options: WorkbenchSceneCommandOptions = {},
  getOpenerState?: WorkbenchSceneCommandLifecycle["getOpenerState"],
): PreparedCommand {
  const initialScene = state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)];
  if (!initialScene) return reject("scene_not_found");
  if (command.kind === "navigate_session") {
    if (sceneOwner.kind !== "session") return reject("invalid_placement");
    return {
      scene: initialScene,
      ephemeralPanels: state.ephemeralPanels,
      closing: [],
      tabId: null,
      groupId: null,
    };
  }
  if (command.kind === "open_surface" || command.kind === "activate_surface")
    return reject("invalid_command");
  const observation = readWorkbenchAgentContext(state, sceneOwner)!;
  let scene = initialScene;
  let ephemeralPanels = state.ephemeralPanels;
  const closing: WorkbenchCommandTab[] = [];
  let tabId: string | null = null;
  let groupId: string | null = "groupId" in command ? command.groupId : null;
  const closePreviewInGroup = (panelId: PanelId, leafId: string, exceptId?: string) => {
    const preview = observation.tabs.find(
      (tab) =>
        tab.panelId === panelId &&
        tab.groupId === leafId &&
        tab.preview &&
        tab.surface &&
        tab.tabId !== exceptId,
    );
    if (!preview) return;
    const resolved = resolveTab(state, initialScene, preview.tabId);
    closing.push(resolved);
    ephemeralPanels = clearPreview(ephemeralPanels, sceneOwner, resolved);
  };
  // Scene pruning sees only durable membership, so name every group in either panel that still
  // presents a tab.
  const occupiedGroupIds = (leavingTabId: string) =>
    observation.groups
      .filter((group) => group.tabIds.some((id) => id !== leavingTabId))
      .map((group) => group.groupId);
  // A tab leaving its group's only slot cannot split that group; it would only rename it.
  const insertGroupBeside = (
    panelId: PanelId,
    target: WorkbenchRendererObservation["groups"][number],
    side: WorkbenchPanelSplitSide,
    tab: WorkbenchCommandTab | null,
  ) => {
    if (tab?.observed.groupId === target.groupId && target.tabIds.length <= 1)
      return reject("invalid_placement");
    const inserted = insertWorkbenchSceneLeaf(scene, { panelId, leafId: target.groupId, side });
    if (!inserted.leafId) return reject("invalid_placement");
    scene = inserted.scene;
    return inserted.leafId;
  };
  // Every move lands in an existing group, and the group it leaves closes once it has no tabs.
  const placeTab = (tab: WorkbenchCommandTab, panelId: PanelId, targetGroupId: string) => {
    const sourcePanelId = tab.observed.panelId!;
    const sourceGroupId = tab.observed.groupId!;
    const occupied = occupiedGroupIds(tab.observed.tabId);
    if (tab.observed.persisted) {
      scene = moveWorkbenchSceneSurface(scene, {
        surfaceId: tab.observed.tabId,
        targetPanelId: panelId,
        targetLeafId: targetGroupId,
        preserveEmptyLeafIds: [...occupied, targetGroupId],
      });
      // The moved tab is shown in its new group, ahead of any renderer-only tab selected there.
      ephemeralPanels = selectTab(ephemeralPanels, sceneOwner, {
        ...tab,
        observed: { ...tab.observed, panelId, groupId: targetGroupId },
      });
      return;
    }
    ephemeralPanels = moveTransient(ephemeralPanels, sceneOwner, tab, panelId, targetGroupId);
    if (sourceGroupId !== targetGroupId && !occupied.includes(sourceGroupId))
      scene = mergeWorkbenchSceneLeaf(scene, { panelId: sourcePanelId, leafId: sourceGroupId });
    scene = activateWorkbenchSceneSurface(scene, panelId, targetGroupId);
  };
  const reorderGroup = (panelId: PanelId, leafId: string, ids: readonly string[]) => {
    const durableIds = ids.filter((id) => resolveWorkbenchSceneSurface(scene, id));
    const oldIds = findWorkbenchPanelLeaf(scene.panels[panelId].layout, leafId)?.tabIds ?? [];
    if (!sameOrder(oldIds, durableIds))
      scene = reorderWorkbenchSceneSurfaces(scene, {
        panelId,
        leafId,
        orderedSurfaceIds: durableIds,
      });
    const key = panelSlot(sceneOwner, panelId, leafId);
    if (ids.length !== durableIds.length) {
      ephemeralPanels = {
        ...ephemeralPanels,
        tabOrderByPanelGroup: { ...ephemeralPanels.tabOrderByPanelGroup, [key]: [...ids] },
      };
    } else {
      const next = removeKeys(ephemeralPanels.tabOrderByPanelGroup, [key]);
      if (next !== ephemeralPanels.tabOrderByPanelGroup)
        ephemeralPanels = { ...ephemeralPanels, tabOrderByPanelGroup: next };
    }
  };

  if (command.kind === "open_tab") {
    requireGroup(observation, command.panelId, command.groupId);
    let surface = {
      ...command.surface,
      id:
        options.surfaceId ??
        (command.surface.kind === "files" && command.surface.config.path
          ? workbenchFileResourceId(
              command.surface.config.hostId,
              command.surface.config.path,
              command.surface.config.cwd ?? command.surface.config.workspaceRoot,
            )
          : createSecureRuntimeId("surface")),
      stateKey: 0,
      state: null,
    } as WorkbenchSurfaceDescriptor;
    if (surface.kind === "files")
      surface = { ...surface, config: canonicalWorkbenchFilesConfig(surface.config) };
    if (!WorkbenchSurfaceDescriptorSchema.safeParse(surface).success)
      return reject("invalid_command");
    if (!isWorkbenchScenePanelSurfaceAllowed(sceneOwner, surface))
      return reject("invalid_placement");
    const reuseKey = getWorkbenchSurfaceReuseKey(surface);
    const existing =
      reuseKey === null
        ? undefined
        : observation.tabs.find(
            (tab) =>
              tab.surface &&
              getWorkbenchSurfaceReuseKey({ ...tab.surface, stateKey: 0, state: null }) ===
                reuseKey &&
              tab.persisted,
          );
    if (existing && options.open?.presentation === "background")
      return { scene, ephemeralPanels, closing, tabId: existing.tabId, groupId: existing.groupId };
    if (existing)
      return prepareWorkbenchSceneCommand(
        state,
        sceneOwner,
        { kind: "activate_tab", tabId: existing.tabId },
        options,
        getOpenerState,
      );
    const matchingPreview =
      reuseKey === null
        ? undefined
        : observation.tabs.find(
            (tab) =>
              tab.preview &&
              tab.surface &&
              getWorkbenchSurfaceReuseKey({ ...tab.surface, stateKey: 0, state: null }) ===
                reuseKey,
          );
    if (matchingPreview?.surface) {
      const preview = resolveTab(state, initialScene, matchingPreview.tabId);
      surface = preview.surface!;
      ephemeralPanels = clearPreview(ephemeralPanels, sceneOwner, preview);
      scene = createWorkbenchSceneSurface(scene, {
        panelId: matchingPreview.panelId!,
        targetLeafId: matchingPreview.groupId!,
        targetIndex: observation.groups
          .find((group) => group.groupId === matchingPreview.groupId)
          ?.tabIds.filter(
            (id) => resolveWorkbenchSceneSurface(scene, id) || id === matchingPreview.tabId,
          )
          .indexOf(matchingPreview.tabId),
        surface,
      });
      return {
        scene,
        ephemeralPanels,
        closing,
        tabId: surface.id,
        groupId: matchingPreview.groupId,
      };
    }
    const sourcePage =
      surface.kind === "page_file"
        ? observation.tabs.find(
            (tab) =>
              tab.panelId === command.panelId &&
              tab.groupId === command.groupId &&
              tab.surface?.kind === "page_stage" &&
              surface.kind === "page_file" &&
              tab.surface.config.pageId === surface.config.pageId,
          )
        : undefined;
    if (sourcePage?.preview) {
      const source = resolveTab(state, initialScene, sourcePage.tabId);
      if (source.surface)
        scene = createWorkbenchSceneSurface(scene, {
          panelId: command.panelId,
          targetLeafId: command.groupId,
          surface: source.surface,
        });
      ephemeralPanels = clearPreview(ephemeralPanels, sceneOwner, source);
    }
    if (options.open?.presentation !== "background")
      closePreviewInGroup(command.panelId, command.groupId, sourcePage?.tabId);
    scene = createWorkbenchSceneSurface(scene, {
      panelId: command.panelId,
      targetLeafId: command.groupId,
      presentation: options.open?.presentation,
      targetIndex:
        options.open?.targetIndex ??
        pageFileInsertionIndex(scene, command.panelId, command.groupId, surface),
      surface,
    });
    tabId = surface.id;
    const relativeSourceId =
      surface.kind === "page_file" ? (options.open?.openerTabId ?? sourcePage?.tabId) : undefined;
    if (relativeSourceId) {
      const closedIds = new Set(closing.map((tab) => tab.observed.tabId));
      const ids = (
        observation.groups.find((group) => group.groupId === command.groupId)?.tabIds ?? []
      ).filter((id) => !closedIds.has(id) && id !== surface.id);
      const index = ids.indexOf(relativeSourceId);
      if (index >= 0) {
        ids.splice(index + 1, 0, surface.id);
        reorderGroup(command.panelId, command.groupId, ids);
      }
    }
    if (options.open?.presentation === "background")
      return { scene, ephemeralPanels, closing, tabId, groupId };
    ephemeralPanels = selectTab(ephemeralPanels, sceneOwner, {
      observed: {
        tabId,
        panelId: command.panelId,
        groupId: command.groupId,
        protected: false,
        persisted: true,
        preview: false,
        selected: true,
        visible: false,
        surface,
        auxiliary: null,
      },
      surface,
      auxiliary: null,
    });
  } else if (command.kind === "activate_tab") {
    const tab = resolveTab(state, scene, command.tabId);
    tabId = tab.observed.tabId;
    groupId = tab.observed.groupId;
    if (!tab.observed.panelId || !groupId)
      return { scene, ephemeralPanels, closing, tabId, groupId };
    closePreviewInGroup(tab.observed.panelId, groupId, tabId);
    ephemeralPanels = selectTab(ephemeralPanels, sceneOwner, tab);
    scene = activateWorkbenchSceneSurface(
      scene,
      tab.observed.panelId,
      groupId,
      tab.observed.persisted ? tabId : undefined,
    );
    scene = patchWorkbenchScenePanel(scene, tab.observed.panelId, { collapsed: false });
  } else if (command.kind === "close_tab") {
    const tab = resolveTab(state, scene, command.tabId);
    requireMovable(tab);
    closing.push(tab);
    tabId = tab.observed.tabId;
    groupId = tab.observed.groupId;
    const group = requireGroup(observation, tab.observed.panelId!, groupId!);
    const replacementId =
      options.remove?.preferredActiveSurfaceId ??
      resolvePanelTabCloseReplacement({
        tabs: group.tabIds.map((id) => ({ id })),
        activeTabId: group.selectedTabId,
        closingTabId: tabId,
        openerState: getOpenerState?.(sceneOwner, tab.observed.panelId!, groupId!),
      });
    if (tab.observed.persisted) {
      scene = removeWorkbenchSceneSurface(scene, tabId, {
        ...options.remove,
        preserveEmptyLeafIds: [
          ...occupiedGroupIds(tabId),
          ...(options.remove?.preserveEmptyLeafIds ?? []),
        ],
      });
    } else {
      ephemeralPanels = tab.auxiliary
        ? removeAuxiliary(ephemeralPanels, sceneOwner, tab)
        : clearPreview(ephemeralPanels, sceneOwner, tab);
    }
    if (replacementId) {
      const replacement = resolveTab(state, initialScene, replacementId);
      ephemeralPanels = selectTab(ephemeralPanels, sceneOwner, replacement);
      if (
        replacement.observed.persisted &&
        findWorkbenchPanelLeaf(scene.panels[tab.observed.panelId!].layout, groupId!)
          ?.activeTabId !== replacementId
      )
        scene = activateWorkbenchSceneSurface(
          scene,
          tab.observed.panelId!,
          groupId!,
          replacementId,
        );
    }
    const remainingPanelTabs = observation.tabs.filter(
      (item) => item.panelId === tab.observed.panelId && item.tabId !== tabId,
    );
    if (remainingPanelTabs.length === 0)
      scene = patchWorkbenchScenePanel(scene, tab.observed.panelId!, { collapsed: true });
    if (!replacementId && !options.remove?.preserveEmptyLeafIds?.includes(groupId!))
      scene = mergeWorkbenchSceneLeaf(scene, { panelId: tab.observed.panelId!, leafId: groupId! });
  } else if (command.kind === "move_tab") {
    const tab = resolveTab(state, scene, command.tabId);
    requirePlacement(tab, command.panelId);
    let group = requireGroup(observation, command.panelId, command.groupId);
    if (command.splitSide) {
      groupId = insertGroupBeside(command.panelId, group, command.splitSide, tab);
      group = { ...group, groupId, tabIds: [], selectedTabId: null };
    }
    const order = group.tabIds.filter((id) => id !== command.tabId);
    if (command.index > order.length) return reject("invalid_order");
    if (scene.primary && order.includes(scene.primary.id) && command.index === 0)
      return reject("protected_primary");
    closePreviewInGroup(command.panelId, group.groupId, command.tabId);
    const removedIds = new Set(closing.map((item) => item.observed.tabId));
    const nextOrder = order.filter((id) => !removedIds.has(id));
    nextOrder.splice(Math.min(command.index, nextOrder.length), 0, command.tabId);
    placeTab(tab, command.panelId, group.groupId);
    reorderGroup(command.panelId, group.groupId, nextOrder);
    scene = patchWorkbenchScenePanel(scene, command.panelId, { collapsed: false });
    tabId = command.tabId;
  } else if (command.kind === "reorder_tabs") {
    const group = requireGroup(observation, command.panelId, command.groupId);
    const inputSet = new Set(command.tabIds);
    if (
      inputSet.size !== command.tabIds.length ||
      inputSet.size !== group.tabIds.length ||
      !group.tabIds.every((id) => inputSet.has(id))
    )
      return reject("invalid_order");
    if (
      scene.primary &&
      group.tabIds.includes(scene.primary.id) &&
      command.tabIds[0] !== scene.primary.id
    )
      return reject("protected_primary");
    if (!sameOrder(group.tabIds, command.tabIds))
      reorderGroup(command.panelId, command.groupId, command.tabIds);
  } else if (command.kind === "split_group") {
    const group = requireGroup(observation, command.panelId, command.groupId);
    const tab = command.tabId ? resolveTab(state, scene, command.tabId) : null;
    if (tab) requirePlacement(tab, command.panelId);
    if (tab && !group.tabIds.includes(tab.observed.tabId)) return reject("invalid_placement");
    groupId = insertGroupBeside(command.panelId, group, command.side, tab);
    tabId = tab?.observed.tabId ?? null;
    if (tab) placeTab(tab, command.panelId, groupId);
  } else if (command.kind === "merge_group") {
    const group = requireGroup(observation, command.panelId, command.groupId);
    if (scene.primary && group.tabIds.includes(scene.primary.id))
      return reject("protected_primary");
    if (listWorkbenchPanelLeaves(scene.panels[command.panelId].layout).length <= 1)
      return reject("invalid_placement");
    scene = mergeWorkbenchSceneLeaf(scene, { panelId: command.panelId, leafId: command.groupId });
    groupId = scene.panels[command.panelId].layout.activeLeafId;
    const target = requireGroup(observation, command.panelId, groupId);
    const sourceTransient = observation.tabs.filter(
      (tab) => tab.panelId === command.panelId && tab.groupId === command.groupId && !tab.persisted,
    );
    if (
      sourceTransient.some((tab) => tab.preview && tab.surface) &&
      observation.tabs.some(
        (tab) =>
          tab.panelId === command.panelId && tab.groupId === groupId && tab.preview && tab.surface,
      )
    )
      return reject("invalid_placement");
    for (const tab of sourceTransient)
      ephemeralPanels = moveTransient(
        ephemeralPanels,
        sceneOwner,
        resolveTab(state, initialScene, tab.tabId),
        command.panelId,
        groupId,
      );
    reorderGroup(command.panelId, groupId, [...target.tabIds, ...group.tabIds]);
  } else {
    if (
      command.side === undefined &&
      command.collapsed === undefined &&
      command.maximizedGroupId === undefined &&
      (!command.size || Object.keys(command.size).length === 0)
    )
      return reject("invalid_command");
    if (
      command.side !== undefined &&
      (command.panelId !== "right" || sceneOwner.kind !== "session")
    )
      return reject("invalid_placement");
    if (
      (sceneOwner.kind === "project" || sceneOwner.kind === "inbox") &&
      command.panelId === "right" &&
      (command.collapsed === true || command.size?.fullWidth === false)
    )
      return reject("protected_primary");
    if (
      sceneOwner.kind === "library" &&
      command.panelId === "right" &&
      (command.collapsed === true || command.size?.fullWidth === false)
    )
      return reject("invalid_placement");
    if (command.maximizedGroupId)
      requireGroup(observation, command.panelId, command.maximizedGroupId);
    if (
      command.panelId === "bottom" &&
      (command.size?.widthPx !== undefined || command.size?.fullWidth !== undefined)
    )
      return reject("invalid_placement");
    if (command.panelId === "right" && command.size?.heightPx !== undefined)
      return reject("invalid_placement");
    if (command.side !== undefined || command.collapsed !== undefined || command.size !== undefined)
      scene = patchWorkbenchScenePanel(scene, command.panelId, {
        ...(command.side === undefined ? {} : { side: command.side }),
        ...(command.collapsed === undefined ? {} : { collapsed: command.collapsed }),
        ...(command.size ? { size: command.size } : {}),
      });
    if (command.maximizedGroupId !== undefined)
      scene = maximizeWorkbenchSceneLeaf(scene, {
        panelId: command.panelId,
        leafId: command.maximizedGroupId,
      });
    const next = removeKeys(ephemeralPanels.panelCollapsedOverrides, [
      panelSlot(sceneOwner, command.panelId),
    ]);
    if (next !== ephemeralPanels.panelCollapsedOverrides)
      ephemeralPanels = { ...ephemeralPanels, panelCollapsedOverrides: next };
  }
  const ownerPrefix = `${makeWorkbenchSceneKey(sceneOwner)}:`;
  const retainedGroupKeys = new Set(
    (["right", "bottom"] as const).flatMap((panelId) =>
      listWorkbenchPanelLeaves(scene.panels[panelId].layout).map((leaf) =>
        panelSlot(sceneOwner, panelId, leaf.id),
      ),
    ),
  );
  const obsoleteOrderKeys = Object.keys(ephemeralPanels.tabOrderByPanelGroup).filter(
    (key) => key.startsWith(ownerPrefix) && !retainedGroupKeys.has(key),
  );
  const tabOrderByPanelGroup = removeKeys(ephemeralPanels.tabOrderByPanelGroup, obsoleteOrderKeys);
  if (tabOrderByPanelGroup !== ephemeralPanels.tabOrderByPanelGroup)
    ephemeralPanels = { ...ephemeralPanels, tabOrderByPanelGroup };
  return { scene, ephemeralPanels, closing, tabId, groupId };
}

export interface WorkbenchSceneCommandExecutor {
  readonly execute: (
    input: WorkbenchCommandEnvelope,
    isCurrent?: () => boolean,
    options?: WorkbenchSceneCommandOptions,
  ) => Promise<WorkbenchCommandReceipt>;
}

/** Shared semantic executor. UI calls it directly; Agent ingress adds only a bounded operation ledger. */
export function createWorkbenchSceneCommands(
  owner: WorkbenchWindowOwner,
  lifecycle: WorkbenchSceneCommandLifecycle,
): WorkbenchSceneCommandExecutor {
  return {
    async execute(input, isCurrent = () => true, options = {}) {
      const receipt = (patch: Partial<WorkbenchCommandReceipt> = {}): WorkbenchCommandReceipt => ({
        operationId: input.operationId,
        sceneOwner: input.sceneOwner,
        applied: false,
        persisted: false,
        presentationRevision: owner.read().presentationRevision,
        layoutRevision: null,
        tabId: null,
        groupId: null,
        error: null,
        ...patch,
      });
      let prepared: PreparedCommand;
      try {
        if (!isCurrent()) return receipt({ error: "revoked_generation" });
        if (owner.read().presentationRevision !== input.expectedPresentationRevision)
          return receipt({ error: "stale_presentation" });
        const state = owner.read();
        const sessionPresentation =
          input.command.kind === "activate_surface" ||
          input.command.kind === "open_surface" ||
          input.command.kind === "navigate_session";
        if (sessionPresentation && input.sceneOwner.kind !== "session")
          return receipt({ error: "invalid_placement" });
        const presentationScene = sessionPresentation
          ? (state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(input.sceneOwner)] ??
            materializeInitialWorkbenchScene(input.sceneOwner))
          : undefined;
        const executionOptions = {
          ...options,
          ...(presentationScene ? { preparedScene: presentationScene } : {}),
          ...(input.command.kind === "navigate_session" && input.sceneOwner.kind === "session"
            ? {
                location: {
                  kind: "session" as const,
                  sessionId: input.sceneOwner.sessionId,
                  projectContextId: input.command.projectId,
                },
              }
            : {}),
        };
        const command: WorkbenchCommand =
          input.command.kind === "open_surface"
            ? {
                kind: "open_tab",
                panelId: input.command.panelId,
                groupId: presentationScene!.panels[input.command.panelId].layout.activeLeafId,
                surface: input.command.surface,
              }
            : input.command.kind === "activate_surface"
              ? { kind: "activate_tab", tabId: input.command.tabId }
              : input.command;
        if (
          executionOptions.preparedScene &&
          makeWorkbenchSceneKey(executionOptions.preparedScene.owner) !==
            makeWorkbenchSceneKey(input.sceneOwner)
        )
          return receipt({ error: "invalid_command" });
        const preparedState = executionOptions.preparedScene
          ? {
              ...state,
              windowState: {
                ...state.windowState,
                scenesByOwnerKey: {
                  ...state.windowState.scenesByOwnerKey,
                  [makeWorkbenchSceneKey(input.sceneOwner)]: executionOptions.preparedScene,
                },
              },
            }
          : state;
        prepared = prepareWorkbenchSceneCommand(
          preparedState,
          input.sceneOwner,
          command,
          executionOptions,
          lifecycle.getOpenerState,
        );
        const reveal =
          input.command.kind === "open_surface" ? input.command.reveal : executionOptions.reveal;
        if (reveal && prepared.tabId) {
          const surface = resolveWorkbenchSceneSurface(prepared.scene, prepared.tabId);
          if (
            !surface ||
            (reveal.kind === "file" ? surface.kind !== "files" : surface.kind !== "review")
          )
            return receipt({ error: "invalid_command" });
          const previousState =
            surface.state && typeof surface.state === "object" && !Array.isArray(surface.state)
              ? surface.state
              : {};
          const revealState =
            reveal.kind === "file"
              ? {
                  pendingReveal: {
                    line: reveal.line,
                    ...(reveal.column ? { column: reveal.column } : {}),
                    ...(reveal.endLine ? { endLine: reveal.endLine } : {}),
                    ...(reveal.endColumn ? { endColumn: reveal.endColumn } : {}),
                  },
                }
              : { pendingReviewOpen: { operationId: input.operationId, intent: reveal } };
          prepared = {
            ...prepared,
            scene: updateWorkbenchSceneSurface(prepared.scene, surface.id, {
              state: { ...previousState, ...revealState },
              stateKey: surface.stateKey + 1,
            }),
          };
        }
        if (!WorkbenchSceneSnapshotSchema.safeParse(prepared.scene).success)
          return receipt({ error: "invalid_command" });
        for (const tab of prepared.closing) {
          const closePreparation = await lifecycle.prepareClose(input.sceneOwner, tab);
          if (closePreparation === "cancelled") return receipt();
          if (!closePreparation) return receipt({ error: "save_failed" });
          if (!isCurrent()) return receipt({ error: "revoked_generation" });
        }
        if (!isCurrent()) return receipt({ error: "revoked_generation" });
        const before = owner.read();
        const priorScene =
          before.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(input.sceneOwner)];
        const durableChange =
          JSON.stringify(priorScene ? { ...priorScene, touchedAt: null } : null) !==
            JSON.stringify({ ...prepared.scene, touchedAt: null }) ||
          (executionOptions.location !== undefined &&
            JSON.stringify(before.windowState.location) !==
              JSON.stringify(executionOptions.location));
        const current = owner.updateScenePresentation(
          input.sceneOwner,
          () => ({
            scene: durableChange ? prepared.scene : priorScene!,
            ephemeralPanels: prepared.ephemeralPanels,
          }),
          input.expectedPresentationRevision,
          { initialScene: executionOptions.preparedScene, location: executionOptions.location },
        );
        // Capture/queue before any runtime cleanup await, so this ack can only describe this apply.
        const persisted = owner.commitCurrent();
        lifecycle.didApply?.(
          input.sceneOwner,
          command,
          before,
          current,
          prepared,
          executionOptions,
        );
        const cleanup = Promise.all(
          prepared.closing.map((tab) =>
            Promise.resolve().then(() => lifecycle.close(input.sceneOwner, tab)),
          ),
        );
        const [commit, closed] = await Promise.allSettled([persisted, cleanup]);
        const persistenceFailed =
          commit.status === "rejected" ||
          commit.value.presentationRevision !== current.presentationRevision;
        const promotedPreview =
          priorScene &&
          prepared.tabId &&
          !priorScene.panelSurfacesById[prepared.tabId] &&
          prepared.scene.panelSurfacesById[prepared.tabId] &&
          readWorkbenchAgentContext(before, input.sceneOwner)?.tabs.some(
            (tab) => tab.tabId === prepared.tabId && tab.preview,
          );
        // A failed Keep must remain retryable. Never rewind intervening edits or another generation.
        if (
          persistenceFailed &&
          promotedPreview &&
          !executionOptions.location &&
          isCurrent() &&
          owner.read().presentationRevision === current.presentationRevision
        ) {
          const restored = owner.updateScenePresentation(
            input.sceneOwner,
            () => ({ scene: priorScene!, ephemeralPanels: before.ephemeralPanels }),
            current.presentationRevision,
          );
          return receipt({
            applied: false,
            persisted: false,
            presentationRevision: restored.presentationRevision,
            tabId: prepared.tabId,
            groupId: prepared.groupId,
            error: "persistence_failed",
          });
        }
        return receipt({
          applied: current.presentationRevision !== before.presentationRevision,
          persisted:
            durableChange &&
            commit.status === "fulfilled" &&
            commit.value.presentationRevision === current.presentationRevision,
          presentationRevision: current.presentationRevision,
          layoutRevision: commit.status === "fulfilled" ? commit.value.layoutRevision : null,
          tabId: prepared.tabId,
          groupId: prepared.groupId,
          error: persistenceFailed
            ? "persistence_failed"
            : closed.status === "rejected"
              ? "runtime_cleanup_failed"
              : null,
        });
      } catch (error) {
        return receipt({
          error:
            error instanceof WorkbenchPresentationConflict
              ? "stale_presentation"
              : error instanceof WorkbenchSceneCommandRejected
                ? error.code
                : "save_failed",
        });
      }
    },
  };
}
