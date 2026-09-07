import type {
  AgentPanelTab,
  AutomationPanelTab,
  ImageEditorPanelTab,
  McpAppPanelTab,
  PlanPanelTab,
  ProcessOutputPanelTab,
  ProcessOutputPanelTarget,
  SideChatPanelTab,
} from "./workbench-panel-tab-model";
import { makeWorkbenchSessionPanelOwnerKey } from "./workbench-panel-slot-key";
import type { ProjectSessionPreviewTab } from "./workbench-panel-preview";
import type { WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";

export interface WorkbenchEphemeralPanelState {
  readonly previewTabsByPanel: Record<string, ProjectSessionPreviewTab>;
  readonly previewSurfacesByPanel: Record<string, WorkbenchSurfaceDescriptor>;
  readonly sideChatTabsBySession: Record<string, SideChatPanelTab[]>;
  readonly sideChatActiveTabByPanel: Record<string, string>;
  readonly mcpAppTabsBySession: Record<string, McpAppPanelTab[]>;
  readonly mcpAppActiveTabByPanel: Record<string, string>;
  readonly planTabsBySession: Record<string, PlanPanelTab[]>;
  readonly planActiveTabByPanel: Record<string, string>;
  readonly automationTabsBySession: Record<string, AutomationPanelTab[]>;
  readonly automationActiveTabByPanel: Record<string, string>;
  readonly backgroundAgentTabsBySession: Record<string, AgentPanelTab[]>;
  readonly backgroundAgentActiveTabByPanel: Record<string, string>;
  readonly processOutputTabsBySession: Record<string, ProcessOutputPanelTab[]>;
  readonly processOutputActiveTabByPanel: Record<string, string>;
  readonly imageEditorTabsBySession: Record<string, ImageEditorPanelTab[]>;
  readonly imageEditorActiveTabByPanel: Record<string, string>;
  readonly pendingProcessOutputOpen: ProcessOutputPanelTarget | null;
  readonly activePlanKeyBySession: Record<string, string>;
  readonly panelCollapsedOverrides: Record<string, boolean>;
  /** Mixed durable/preview/auxiliary order; only durable membership belongs in the saved Scene. */
  readonly tabOrderByPanelGroup: Record<string, readonly string[]>;
}

export type WorkbenchEphemeralPanelStateField = keyof WorkbenchEphemeralPanelState;

export type WorkbenchEphemeralPanelStateUpdate<Value> = Value | ((previous: Value) => Value);

type UpdateAction = {
  [Field in WorkbenchEphemeralPanelStateField]: {
    readonly type: "update";
    readonly field: Field;
    readonly update: WorkbenchEphemeralPanelStateUpdate<WorkbenchEphemeralPanelState[Field]>;
  };
}[WorkbenchEphemeralPanelStateField];

export type WorkbenchEphemeralPanelAction =
  | UpdateAction
  | {
      readonly type: "select-slot";
      readonly slotKeys: readonly string[];
      readonly activeField:
        | "sideChatActiveTabByPanel"
        | "mcpAppActiveTabByPanel"
        | "planActiveTabByPanel"
        | "automationActiveTabByPanel"
        | "backgroundAgentActiveTabByPanel"
        | "processOutputActiveTabByPanel"
        | "imageEditorActiveTabByPanel"
        | null;
      readonly tabId: string | null;
      readonly sessionId: string;
      readonly planKey?: string;
    }
  | {
      readonly type: "remove-ephemeral-tab";
      readonly tabsField:
        | "sideChatTabsBySession"
        | "mcpAppTabsBySession"
        | "planTabsBySession"
        | "automationTabsBySession"
        | "backgroundAgentTabsBySession"
        | "processOutputTabsBySession"
        | "imageEditorTabsBySession";
      readonly activeField:
        | "sideChatActiveTabByPanel"
        | "mcpAppActiveTabByPanel"
        | "planActiveTabByPanel"
        | "automationActiveTabByPanel"
        | "backgroundAgentActiveTabByPanel"
        | "processOutputActiveTabByPanel"
        | "imageEditorActiveTabByPanel";
      readonly sessionId: string;
      readonly tabId: string;
      readonly slotKeys: readonly string[];
      readonly planKey?: string;
    }
  | {
      readonly type: "prune-session";
      readonly sessionId: string;
    }
  | {
      readonly type: "prune-owner";
      readonly ownerKey: string;
    };

export function createWorkbenchEphemeralPanelState(): WorkbenchEphemeralPanelState {
  return {
    previewTabsByPanel: {},
    previewSurfacesByPanel: {},
    sideChatTabsBySession: {},
    sideChatActiveTabByPanel: {},
    mcpAppTabsBySession: {},
    mcpAppActiveTabByPanel: {},
    planTabsBySession: {},
    planActiveTabByPanel: {},
    automationTabsBySession: {},
    automationActiveTabByPanel: {},
    backgroundAgentTabsBySession: {},
    backgroundAgentActiveTabByPanel: {},
    processOutputTabsBySession: {},
    processOutputActiveTabByPanel: {},
    imageEditorTabsBySession: {},
    imageEditorActiveTabByPanel: {},
    pendingProcessOutputOpen: null,
    activePlanKeyBySession: {},
    panelCollapsedOverrides: {},
    tabOrderByPanelGroup: {},
  };
}

function removeRecordKey<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Record<string, Value> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function removeOwnerSlotKeys<Value>(
  record: Readonly<Record<string, Value>>,
  ownerKey: string,
): Record<string, Value> {
  const prefix = `${ownerKey}:`;
  const entries = Object.entries(record).filter(
    ([key]) => key !== ownerKey && !key.startsWith(prefix),
  );
  if (entries.length === Object.keys(record).length) return record;
  return Object.fromEntries(entries);
}

function pruneOwner(
  state: WorkbenchEphemeralPanelState,
  ownerKey: string,
): WorkbenchEphemeralPanelState {
  return {
    ...state,
    previewSurfacesByPanel: removeOwnerSlotKeys(state.previewSurfacesByPanel, ownerKey),
    panelCollapsedOverrides: removeOwnerSlotKeys(state.panelCollapsedOverrides, ownerKey),
    tabOrderByPanelGroup: removeOwnerSlotKeys(state.tabOrderByPanelGroup, ownerKey),
  };
}

function pruneSession(
  state: WorkbenchEphemeralPanelState,
  sessionId: string,
): WorkbenchEphemeralPanelState {
  const ownerKey = makeWorkbenchSessionPanelOwnerKey(sessionId);
  return {
    ...pruneOwner(state, ownerKey),
    previewTabsByPanel: removeOwnerSlotKeys(state.previewTabsByPanel, ownerKey),
    sideChatTabsBySession: removeRecordKey(state.sideChatTabsBySession, sessionId),
    sideChatActiveTabByPanel: removeOwnerSlotKeys(state.sideChatActiveTabByPanel, ownerKey),
    mcpAppTabsBySession: removeRecordKey(state.mcpAppTabsBySession, sessionId),
    mcpAppActiveTabByPanel: removeOwnerSlotKeys(state.mcpAppActiveTabByPanel, ownerKey),
    planTabsBySession: removeRecordKey(state.planTabsBySession, sessionId),
    planActiveTabByPanel: removeOwnerSlotKeys(state.planActiveTabByPanel, ownerKey),
    automationTabsBySession: removeRecordKey(state.automationTabsBySession, sessionId),
    automationActiveTabByPanel: removeOwnerSlotKeys(state.automationActiveTabByPanel, ownerKey),
    backgroundAgentTabsBySession: removeRecordKey(state.backgroundAgentTabsBySession, sessionId),
    backgroundAgentActiveTabByPanel: removeOwnerSlotKeys(
      state.backgroundAgentActiveTabByPanel,
      ownerKey,
    ),
    processOutputTabsBySession: removeRecordKey(state.processOutputTabsBySession, sessionId),
    processOutputActiveTabByPanel: removeOwnerSlotKeys(
      state.processOutputActiveTabByPanel,
      ownerKey,
    ),
    imageEditorTabsBySession: removeRecordKey(state.imageEditorTabsBySession, sessionId),
    imageEditorActiveTabByPanel: removeOwnerSlotKeys(state.imageEditorActiveTabByPanel, ownerKey),
    activePlanKeyBySession: removeRecordKey(state.activePlanKeyBySession, sessionId),
  };
}

const ACTIVE_SELECTION_FIELDS = [
  "sideChatActiveTabByPanel",
  "mcpAppActiveTabByPanel",
  "planActiveTabByPanel",
  "automationActiveTabByPanel",
  "backgroundAgentActiveTabByPanel",
  "processOutputActiveTabByPanel",
  "imageEditorActiveTabByPanel",
] as const;

function clearKeys<Value>(
  record: Readonly<Record<string, Value>>,
  keys: readonly string[],
): Record<string, Value> {
  if (!keys.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function selectSlot(
  state: WorkbenchEphemeralPanelState,
  action: Extract<WorkbenchEphemeralPanelAction, { readonly type: "select-slot" }>,
): WorkbenchEphemeralPanelState {
  const next = {
    ...state,
    previewTabsByPanel: clearKeys(state.previewTabsByPanel, action.slotKeys),
  };
  for (const field of ACTIVE_SELECTION_FIELDS) {
    const cleared = clearKeys(state[field], action.slotKeys);
    next[field] =
      field === action.activeField && action.tabId && action.slotKeys[0]
        ? {
            ...cleared,
            [action.slotKeys[0]]: action.tabId,
          }
        : cleared;
  }
  if (action.planKey !== undefined) {
    next.activePlanKeyBySession = {
      ...state.activePlanKeyBySession,
      [action.sessionId]: action.planKey,
    };
  }
  const sameRecord = (
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
  ) =>
    left === right ||
    (Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => left[key] === right[key]));
  if (
    next.previewTabsByPanel === state.previewTabsByPanel &&
    ACTIVE_SELECTION_FIELDS.every((field) => sameRecord(next[field], state[field])) &&
    sameRecord(next.activePlanKeyBySession, state.activePlanKeyBySession)
  )
    return state;
  return next;
}

function removeEphemeralTab(
  state: WorkbenchEphemeralPanelState,
  action: Extract<WorkbenchEphemeralPanelAction, { readonly type: "remove-ephemeral-tab" }>,
): WorkbenchEphemeralPanelState {
  const currentTabs = state[action.tabsField][action.sessionId] ?? [];
  const activeSelection = state[action.activeField];
  const nextActiveSelection = { ...activeSelection };
  for (const key of action.slotKeys) {
    if (nextActiveSelection[key] === action.tabId) {
      delete nextActiveSelection[key];
    }
  }
  const next = {
    ...state,
    [action.tabsField]: {
      ...state[action.tabsField],
      [action.sessionId]: currentTabs.filter((tab) => tab.id !== action.tabId),
    },
    [action.activeField]: nextActiveSelection,
  };
  if (
    action.planKey !== undefined &&
    state.activePlanKeyBySession[action.sessionId] === action.planKey
  ) {
    next.activePlanKeyBySession = removeRecordKey(state.activePlanKeyBySession, action.sessionId);
  }
  return next;
}

export function reduceWorkbenchEphemeralPanelState(
  state: WorkbenchEphemeralPanelState,
  action: WorkbenchEphemeralPanelAction,
): WorkbenchEphemeralPanelState {
  if (action.type === "prune-owner") {
    return pruneOwner(state, action.ownerKey);
  }
  if (action.type === "prune-session") {
    return pruneSession(state, action.sessionId);
  }
  if (action.type === "select-slot") {
    return selectSlot(state, action);
  }
  if (action.type === "remove-ephemeral-tab") {
    return removeEphemeralTab(state, action);
  }

  const previous = state[action.field];
  const next =
    typeof action.update === "function"
      ? (action.update as (value: typeof previous) => typeof previous)(previous)
      : action.update;
  if (Object.is(previous, next)) return state;
  return {
    ...state,
    [action.field]: next,
  };
}
