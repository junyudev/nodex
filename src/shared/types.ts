export type Priority = "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-later";

export type Estimate = "xs" | "s" | "m" | "l" | "xl";
export type ResourceBlockKind = "text" | "file" | "folder";
export type ResourceBlockMode = "materialized" | "link";

export type CardRunInTarget = "localProject" | "newWorktree" | "cloud";
export type WorktreeStartMode = "autoBranch" | "detachedHead";

export const ARCHIVE_COLUMN_ID = "n-archive";
export const ARCHIVE_COLUMN_NAME = "Archive";

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export type RecurrenceEndCondition =
  | { type: "never" }
  | { type: "untilDate"; untilDate: string };

export interface RecurrenceConfig {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekdays?: number[];
  endCondition?: RecurrenceEndCondition;
}

export interface ReminderConfig {
  offsetMinutes: number;
}

export type OccurrenceEditScope = "this" | "this-and-future" | "all";

export interface OccurrenceTimingUpdates {
  scheduledStart?: Date;
  scheduledEnd?: Date;
  isAllDay?: boolean;
  recurrence?: RecurrenceConfig | null;
  reminders?: ReminderConfig[];
  scheduleTimezone?: string | null;
}

export type OccurrenceActionSource =
  | "calendar"
  | "card-stage"
  | "notification"
  | "api";

export interface CalendarOccurrence extends Card {
  cardId: string;
  columnId: string;
  columnName: string;
  occurrenceStart: Date;
  occurrenceEnd: Date;
  isRecurring: boolean;
  thisAndFutureEquivalentToAll?: boolean;
}

export interface CardOccurrenceActionInput {
  cardId: string;
  occurrenceStart: Date;
  source: OccurrenceActionSource;
}

export interface CardOccurrenceUpdateInput extends CardOccurrenceActionInput {
  scope: OccurrenceEditScope;
  updates: OccurrenceTimingUpdates;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  estimate?: Estimate;
  tags: string[];
  dueDate?: Date;
  scheduledStart?: Date;
  scheduledEnd?: Date;
  isAllDay?: boolean;
  recurrence?: RecurrenceConfig;
  reminders?: ReminderConfig[];
  scheduleTimezone?: string;
  assignee?: string;
  agentBlocked: boolean;
  agentStatus?: string;
  runInTarget?: CardRunInTarget;
  runInLocalPath?: string;
  runInBaseBranch?: string;
  runInWorktreePath?: string;
  runInEnvironmentPath?: string;
  revision?: number;
  created: Date;
  order: number;
}

export interface Column {
  id: string;
  name: string;
  cards: Card[];
}

export interface Board {
  columns: Column[];
}

export interface CardInput {
  title: string;
  description?: string;
  priority?: Priority;
  estimate?: Estimate | null;
  tags?: string[];
  dueDate?: Date | null;
  scheduledStart?: Date | null;
  scheduledEnd?: Date | null;
  isAllDay?: boolean | null;
  recurrence?: RecurrenceConfig | null;
  reminders?: ReminderConfig[];
  scheduleTimezone?: string | null;
  assignee?: string;
  agentBlocked?: boolean;
  agentStatus?: string;
  runInTarget?: CardRunInTarget;
  runInLocalPath?: string | null;
  runInBaseBranch?: string | null;
  runInWorktreePath?: string | null;
  runInEnvironmentPath?: string | null;
}

export interface CardCreateInput extends CardInput {
  clientId?: string;
}

export type CardUpdateResult =
  | {
      status: "updated";
      card: Card;
      columnId: string;
    }
  | {
      status: "conflict";
      card: Card;
      columnId: string;
    }
  | {
      status: "not_found";
    };

export type CardCreatePlacement = "top" | "bottom";

export interface MoveCardInput {
  cardId: string;
  fromColumnId?: string;
  toColumnId: string;
  newOrder?: number;
  groupId?: string;
}

export interface MoveCardsInput {
  cardIds: string[];
  fromColumnId?: string;
  toColumnId: string;
  newOrder?: number;
  groupId?: string;
}

export interface MoveCardToProjectInput {
  cardId: string;
  sourceProjectId: string;
  sourceColumnId?: string;
  targetProjectId: string;
  targetColumnId?: string;
}

export interface MoveCardToProjectResult {
  cardId: string;
  sourceProjectId: string;
  sourceColumnId: string;
  targetProjectId: string;
  targetColumnId: string;
}

export interface BlockDropImportSourceUpdate {
  projectId: string;
  columnId?: string;
  cardId: string;
  updates: Partial<CardInput>;
}

export interface BlockDropImportInput {
  targetColumnId: string;
  insertIndex?: number;
  cards: CardCreateInput[];
  sourceUpdates: BlockDropImportSourceUpdate[];
  groupId?: string;
}

export interface BlockDropImportResult {
  cards: Card[];
  groupId: string;
}

export interface CardDropMoveToEditorInput {
  sourceProjectId?: string;
  sourceCardId: string;
  sourceColumnId?: string;
  sourceCards?: Array<{
    cardId: string;
    columnId?: string;
  }>;
  targetUpdates: BlockDropImportSourceUpdate[];
  groupId?: string;
}

export interface CardDropMoveToEditorResult {
  sourceCardId: string;
  sourceColumnId: string;
  sourceCardIds: string[];
  updatedCardIds: string[];
  groupId: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  icon?: string;
  workspacePath?: string;
  created: Date;
}

export interface ProjectInput {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  workspacePath?: string | null;
}

export interface UploadedResourceAsset {
  source: string;
  name: string;
  mimeType: string;
  bytes: number;
}

export interface ClipboardPasteInspectionItem {
  path: string;
  kind: Exclude<ResourceBlockKind, "text">;
  name: string;
  mimeType?: string;
  bytes?: number;
}

export interface ClipboardPasteInspectionResult {
  items: ClipboardPasteInspectionItem[];
}

export type BackupTrigger = "manual" | "auto" | "pre-restore";

export interface BackupRecord {
  version: number;
  id: string;
  createdAt: string;
  trigger: BackupTrigger;
  label: string | null;
  includesAssets: boolean;
  dbBytes: number;
  assetsBytes: number;
  totalBytes: number;
}

export interface CreateBackupInput {
  trigger?: BackupTrigger;
  label?: string;
}

export interface BackupSettingsEnvOverrides {
  autoEnabled: boolean;
  intervalHours: boolean;
  retentionCount: boolean;
}

export interface ManagedWorktreeRecord {
  threadId: string;
  projectId: string;
  projectName: string | null;
  cardId: string;
  cardTitle: string | null;
  threadName: string | null;
  path: string;
  exists: boolean;
  linkedAt: string;
}

export interface WorktreeEnvironmentOption {
  path: string;
  name: string;
  hasSetupScript: boolean;
}

export interface BackupSettings {
  autoEnabled: boolean;
  intervalHours: number;
  retentionCount: number;
  envOverrides: BackupSettingsEnvOverrides;
}

export interface UpdateBackupSettingsInput {
  autoEnabled: boolean;
  intervalHours: number;
  retentionCount: number;
}

export interface ThreadNotificationSettings {
  threadCompletionEnabled: boolean;
}

export interface UpdateThreadNotificationSettingsInput {
  threadCompletionEnabled: boolean;
}

export interface RestoreBackupInput {
  backupId: string;
  confirm: boolean;
  createSafetyBackup?: boolean;
}

export interface RestoreBackupResult {
  success: boolean;
  restoredBackupId: string;
  safetyBackupId?: string;
}

export interface CanvasData {
  elements: string;
  appState: string;
  files: string;
  updated: string;
}

export type CodexThreadStatusType = "notLoaded" | "idle" | "systemError" | "active";
export type CodexThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export interface CodexConnectionState {
  status: "starting" | "connected" | "disconnected" | "missingBinary" | "error";
  message?: string;
  retries: number;
  lastConnectedAt?: number;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexRateLimitsSnapshot {
  limitId?: string;
  limitName?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: CodexRateLimitCredits;
  planType?: string;
}

export type CodexAccountIdentity =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string; planType: string };

export interface CodexAccountSnapshot {
  account: CodexAccountIdentity | null;
  requiresOpenAiAuth: boolean;
  pendingLogin?: {
    loginId: string;
    authUrl: string;
  } | null;
  rateLimits?: CodexRateLimitsSnapshot | null;
}

export interface CodexThreadSummary {
  threadId: string;
  projectId: string;
  cardId: string;
  threadName: string | null;
  threadPreview: string;
  modelProvider: string;
  cwd: string | null;
  statusType: CodexThreadStatusType;
  statusActiveFlags: CodexThreadActiveFlag[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  linkedAt: string;
}

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexCollaborationModeKind = "default" | "plan";

export interface CodexCollaborationModePreset {
  name: string;
  mode: CodexCollaborationModeKind;
  model: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort;
  description: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: CodexReasoningEffort;
  isDefault: boolean;
}

export interface CodexThreadSettings {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface CodexThreadStartForCardInput {
  projectId: string;
  cardId: string;
  prompt: string;
  threadName?: string;
  model?: string;
  permissionMode?: CodexPermissionMode;
  reasoningEffort?: CodexReasoningEffort;
  collaborationMode?: CodexCollaborationModeKind;
  worktreeStartMode?: WorktreeStartMode;
  worktreeBranchPrefix?: string;
}

export interface CodexTurnStartOptions {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  permissionMode?: CodexPermissionMode;
  collaborationMode?: CodexCollaborationModeKind;
}

export type CodexPermissionMode = "sandbox" | "full-access" | "custom";

export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface CodexTurnSummary {
  threadId: string;
  turnId: string;
  status: CodexTurnStatus;
  errorMessage?: string;
  itemIds: string[];
  tokenUsage?: CodexThreadTokenUsage;
}

export type CodexItemNormalizedKind =
  | "userMessage"
  | "assistantMessage"
  | "reasoning"
  | "plan"
  | "userInputRequest"
  | "commandExecution"
  | "fileChange"
  | "toolCall"
  | "systemEvent";

export type CodexToolCallSubtype = "mcp" | "webSearch" | "generic" | "command" | "fileChange";
export type CodexItemStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

export type CodexCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export interface CodexToolCallView {
  toolName: string;
  server?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  subtype: CodexToolCallSubtype;
}

export interface CodexItemView {
  threadId: string;
  turnId: string;
  itemId: string;
  type: string;
  normalizedKind: CodexItemNormalizedKind;
  status?: CodexItemStatus;
  role?: "user" | "assistant";
  toolCall?: CodexToolCallView;
  markdownText?: string;
  userInputQuestions?: CodexUserInputQuestion[];
  userInputAnswers?: Record<string, string[]>;
  rawItem?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface CodexThreadDetail extends CodexThreadSummary {
  turns: CodexTurnSummary[];
  items: CodexItemView[];
}

export type CodexApprovalKind = "command" | "file";
export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexApprovalRequest {
  requestId: string;
  kind: CodexApprovalKind;
  projectId: string | null;
  cardId: string | null;
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
  command?: string;
  cwd?: string;
  createdAt: number;
}

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: CodexUserInputOption[];
}

export interface CodexUserInputRequest {
  requestId: string;
  projectId: string | null;
  cardId: string | null;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
  createdAt: number;
}

export interface CodexPlanImplementationRequest {
  requestId: string;
  projectId: string | null;
  cardId: string | null;
  threadId: string;
  turnId: string;
  itemId: string;
  planContent: string;
  createdAt: number;
}

export type CodexThreadStartProgressPhase =
  | "creatingWorktree"
  | "runningSetup"
  | "startingThread"
  | "ready"
  | "failed";

export type CodexThreadStartProgressStream = "info" | "stdout" | "stderr";

export type CodexEvent =
  | { type: "connection"; connection: CodexConnectionState }
  | { type: "account"; account: CodexAccountSnapshot }
  | { type: "rateLimits"; rateLimits: CodexRateLimitsSnapshot | null }
  | { type: "threadSummary"; thread: CodexThreadSummary }
  | { type: "threadArchivedState"; threadId: string; archived: boolean }
  | {
      type: "threadStatus";
      threadId: string;
      statusType: CodexThreadStatusType;
      statusActiveFlags: CodexThreadActiveFlag[];
    }
  | { type: "turn"; turn: CodexTurnSummary }
  | { type: "itemUpsert"; item: CodexItemView }
  | { type: "itemDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "approvalRequested"; request: CodexApprovalRequest }
  | { type: "approvalResolved"; requestId: string; decision: CodexApprovalDecision }
  | { type: "userInputRequested"; request: CodexUserInputRequest }
  | { type: "userInputResolved"; requestId: string }
  | {
      type: "threadStartProgress";
      projectId: string;
      cardId: string;
      phase: CodexThreadStartProgressPhase;
      message: string;
      stream?: CodexThreadStartProgressStream;
      outputDelta?: string;
      clearOutput?: boolean;
      updatedAt: number;
    }
  | { type: "error"; message: string; detail?: string };
