import type {
  BackupRecord,
  BackupSettings,
  HistorySettings,
  AppUpdateSettings,
  AppUpdateStatus,
  Board,
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexConnectionState,
  CodexCollaborationModePreset,
  CodexEvent,
  CodexModelOption,
  CodexPermissionMode,
  CodexThreadStartForCardInput,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexTurnStartOptions,
  CodexTurnSummary,
  ManagedWorktreeRecord,
  WorktreeEnvironmentOption,
  BlockDropImportInput,
  BlockDropImportResult,
  CalendarOccurrence,
  ClipboardPasteInspectionResult,
  CardCreateInput,
  CardUpdateResult,
  CardDropMoveToEditorInput,
  CardDropMoveToEditorResult,
  CardOccurrenceActionInput,
  CardOccurrenceUpdateInput,
  CanvasData,
  Card,
  CardInput,
  CardCreatePlacement,
  CreateBackupInput,
  MoveCardInput,
  MoveCardToProjectInput,
  MoveCardToProjectResult,
  MoveCardsInput,
  Project,
  ProjectInput,
  RestoreBackupInput,
  RestoreBackupResult,
  ThreadNotificationSettings,
  UpdateBackupSettingsInput,
  UpdateAppUpdateSettingsInput,
  UpdateHistorySettingsInput,
  UpdateThreadNotificationSettingsInput,
} from "./types";
import type { WorkbenchResumeSnapshot } from "./workbench-resume";
import type {
  FileLinkOpenerId,
  FileLinkTarget,
} from "./file-link-openers";

export interface HistoryEntry {
  id: number;
  projectId: string;
  operation: "create" | "update" | "delete" | "move";
  cardId: string;
  status: Card["status"];
  archived: boolean;
  timestamp: string;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  fromStatus: Card["status"] | null;
  toStatus: Card["status"] | null;
  fromArchived: boolean | null;
  toArchived: boolean | null;
  fromOrder: number | null;
  toOrder: number | null;
  cardSnapshot: Card | null;
  sessionId: string | null;
  groupId: string | null;
  isUndone: boolean;
  undoOf: number | null;
}

export interface HistoryPanelFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface HistoryPanelSnapshotField {
  field: string;
  value: unknown;
}

export interface HistoryPanelDescriptionDeltaBlock {
  changeType: "added" | "removed" | "replaced";
  blockType: string;
  beforeOrdinal: number | null;
  afterOrdinal: number | null;
  beforePreview: string | null;
  afterPreview: string | null;
  beforeNfm: string | null;
  afterNfm: string | null;
}

export interface HistoryPanelDescriptionSnapshotBlock {
  ordinal: number;
  blockType: string;
  preview: string;
  nfm: string;
}

export interface HistoryPanelDescriptionDelta {
  beforeBlockCount: number;
  afterBlockCount: number;
  beforeFullText: string | null;
  afterFullText: string | null;
  blocks: HistoryPanelDescriptionDeltaBlock[];
}

export interface HistoryPanelDescriptionSnapshot {
  blockCount: number;
  blocks: HistoryPanelDescriptionSnapshotBlock[];
}

export interface HistoryPanelSnapshot {
  fields: HistoryPanelSnapshotField[];
  description: HistoryPanelDescriptionSnapshot | null;
}

export interface HistoryPanelMove {
  fromStatus: Card["status"] | null;
  toStatus: Card["status"] | null;
  fromArchived: boolean | null;
  toArchived: boolean | null;
  fromOrder: number | null;
  toOrder: number | null;
}

export interface HistoryPanelEntry {
  id: number;
  projectId: string;
  operation: "create" | "update" | "delete" | "move";
  cardId: string;
  status: Card["status"];
  archived: boolean;
  timestamp: string;
  sessionId: string | null;
  groupId: string | null;
  isUndone: boolean;
  undoOf: number | null;
  summary: string | null;
  fieldChanges: HistoryPanelFieldChange[];
  move: HistoryPanelMove | null;
  descriptionChange: HistoryPanelDescriptionDelta | null;
  snapshot: HistoryPanelSnapshot | null;
}

export interface UndoRedoState {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
}

export interface UndoRedoResult extends UndoRedoState {
  success: boolean;
  entry?: { operation: string; cardId: string };
  error?: string;
}

export interface SchemaResult {
  tables: {
    name: string;
    columns: {
      name: string;
      type: string;
      nullable: boolean;
      defaultValue: string | null;
      primaryKey: boolean;
    }[];
  }[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
}

export interface BoardChangeEvent {
  projectId: string;
  changeType: string;
  status: Card["status"];
  cardId?: string;
}

export interface IpcApi {
  "projects:list": { args: []; result: Project[] };
  "projects:get": { args: [projectId: string]; result: Project | null };
  "projects:create": { args: [input: ProjectInput]; result: Project };
  "projects:rename": {
    args: [
      oldId: string,
      newId: string,
      updates?: { name?: string; description?: string; icon?: string; workspacePath?: string | null },
    ];
    result: Project | null;
  };
  "projects:delete": { args: [projectId: string]; result: boolean };
  "board:get": { args: [projectId: string]; result: Board };
  "card:create": {
    args: [projectId: string, status: Card["status"], input: CardCreateInput, sessionId?: string, placement?: CardCreatePlacement];
    result: Card;
  };
  "card:update": {
    args: [
      projectId: string,
      status: Card["status"] | undefined,
      cardId: string,
      updates: Partial<CardInput>,
      sessionId?: string,
      expectedRevision?: number,
    ];
    result: CardUpdateResult;
  };
  "card:get": {
    args: [projectId: string, cardId: string, status?: Card["status"]];
    result: Card | null;
  };
  "card:delete": {
    args: [projectId: string, status: Card["status"] | undefined, cardId: string, sessionId?: string];
    result: boolean;
  };
  "card:move": {
    args: [input: MoveCardInput & { projectId: string; sessionId?: string }];
    result: boolean;
  };
  "card:move-many": {
    args: [input: MoveCardsInput & { projectId: string; sessionId?: string }];
    result: boolean;
  };
  "card:move-to-project": {
    args: [input: MoveCardToProjectInput & { sessionId?: string }];
    result: MoveCardToProjectResult;
  };
  "card:import-block-drop": {
    args: [projectId: string, input: BlockDropImportInput, sessionId?: string];
    result: BlockDropImportResult;
  };
  "card:move-drop-to-editor": {
    args: [projectId: string, input: CardDropMoveToEditorInput, sessionId?: string];
    result: CardDropMoveToEditorResult;
  };
  "calendar:occurrences": {
    args: [projectId: string, windowStart: Date, windowEnd: Date, searchQuery?: string];
    result: { occurrences: CalendarOccurrence[] };
  };
  "card:occurrence:complete": {
    args: [projectId: string, input: CardOccurrenceActionInput, sessionId?: string];
    result: { success: boolean; error?: string };
  };
  "card:occurrence:skip": {
    args: [projectId: string, input: CardOccurrenceActionInput, sessionId?: string];
    result: { success: boolean; error?: string };
  };
  "card:occurrence:update": {
    args: [projectId: string, input: CardOccurrenceUpdateInput, sessionId?: string];
    result: { success: boolean; error?: string };
  };
  "history:recent": {
    args: [projectId: string, sessionId?: string];
    result: UndoRedoState & { entries: HistoryEntry[] };
  };
  "history:card": {
    args: [projectId: string, cardId: string];
    result: { entries: HistoryPanelEntry[] };
  };
  "history:undo": {
    args: [projectId: string, sessionId?: string];
    result: UndoRedoResult;
  };
  "history:redo": {
    args: [projectId: string, sessionId?: string];
    result: UndoRedoResult;
  };
  "history:revert": {
    args: [projectId: string, historyId: number, sessionId?: string];
    result: { success: boolean; error?: string };
  };
  "history:restore": {
    args: [projectId: string, cardId: string, historyId: number, sessionId?: string];
    result: { success: boolean; error?: string };
  };
  "db:schema": { args: [projectId: string]; result: SchemaResult };
  "db:query": { args: [projectId: string, sql: string, params?: unknown[]]; result: QueryResult };
  "backup:list": { args: []; result: BackupRecord[] };
  "backup:create": { args: [input?: CreateBackupInput]; result: BackupRecord };
  "backup:restore": { args: [input: RestoreBackupInput]; result: RestoreBackupResult };
  "settings:backup:get": { args: []; result: BackupSettings };
  "settings:backup:update": { args: [input: UpdateBackupSettingsInput]; result: BackupSettings };
  "settings:history:get": { args: []; result: HistorySettings };
  "settings:history:update": { args: [input: UpdateHistorySettingsInput]; result: HistorySettings };
  "settings:thread-notifications:get": { args: []; result: ThreadNotificationSettings };
  "settings:thread-notifications:update": {
    args: [input: UpdateThreadNotificationSettingsInput];
    result: ThreadNotificationSettings;
  };
  "settings:app-updates:get": { args: []; result: AppUpdateSettings };
  "settings:app-updates:update": {
    args: [input: UpdateAppUpdateSettingsInput];
    result: AppUpdateSettings;
  };
  "app:update:status": { args: []; result: AppUpdateStatus };
  "app:update:check": { args: []; result: AppUpdateStatus };
  "app:update:install": { args: []; result: boolean };
  "shell:open-file-link": {
    args: [target: FileLinkTarget, openerId: FileLinkOpenerId];
    result: boolean;
  };
  "canvas:get": { args: [projectId: string]; result: CanvasData | null };
  "canvas:save": { args: [projectId: string, data: CanvasData]; result: void };
  "asset:resolve-path": { args: [source: string]; result: string | null };
  "clipboard:inspect-paste": { args: []; result: ClipboardPasteInspectionResult };
  "window:show-emoji-panel": { args: []; result: boolean };
  "window:new": { args: []; result: boolean };
  "workbench:resume:consume": { args: []; result: WorkbenchResumeSnapshot | null };
  "workbench:resume:save": { args: [snapshot: WorkbenchResumeSnapshot]; result: boolean };
  // Internal app lifecycle handshake used to flush renderer state before window close.
  "app:flush-before-close:done": { args: [webContentsId: number]; result: void };

  // Terminal
  "pty:spawn": {
    args: [sessionId: string, opts: { cols: number; rows: number; cwd?: string }];
    result: { success: boolean; error?: string };
  };
  "pty:write": { args: [sessionId: string, data: string]; result: void };
  "pty:resize": { args: [sessionId: string, cols: number, rows: number]; result: void };
  "pty:kill": { args: [sessionId: string]; result: void };
  "pty:pick-cwd": { args: []; result: string | null };

  // Codex
  "codex:connection:status": { args: []; result: CodexConnectionState };
  "codex:account:read": { args: []; result: CodexAccountSnapshot };
  "codex:account:login:start": {
    args: [input: { type: "chatgpt" } | { type: "apiKey"; apiKey: string }];
    result: { type: "apiKey" } | { type: "chatgpt"; loginId: string; authUrl: string };
  };
  "codex:account:login:cancel": {
    args: [loginId: string];
    result: { status: "canceled" | "notFound" };
  };
  "codex:account:logout": { args: []; result: boolean };
  "codex:threads:list": {
    args: [projectId: string, opts?: { cardId?: string; includeArchived?: boolean }];
    result: CodexThreadSummary[];
  };
  "codex:model:list": {
    args: [];
    result: CodexModelOption[];
  };
  "codex:collaboration-mode:list": {
    args: [];
    result: CodexCollaborationModePreset[];
  };
  "codex:thread:start-for-card": {
    args: [CodexThreadStartForCardInput];
    result: CodexThreadDetail;
  };
  "worktrees:list": { args: []; result: ManagedWorktreeRecord[] };
  "worktrees:environments:list": { args: [projectId: string]; result: WorktreeEnvironmentOption[] };
  "worktrees:delete": { args: [threadId: string]; result: boolean };
  "codex:thread:read": {
    args: [threadId: string, includeTurns?: boolean];
    result: CodexThreadDetail | null;
  };
  "codex:thread:resume": {
    args: [threadId: string];
    result: CodexThreadDetail | null;
  };
  "codex:thread:name:set": {
    args: [threadId: string, name: string];
    result: boolean;
  };
  "codex:thread:archive": { args: [threadId: string]; result: boolean };
  "codex:thread:unarchive": { args: [threadId: string]; result: CodexThreadSummary | null };
  "codex:turn:start": {
    args: [threadId: string, prompt: string, opts?: CodexTurnStartOptions];
    result: CodexTurnSummary | null;
  };
  "codex:turn:steer": {
    args: [threadId: string, expectedTurnId: string, prompt: string, optimisticItemId?: string];
    result: { turnId: string } | null;
  };
  "codex:turn:interrupt": {
    args: [threadId: string, turnId?: string];
    result: boolean;
  };
  "codex:approval:respond": {
    args: [requestId: string, decision: CodexApprovalDecision];
    result: boolean;
  };
  "codex:user-input:respond": {
    args: [requestId: string, answers: Record<string, string[]>];
    result: boolean;
  };
  "codex:permission:mode:set": {
    args: [projectId: string, mode: CodexPermissionMode];
    result: void;
  };
  "codex:permission:mode:get": {
    args: [projectId: string];
    result: CodexPermissionMode;
  };
  "codex:permission:custom-description:get": {
    args: [projectId: string];
    result: string;
  };
}

export interface IpcEvents {
  "board-changed": BoardChangeEvent;
  "reminder:open": { projectId: string; cardId: string; occurrenceStart: string };
  "pty:data": { sessionId: string; data: string };
  "pty:exit": { sessionId: string; exitCode: number };
  "codex:event": CodexEvent;
}
