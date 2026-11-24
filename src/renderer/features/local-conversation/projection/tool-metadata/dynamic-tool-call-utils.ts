import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import type { CodexAppHandoffOperation } from "../../../../../shared/codex-thread-handoff";
import { formatAutomationTriggerSummary } from "../../../../lib/automation-display";
import { automationTriggerInputSchema } from "../../../../../shared/nodex-app-tools/automation-schema";
import { formatDynamicToolCallMarkdownFallback } from "../../../../../shared/codex-dynamic-tool-markdown";
import {
  readCreatedThreadActivityResult,
  type CodexCreatedThreadResult,
} from "../../../../../shared/codex-created-thread-result";
import type {
  CodexConversationItem,
  CodexDynamicToolCallView,
  AutomationCreateInput,
  AutomationExecutionEnvironment,
  AutomationExecutionKind,
  AutomationReasoningEffort,
  AutomationStatus,
  AutomationTriggerInput,
  AutomationUpdateInput,
} from "../../../../lib/types";
import { humanizeIdentifier, resolveScriptToolTitle } from "./tool-call-utils";
import { NODEX_TOOL_ACTIVITY_TOOLS, resolveNodexToolActivity } from "./nodex-tool-activity";

const CODEX_APP_NAMESPACE = "codex_app";
const CHROME_EXTENSION_NAMESPACE = "chrome_extension";
const DYNAMIC_TOOL_COMPLETED_FALLBACK_LABELS: Record<string, MessageDescriptor> = defineMessages({
  automations_update: {
    id: "conversation.dynamicToolCallUtils.automationsUpdateCompleted",
    defaultMessage: "Automation updated",
  },
  load_workspace_dependencies: {
    id: "conversation.dynamicToolCallUtils.loadWorkspaceDependenciesCompleted",
    defaultMessage: "Loaded workspace dependencies",
  },
  pia_slackbot_dm: {
    id: "conversation.dynamicToolCallUtils.piaSlackbotDm",
    defaultMessage: "Pia Slackbot DM",
  },
  read_thread_terminal: {
    id: "conversation.dynamicToolCallUtils.readThreadTerminalCompleted",
    defaultMessage: "Read thread terminal",
  },
});

const DYNAMIC_TOOL_ACTIVE_FALLBACK_LABELS: Record<string, MessageDescriptor> = defineMessages({
  automations_update: {
    id: "conversation.dynamicToolCallUtils.automationsUpdateActive",
    defaultMessage: "Updating automation",
  },
  load_workspace_dependencies: {
    id: "conversation.dynamicToolCallUtils.loadWorkspaceDependenciesActive",
    defaultMessage: "Loading workspace dependencies",
  },
  pia_slackbot_dm: {
    id: "conversation.dynamicToolCallUtils.piaSlackbotDm",
    defaultMessage: "Pia Slackbot DM",
  },
  read_thread_terminal: {
    id: "conversation.dynamicToolCallUtils.readThreadTerminalActive",
    defaultMessage: "Reading thread terminal",
  },
});

export type DynamicToolRendererKind =
  | "automationUpdate"
  | "chromeTabContext"
  | "codexAppThread"
  | "nodexApp"
  | "settings";

export type DynamicToolRegistryEntry = {
  namespace: string | null;
  tool: string;
  rendererKind: DynamicToolRendererKind;
  continuesLiveActivityBetweenCalls?: boolean;
  standaloneInConversation?: boolean;
  summaryOnlyInConversationGroup?: boolean;
  resolveLabel: (
    call: CodexDynamicToolCallView,
    isLeadingSummaryPart?: boolean,
    intl?: IntlShape,
  ) => string | null;
  getCompletedSummaryPartKey?: (call: CodexDynamicToolCallView) => string | null;
};

const CODEX_APP_THREAD_LABELS = defineMessages({
  threadsForkActive: {
    id: "conversation.dynamicToolCallUtils.threadsForkActive",
    defaultMessage: "Forking chat",
  },
  threadsForkCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsForkCompleted",
    defaultMessage: "Forked chat",
  },
  threadsForkCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsForkCompletedFollowing",
    defaultMessage: "forked chat",
  },
  threadsForkInWorktreeActive: {
    id: "conversation.dynamicToolCallUtils.threadsForkInWorktreeActive",
    defaultMessage: "Forking chat in new worktree",
  },
  threadsForkInWorktreeCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsForkInWorktreeCompleted",
    defaultMessage: "Forked chat in new worktree",
  },
  threadsForkInWorktreeCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsForkInWorktreeCompletedFollowing",
    defaultMessage: "forked chat in new worktree",
  },
  threadsCreateActive: {
    id: "conversation.dynamicToolCallUtils.threadsCreateActive",
    defaultMessage: "Creating chat",
  },
  threadsCreateCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsCreateCompleted",
    defaultMessage: "Created chat",
  },
  threadsCreateCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsCreateCompletedFollowing",
    defaultMessage: "created chat",
  },
  threadsCreateInWorktreeActive: {
    id: "conversation.dynamicToolCallUtils.threadsCreateInWorktreeActive",
    defaultMessage: "Creating worktree chat",
  },
  threadsCreateInWorktreeCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsCreateInWorktreeCompleted",
    defaultMessage: "Created worktree chat",
  },
  threadsCreateInWorktreeCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsCreateInWorktreeCompletedFollowing",
    defaultMessage: "created worktree chat",
  },
  threadsListActive: {
    id: "conversation.dynamicToolCallUtils.threadsListActive",
    defaultMessage: "Listing chats",
  },
  threadsListCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsListCompleted",
    defaultMessage: "Listed chats",
  },
  threadsListCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsListCompletedFollowing",
    defaultMessage: "listed chats",
  },
  threadsReadActive: {
    id: "conversation.dynamicToolCallUtils.threadsReadActive",
    defaultMessage: "Reading chat",
  },
  threadsReadCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsReadCompleted",
    defaultMessage: "Read chat",
  },
  threadsReadCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsReadCompletedFollowing",
    defaultMessage: "read chat",
  },
  threadsHandoffStatusActive: {
    id: "conversation.dynamicToolCallUtils.threadsHandoffStatusActive",
    defaultMessage: "Checking handoff status",
  },
  threadsHandoffStatusCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsHandoffStatusCompleted",
    defaultMessage: "Checked handoff status",
  },
  threadsHandoffStatusCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsHandoffStatusCompletedFollowing",
    defaultMessage: "checked handoff status",
  },
  threadsSendMessageActive: {
    id: "conversation.dynamicToolCallUtils.threadsSendMessageActive",
    defaultMessage: "Sending message to chat",
  },
  threadsSendMessageCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsSendMessageCompleted",
    defaultMessage: "Sent message to chat",
  },
  threadsSendMessageCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsSendMessageCompletedFollowing",
    defaultMessage: "sent message to chat",
  },
  threadsSetArchivedActive: {
    id: "conversation.dynamicToolCallUtils.threadsSetArchivedActive",
    defaultMessage: "Updating chat archive",
  },
  threadsSetArchivedCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsSetArchivedCompleted",
    defaultMessage: "Updated chat archive",
  },
  threadsSetArchivedCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsSetArchivedCompletedFollowing",
    defaultMessage: "updated chat archive",
  },
  threadsSetPinnedActive: {
    id: "conversation.dynamicToolCallUtils.threadsSetPinnedActive",
    defaultMessage: "Updating chat pin",
  },
  threadsSetPinnedCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsSetPinnedCompleted",
    defaultMessage: "Updated chat pin",
  },
  threadsSetPinnedCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsSetPinnedCompletedFollowing",
    defaultMessage: "updated chat pin",
  },
  threadsSetTitleActive: {
    id: "conversation.dynamicToolCallUtils.threadsSetTitleActive",
    defaultMessage: "Renaming chat",
  },
  threadsSetTitleCompleted: {
    id: "conversation.dynamicToolCallUtils.threadsSetTitleCompleted",
    defaultMessage: "Renamed chat",
  },
  threadsSetTitleCompletedFollowing: {
    id: "conversation.dynamicToolCallUtils.threadsSetTitleCompletedFollowing",
    defaultMessage: "renamed chat",
  },
});

type CodexAppThreadLabelKey = keyof typeof CODEX_APP_THREAD_LABELS;

export type CodexAppHandoffStatus = "queued" | "running" | "success" | "warning" | "error";

export interface CodexAppHandoffResult {
  destinationHostDisplayName: string;
  operationId: string;
  status: CodexAppHandoffStatus;
  threadTitle: string;
}

export interface CodexAppHandoffRenderState {
  activityStatus: "completed" | "failed" | "running";
  active: boolean;
  label: string;
  result: CodexAppHandoffResult | null;
  operation: CodexAppHandoffOperation | null;
}

function isKnownHandoffStatus(value: unknown): value is CodexAppHandoffStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "success" ||
    value === "warning" ||
    value === "error"
  );
}

function resolveSettingsToolLabel(
  call: CodexDynamicToolCallView,
  isLeadingSummaryPart = true,
  intl: IntlShape = getIntl(),
): string | null {
  if (call.tool === "read_settings") {
    if (!call.completed)
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.readingSettings",
        defaultMessage: "Reading settings",
      });
    return intl.formatMessage(
      {
        id: "conversation.dynamicToolCallUtils.readSettings",
        defaultMessage: "{position, select, leading {Read settings} other {read settings}}",
      },
      { position: isLeadingSummaryPart ? "leading" : "following" },
    );
  }
  if (call.tool !== "write_settings") return null;
  if (call.completed && call.success === false) {
    return intl.formatMessage(
      {
        id: "conversation.dynamicToolCallUtils.couldntUpdateSettings",
        defaultMessage:
          "{position, select, leading {Couldn't update settings} other {couldn't update settings}}",
      },
      { position: isLeadingSummaryPart ? "leading" : "following" },
    );
  }
  if (call.completed)
    return intl.formatMessage(
      {
        id: "conversation.dynamicToolCallUtils.updatedSettings",
        defaultMessage: "{position, select, leading {Updated settings} other {updated settings}}",
      },
      { position: isLeadingSummaryPart ? "leading" : "following" },
    );
  const args = asRecord(call.arguments);
  return args && "config" in args
    ? intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.waitingForApproval",
        defaultMessage: "Waiting for approval",
      })
    : intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.updatingSettings",
        defaultMessage: "Updating settings",
      });
}

function resolveChromeTabContextLabel(
  call: CodexDynamicToolCallView,
  isLeadingSummaryPart = true,
  intl: IntlShape = getIntl(),
): string | null {
  if (parseChromeTabContextTabId(call) === null) return null;
  if (!call.completed)
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.readingTab",
      defaultMessage: "Reading tab",
    });
  return intl.formatMessage(
    {
      id: "conversation.dynamicToolCallUtils.readTab",
      defaultMessage: "{position, select, leading {Read tab} other {read tab}}",
    },
    { position: isLeadingSummaryPart ? "leading" : "following" },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getRequiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseInputTextJson(call: CodexDynamicToolCallView): Record<string, unknown> | null {
  const inputText = (call.contentItems ?? []).find((item) => item.type === "inputText")?.text;
  if (!inputText) return null;
  try {
    return asRecord(JSON.parse(inputText));
  } catch {
    return null;
  }
}

function parseAnyInputTextJson(call: CodexDynamicToolCallView): Record<string, unknown> | null {
  for (const item of call.contentItems ?? []) {
    if (item.type !== "inputText") continue;
    const text = item.text.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Keep scanning; dynamic tools often include human text before JSON.
    }
  }
  return null;
}

type AutomationUpdateDirectiveMode =
  | "create"
  | "delete"
  | "suggested-create"
  | "suggested-update"
  | "update"
  | "view";

type AutomationUpdateInputMode =
  | "create"
  | "delete"
  | "suggested_create"
  | "suggested_update"
  | "update"
  | "view";

type AutomationUpdateResultMode = "create" | "delete" | "update";

export interface AutomationUpdateToolResult {
  automationId: string;
  deleteStatus: "deleted" | "not_found" | null;
  operation: AutomationUpdateResultMode | null;
  snapshot: {
    kind: AutomationExecutionKind | null;
    name: string | null;
    trigger: AutomationTriggerInput | null;
  } | null;
}

export interface AutomationUpdateRenderState {
  proposalId?: string;
  automationId: string | null;
  canAccept: boolean;
  createInput: AutomationCreateInput | null;
  disabledReason: string | null;
  displayMode: AutomationUpdateDirectiveMode;
  openLabel: string;
  result: AutomationUpdateToolResult | null;
  statusLabel: string;
  subtitle: string | null;
  title: string;
  updateInput: AutomationUpdateInput | null;
}

function normalizeAutomationUpdateMode(value: unknown): AutomationUpdateDirectiveMode | null {
  switch (value) {
    case "create":
    case "delete":
    case "update":
    case "view":
      return value;
    case "suggested_create":
    case "suggested-create":
      return "suggested-create";
    case "suggested_update":
    case "suggested-update":
      return "suggested-update";
    default:
      return null;
  }
}

function normalizeAutomationUpdateInputMode(value: unknown): AutomationUpdateInputMode | null {
  switch (value) {
    case "create":
    case "delete":
    case "suggested_create":
    case "suggested_update":
    case "update":
    case "view":
      return value;
    case "suggested-create":
      return "suggested_create";
    case "suggested-update":
      return "suggested_update";
    default:
      return null;
  }
}

function normalizeAutomationKind(value: unknown): AutomationExecutionKind | null {
  return value === "cron" || value === "heartbeat" ? value : null;
}

function normalizeAutomationStatus(value: unknown): AutomationStatus | null {
  return value === "ACTIVE" || value === "PAUSED" ? value : null;
}

function normalizeAutomationExecutionEnvironment(
  value: unknown,
): AutomationExecutionEnvironment | null {
  return value === "local" || value === "worktree" ? value : null;
}

function normalizeAutomationReasoningEffort(value: unknown): AutomationReasoningEffort | null {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return normalizeOptionalString(value);
}

function normalizeAutomationCwds(value: unknown): string[] | null {
  const normalizeItems = (items: unknown[]): string[] => {
    const seen = new Set<string>();
    return items.flatMap((item) => {
      if (typeof item !== "string") return [];
      const normalized = item.trim();
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [normalized];
    });
  };

  if (Array.isArray(value)) return normalizeItems(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? normalizeItems(parsed) : null;
    } catch {
      return null;
    }
  }

  return normalizeItems(trimmed.split(","));
}

function parseAutomationUpdateToolResultSnapshot(
  value: unknown,
): AutomationUpdateToolResult["snapshot"] {
  const snapshot = asRecord(value);
  if (!snapshot) return null;
  return {
    kind: normalizeAutomationKind(snapshot.kind),
    name: normalizeOptionalString(snapshot.name),
    trigger: parseAutomationTriggerInput(snapshot.trigger),
  };
}

export function parseAutomationUpdateToolResult(
  call: CodexDynamicToolCallView,
): AutomationUpdateToolResult | null {
  const parsed = parseAnyInputTextJson(call);
  const automationId = normalizeOptionalString(parsed?.automationId);
  if (!automationId) return null;
  const mode =
    parsed?.operation === "create" ||
    parsed?.operation === "update" ||
    parsed?.operation === "delete"
      ? parsed.operation
      : null;
  const deleteStatus =
    parsed?.deleteStatus === "deleted" || parsed?.deleteStatus === "not_found"
      ? parsed.deleteStatus
      : null;
  return {
    automationId,
    operation: mode,
    deleteStatus,
    snapshot: parseAutomationUpdateToolResultSnapshot(parsed?.snapshot),
  };
}

function resolveAutomationUpdateStatusLabel(
  input: {
    deleteStatus: AutomationUpdateToolResult["deleteStatus"];
    mode: AutomationUpdateDirectiveMode;
  },
  intl: IntlShape,
): string {
  switch (input.mode) {
    case "create":
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.created",
        defaultMessage: "Created",
      });
    case "update":
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.updated",
        defaultMessage: "Updated",
      });
    case "delete":
      return input.deleteStatus === "not_found"
        ? intl.formatMessage({
            id: "conversation.dynamicToolCallUtils.missing",
            defaultMessage: "Missing",
          })
        : intl.formatMessage({
            id: "conversation.dynamicToolCallUtils.deleted",
            defaultMessage: "Deleted",
          });
    case "suggested-create":
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.proposed",
        defaultMessage: "Proposed",
      });
    case "suggested-update":
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.proposedUpdate",
        defaultMessage: "Proposed update",
      });
    case "view":
      return intl.formatMessage({
        id: "conversation.dynamicToolCallUtils.automation",
        defaultMessage: "Automation",
      });
  }
}

function resolveAutomationUpdateOpenLabel(
  mode: AutomationUpdateDirectiveMode,
  intl: IntlShape,
): string {
  if (mode === "suggested-create")
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.createAutomation",
      defaultMessage: "Create automation",
    });
  if (mode === "suggested-update")
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.applyChanges",
      defaultMessage: "Apply changes",
    });
  return intl.formatMessage({
    id: "conversation.dynamicToolCallUtils.open",
    defaultMessage: "Open",
  });
}

function resolveAutomationUpdateDisplayMode(
  argsMode: AutomationUpdateDirectiveMode,
  result: AutomationUpdateToolResult | null,
): AutomationUpdateDirectiveMode {
  return result?.operation ?? argsMode;
}

/** A saved clock's read-only next run is not part of the trigger an Automation is given. */
function parseAutomationTriggerInput(value: unknown): AutomationTriggerInput | null {
  const record = asRecord(value);
  if (!record) return null;
  const { nextRunAt: _nextRunAt, ...trigger } = record;
  const parsed = automationTriggerInputSchema.safeParse(trigger);
  return parsed.success ? parsed.data : null;
}

function buildAutomationUpdateCreateInput(
  args: Record<string, unknown>,
): AutomationCreateInput | null {
  const kind = normalizeAutomationKind(args.kind);
  const name = normalizeOptionalString(args.name);
  const prompt = normalizeOptionalString(args.prompt);
  const trigger = parseAutomationTriggerInput(args.trigger);
  if (!kind || !name || !prompt || !trigger) return null;
  if (kind === "heartbeat" && trigger.kind !== "clock") return null;
  const scope = asRecord(args.scope);
  const projectId = normalizeOptionalString(scope?.projectId);
  const automationScope: AutomationCreateInput["scope"] =
    scope?.kind === "space"
      ? { kind: "space" }
      : scope?.kind === "project" && projectId
        ? { kind: "project", projectId }
        : undefined;
  if (args.scope !== undefined && !automationScope) return null;
  // A proposal may ask to run automatically; only the user's apply grants it.
  const mode: AutomationCreateInput["mode"] =
    args.mode === "ask_first" || args.mode === "run" || args.mode === "dry_run"
      ? args.mode
      : undefined;
  const plan = {
    ...(automationScope ? { scope: automationScope } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof args.ownerMemberId === "string" ? { ownerMemberId: args.ownerMemberId } : {}),
    ...(typeof args.conditionText === "string" ? { conditionText: args.conditionText } : {}),
    trigger,
    runbookPageId: normalizeOptionalString(args.runbookPageId) ?? null,
  };

  if (kind === "heartbeat") {
    const targetSessionId = normalizeOptionalString(args.targetSessionId);
    if (!targetSessionId) return null;
    return {
      kind,
      targetSessionId,
      name,
      prompt,
      model: null,
      reasoningEffort: null,
      ...plan,
    };
  }

  const cwds = normalizeAutomationCwds(args.cwds);
  const executionEnvironment = normalizeAutomationExecutionEnvironment(args.executionEnvironment);
  const model = normalizeOptionalString(args.model);
  const reasoningEffort = normalizeAutomationReasoningEffort(args.reasoningEffort);
  const localEnvironmentConfigPath = normalizeNullableString(args.localEnvironmentConfigPath);
  if (cwds === null || !executionEnvironment || !model || !reasoningEffort) return null;
  return {
    kind,
    name,
    prompt,
    projectId: normalizeOptionalString(args.projectId),
    cwds,
    executionEnvironment,
    localEnvironmentConfigPath: localEnvironmentConfigPath ?? null,
    model,
    reasoningEffort,
    ...plan,
  };
}

function buildAutomationUpdateUpdateInput(
  args: Record<string, unknown>,
): AutomationUpdateInput | null {
  const id = normalizeOptionalString(args.id);
  const status = normalizeAutomationStatus(args.status);
  const createInput = buildAutomationUpdateCreateInput(args);
  if (!id || !status || !createInput) return null;
  const updateInput: AutomationUpdateInput = {
    ...createInput,
    id,
    status,
  };
  if (!Object.prototype.hasOwnProperty.call(args, "localEnvironmentConfigPath")) {
    delete updateInput.localEnvironmentConfigPath;
  }
  return updateInput;
}

function resolveAutomationUpdateDisabledReason(
  input: {
    mode: AutomationUpdateDirectiveMode;
    createInput: AutomationCreateInput | null;
    updateInput: AutomationUpdateInput | null;
  },
  intl: IntlShape,
): string | null {
  if (input.mode === "suggested-create" && !input.createInput)
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.proposalMissingFields",
      defaultMessage: "This automation proposal is missing required fields.",
    });
  if (input.mode === "suggested-update" && !input.updateInput)
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.updateMissingFields",
      defaultMessage: "This automation update is missing required fields.",
    });
  return null;
}

export function resolveAutomationUpdateRenderState(
  call: CodexDynamicToolCallView,
  intl: IntlShape = getIntl(),
): AutomationUpdateRenderState | null {
  if (call.namespace !== CODEX_APP_NAMESPACE || call.tool !== "automations_update") return null;
  const args = asRecord(call.arguments);
  if (!args) return null;
  const argsMode = normalizeAutomationUpdateMode(args.operation);
  const inputMode = normalizeAutomationUpdateInputMode(args.operation);
  if (!argsMode || !inputMode) return null;

  const result = call.success === true ? parseAutomationUpdateToolResult(call) : null;
  const displayMode = resolveAutomationUpdateDisplayMode(argsMode, result);
  const createInput =
    inputMode === "suggested_create" || inputMode === "create"
      ? buildAutomationUpdateCreateInput(args)
      : null;
  const updateInput =
    inputMode === "suggested_update" || inputMode === "update"
      ? buildAutomationUpdateUpdateInput(args)
      : null;
  const snapshot = result?.snapshot ?? null;
  const title =
    normalizeOptionalString(args.name) ??
    snapshot?.name ??
    normalizeOptionalString(args.id) ??
    intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.untitledAutomation",
      defaultMessage: "Untitled automation",
    });
  const schedule =
    formatAutomationTriggerSummary(
      parseAutomationTriggerInput(args.trigger) ?? snapshot?.trigger,
    ) ??
    intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.customSchedule",
      defaultMessage: "Custom schedule",
    });
  const statusLabel = resolveAutomationUpdateStatusLabel(
    {
      deleteStatus: result?.deleteStatus ?? null,
      mode: displayMode,
    },
    intl,
  );
  const automationId = result?.automationId ?? normalizeOptionalString(args.id) ?? null;
  const disabledReason = resolveAutomationUpdateDisabledReason(
    {
      mode: displayMode,
      createInput,
      updateInput,
    },
    intl,
  );

  return {
    automationId,
    canAccept:
      disabledReason === null &&
      (displayMode === "suggested-create" || displayMode === "suggested-update"),
    createInput,
    disabledReason,
    displayMode,
    openLabel: resolveAutomationUpdateOpenLabel(displayMode, intl),
    result,
    statusLabel,
    subtitle: displayMode === "delete" ? null : schedule,
    title,
    updateInput,
  };
}

export function parseCodexAppHandoffArguments(
  call: CodexDynamicToolCallView,
): { destinationHostId: string | null; threadId: string } | null {
  const args = asRecord(call.arguments);
  const threadId = getRequiredString(args ?? {}, "threadId");
  if (!threadId) return null;
  return {
    destinationHostId: getRequiredString(args ?? {}, "destinationHostId"),
    threadId,
  };
}

export function parseCodexAppHandoffResult(
  call: CodexDynamicToolCallView,
): CodexAppHandoffResult | null {
  const parsed = parseInputTextJson(call);
  if (!parsed) return null;
  const destinationHostDisplayName = getRequiredString(parsed, "destinationHostDisplayName");
  const operationId = getRequiredString(parsed, "operationId");
  const threadTitle = getRequiredString(parsed, "threadTitle");
  const status = parsed.status;
  if (!operationId || !threadTitle || !destinationHostDisplayName || !isKnownHandoffStatus(status))
    return null;
  return {
    destinationHostDisplayName,
    operationId,
    status,
    threadTitle,
  };
}

function isTerminalHandoffStatus(status: CodexAppHandoffStatus): boolean {
  return status === "success" || status === "warning" || status === "error";
}

export function resolveCodexAppHandoffRenderState(
  call: CodexDynamicToolCallView,
  operation: CodexAppHandoffOperation | null = null,
  intl: IntlShape = getIntl(),
): CodexAppHandoffRenderState {
  const result = call.completed && call.success === true ? parseCodexAppHandoffResult(call) : null;
  const completed = operation
    ? isTerminalHandoffStatus(operation.status)
    : result
      ? isTerminalHandoffStatus(result.status)
      : call.completed;
  const success = operation
    ? operation.status === "error"
      ? false
      : operation.status === "success" || operation.status === "warning"
    : call.success;
  const activityStatus = !completed ? "running" : success === false ? "failed" : "completed";
  const threadTitle = operation?.threadTitle ?? result?.threadTitle ?? null;
  const destination =
    operation?.destinationHostDisplayName ?? result?.destinationHostDisplayName ?? null;
  const target =
    threadTitle && destination
      ? intl.formatMessage(
          {
            id: "conversation.dynamicToolCallUtils.handoffDestination",
            defaultMessage: "{title} to {destination}",
          },
          { title: threadTitle, destination },
        )
      : intl.formatMessage({
          id: "conversation.dynamicToolCallUtils.chat",
          defaultMessage: "chat",
        });
  return {
    activityStatus,
    active: !completed,
    label: !completed
      ? intl.formatMessage(
          {
            id: "conversation.dynamicToolCallUtils.handingOff",
            defaultMessage: "Handing off {target}",
          },
          { target },
        )
      : success === false
        ? intl.formatMessage(
            {
              id: "conversation.dynamicToolCallUtils.handoffFailed",
              defaultMessage: "Failed to hand off {target}",
            },
            { target },
          )
        : intl.formatMessage(
            {
              id: "conversation.dynamicToolCallUtils.handedOff",
              defaultMessage: "Handed off {target}",
            },
            { target },
          ),
    result,
    operation,
  };
}

function resolveCodexAppHandoffLabel(
  call: CodexDynamicToolCallView,
  intl: IntlShape,
): string | null {
  if (!parseCodexAppHandoffArguments(call)) return null;
  return resolveCodexAppHandoffRenderState(call, null, intl).label;
}

function resolveCodexAppThreadLabelKey(
  call: CodexDynamicToolCallView,
): CodexAppThreadLabelKey | null {
  switch (call.tool) {
    case "fork_thread": {
      const args = asRecord(call.arguments);
      if (!args) return null;
      const isWorktree = asRecord(args?.environment)?.type === "worktree";
      if (isWorktree)
        return call.completed ? "threadsForkInWorktreeCompleted" : "threadsForkInWorktreeActive";
      return call.completed ? "threadsForkCompleted" : "threadsForkActive";
    }
    case "create_thread": {
      const args = asRecord(call.arguments);
      const target = asRecord(args?.target);
      if (!target || typeof target.type !== "string") return null;
      return isCodexAppCreateOrForkWorktree(call)
        ? call.completed
          ? "threadsCreateInWorktreeCompleted"
          : "threadsCreateInWorktreeActive"
        : call.completed
          ? "threadsCreateCompleted"
          : "threadsCreateActive";
    }
    case "list_threads":
      return call.completed ? "threadsListCompleted" : "threadsListActive";
    case "read_thread":
      return call.completed ? "threadsReadCompleted" : "threadsReadActive";
    case "send_message_to_thread":
      return call.completed ? "threadsSendMessageCompleted" : "threadsSendMessageActive";
    case "set_thread_pinned":
      return call.completed ? "threadsSetPinnedCompleted" : "threadsSetPinnedActive";
    case "set_thread_archived":
      return call.completed ? "threadsSetArchivedCompleted" : "threadsSetArchivedActive";
    case "set_thread_title":
      return call.completed ? "threadsSetTitleCompleted" : "threadsSetTitleActive";
    case "get_handoff_status":
      return getRequiredString(asRecord(call.arguments) ?? {}, "operationId")
        ? call.completed
          ? "threadsHandoffStatusCompleted"
          : "threadsHandoffStatusActive"
        : null;
    default:
      return null;
  }
}

function resolveCodexAppThreadToolLabel(
  call: CodexDynamicToolCallView,
  isLeadingSummaryPart = true,
  intl: IntlShape = getIntl(),
): string | null {
  if (call.tool === "handoff_thread") return resolveCodexAppHandoffLabel(call, intl);
  const key = resolveCodexAppThreadLabelKey(call);
  if (!key) return null;
  const followingKey = `${key}Following`;
  if (!isLeadingSummaryPart && followingKey in CODEX_APP_THREAD_LABELS) {
    return intl.formatMessage(CODEX_APP_THREAD_LABELS[followingKey as CodexAppThreadLabelKey]);
  }
  return intl.formatMessage(CODEX_APP_THREAD_LABELS[key]);
}

function resolveCodexAppThreadSummaryKey(call: CodexDynamicToolCallView): string | null {
  if (call.tool === "handoff_thread") {
    const args = parseCodexAppHandoffArguments(call);
    return args ? JSON.stringify([args.threadId, args.destinationHostId]) : null;
  }
  if (call.tool === "get_handoff_status") {
    return getRequiredString(asRecord(call.arguments) ?? {}, "operationId");
  }
  return resolveCodexAppThreadLabelKey(call);
}

function resolveAutomationUpdateLabel(
  call: CodexDynamicToolCallView,
  _isLeadingSummaryPart = true,
  intl: IntlShape = getIntl(),
): string | null {
  if (!call.completed)
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.automationsUpdateActive",
      defaultMessage: "Updating automation",
    });
  if (call.success === false)
    return intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.automationUpdateFailed",
      defaultMessage: "Failed to update automation",
    });
  const state = resolveAutomationUpdateRenderState(call, intl);
  if (!state) return null;
  return state.displayMode === "view"
    ? state.title
    : intl.formatMessage(
        {
          id: "conversation.dynamicToolCallUtils.automationWithTitle",
          defaultMessage: "{status}: {title}",
        },
        { status: state.statusLabel, title: state.title },
      );
}

function resolveAutomationUpdateSummaryKey(call: CodexDynamicToolCallView): string | null {
  const state = resolveAutomationUpdateRenderState(call);
  return state?.automationId ?? call.callId;
}

const DYNAMIC_TOOL_REGISTRY: DynamicToolRegistryEntry[] = [
  ...NODEX_TOOL_ACTIVITY_TOOLS.map((tool): DynamicToolRegistryEntry => ({
    namespace: "nodex_app",
    tool,
    rendererKind: "nodexApp",
    resolveLabel: (call) => resolveNodexToolActivity(call)?.label ?? null,
    getCompletedSummaryPartKey: (call) => call.callId,
  })),
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "automations_update",
    rendererKind: "automationUpdate",
    resolveLabel: resolveAutomationUpdateLabel,
    getCompletedSummaryPartKey: resolveAutomationUpdateSummaryKey,
  },
  {
    namespace: CHROME_EXTENSION_NAMESPACE,
    tool: "get_tab_context",
    rendererKind: "chromeTabContext",
    resolveLabel: resolveChromeTabContextLabel,
    getCompletedSummaryPartKey: (call) => {
      return parseChromeTabContextTabId(call) === null ? null : call.callId;
    },
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "fork_thread",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "create_thread",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "handoff_thread",
    rendererKind: "codexAppThread",
    standaloneInConversation: true,
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "get_handoff_status",
    rendererKind: "codexAppThread",
    summaryOnlyInConversationGroup: true,
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "list_threads",
    rendererKind: "codexAppThread",
    continuesLiveActivityBetweenCalls: true,
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "read_thread",
    rendererKind: "codexAppThread",
    continuesLiveActivityBetweenCalls: true,
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "send_message_to_thread",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "set_thread_pinned",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "set_thread_archived",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "set_thread_title",
    rendererKind: "codexAppThread",
    resolveLabel: resolveCodexAppThreadToolLabel,
    getCompletedSummaryPartKey: resolveCodexAppThreadSummaryKey,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "read_settings",
    rendererKind: "settings",
    resolveLabel: resolveSettingsToolLabel,
  },
  {
    namespace: CODEX_APP_NAMESPACE,
    tool: "write_settings",
    rendererKind: "settings",
    resolveLabel: resolveSettingsToolLabel,
  },
];

function indexDynamicToolRegistry(
  entries: readonly DynamicToolRegistryEntry[],
): ReadonlyMap<string | null, ReadonlyMap<string, DynamicToolRegistryEntry>> {
  const entriesByNamespace = new Map<string | null, Map<string, DynamicToolRegistryEntry>>();
  for (const entry of entries) {
    const namespaceEntries = entriesByNamespace.get(entry.namespace) ?? new Map();
    namespaceEntries.set(entry.tool, entry);
    entriesByNamespace.set(entry.namespace, namespaceEntries);
  }
  return entriesByNamespace;
}

const DYNAMIC_TOOL_REGISTRY_BY_NAMESPACE = indexDynamicToolRegistry(DYNAMIC_TOOL_REGISTRY);

export function parseChromeTabContextTabId(call: CodexDynamicToolCallView): number | null {
  const args = asRecord(call.arguments);
  const tabId = args?.tabId;
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

export function getDynamicToolRegistryEntry(
  call: CodexDynamicToolCallView | undefined,
): DynamicToolRegistryEntry | null {
  if (!call) return null;
  return DYNAMIC_TOOL_REGISTRY_BY_NAMESPACE.get(call.namespace)?.get(call.tool) ?? null;
}

export function continuesCodexAppLiveActivityBetweenCalls(
  call: CodexDynamicToolCallView | undefined,
): boolean {
  return getDynamicToolRegistryEntry(call)?.continuesLiveActivityBetweenCalls === true;
}

export function isDynamicToolStandaloneInConversation(
  call: CodexDynamicToolCallView | undefined,
): boolean {
  return getDynamicToolRegistryEntry(call)?.standaloneInConversation === true;
}

export function isDynamicToolSummaryOnlyInConversationGroup(
  call: CodexDynamicToolCallView | undefined,
): boolean {
  return getDynamicToolRegistryEntry(call)?.summaryOnlyInConversationGroup === true;
}

export function isCodexAppCreateOrForkWorktree(call: CodexDynamicToolCallView): boolean {
  const args = asRecord(call.arguments);
  if (!args) return false;
  if (call.tool === "fork_thread") {
    return asRecord(args.environment)?.type === "worktree";
  }
  if (call.tool === "create_thread") {
    const target = asRecord(args.target);
    return target?.type === "project" && asRecord(target.environment)?.type === "worktree";
  }
  return false;
}

export function resolveCodexAppMetaThreadToolLabel(call: CodexDynamicToolCallView): string | null {
  const entry = getDynamicToolRegistryEntry(call);
  return entry?.rendererKind === "codexAppThread" ? entry.resolveLabel(call) : null;
}

export function resolveDynamicToolRegistryLabel(
  call: CodexDynamicToolCallView,
  isLeadingSummaryPart = true,
  intl: IntlShape = getIntl(),
): string | null {
  return getDynamicToolRegistryEntry(call)?.resolveLabel(call, isLeadingSummaryPart, intl) ?? null;
}

export type CodexAppCreateThreadResult = CodexCreatedThreadResult;

export function parseCodexAppCreateThreadResult(
  call: CodexDynamicToolCallView,
): CodexAppCreateThreadResult | null {
  return readCreatedThreadActivityResult(call);
}

export function resolveDynamicToolLabelFromName(
  toolName: string,
  intl: IntlShape = getIntl(),
): string {
  const specialLabel = DYNAMIC_TOOL_COMPLETED_FALLBACK_LABELS[toolName];
  if (specialLabel) return intl.formatMessage(specialLabel);
  return (
    humanizeIdentifier(toolName) ||
    intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.dynamicToolCall",
      defaultMessage: "Dynamic tool call",
    })
  );
}

export function resolveDynamicToolFallbackLabel(
  call: CodexDynamicToolCallView,
  intl: IntlShape = getIntl(),
): string {
  const scriptTitle = resolveScriptToolTitle(call.tool, call.arguments);
  if (scriptTitle) return scriptTitle;
  if (call.displayTitle?.trim()) return call.displayTitle.trim();
  if (call.tool === "js")
    return call.completed
      ? intl.formatMessage({
          id: "conversation.dynamicToolCallUtils.ranJavaScript",
          defaultMessage: "Ran JavaScript",
        })
      : intl.formatMessage({
          id: "conversation.dynamicToolCallUtils.runningJavaScript",
          defaultMessage: "Running JavaScript",
        });
  const fallbackLabels = call.completed
    ? DYNAMIC_TOOL_COMPLETED_FALLBACK_LABELS
    : DYNAMIC_TOOL_ACTIVE_FALLBACK_LABELS;
  const specialLabel = fallbackLabels[call.tool];
  if (specialLabel) return intl.formatMessage(specialLabel);
  return (
    humanizeIdentifier(call.tool) ||
    intl.formatMessage({
      id: "conversation.dynamicToolCallUtils.dynamicToolCall",
      defaultMessage: "Dynamic tool call",
    })
  );
}

export function resolveDynamicToolLabel(
  entry: CodexConversationItem,
  intl: IntlShape = getIntl(),
): string {
  if (entry.dynamicToolCall) {
    const registryEntry = getDynamicToolRegistryEntry(entry.dynamicToolCall);
    const registryLabel = registryEntry?.resolveLabel(entry.dynamicToolCall, true, intl);
    if (registryLabel) return registryLabel;
    return resolveDynamicToolFallbackLabel(entry.dynamicToolCall, intl);
  }
  const toolName = entry.toolCall?.toolName ?? "dynamic_tool";
  return resolveDynamicToolLabelFromName(toolName, intl);
}

export function buildDynamicToolCallSummaryPartKey(
  call: CodexDynamicToolCallView | undefined,
): string {
  if (!call) return "";
  const summaryKey = getDynamicToolRegistryEntry(call)?.getCompletedSummaryPartKey?.(call) ?? "";
  return [call.namespace ?? "", call.tool, summaryKey].join(":");
}

export function extractDynamicToolTextContent(call: CodexDynamicToolCallView): string[] {
  const markdownFallback = formatDynamicToolCallMarkdownFallback(call);
  if (markdownFallback) return [markdownFallback];

  return (call.contentItems ?? []).flatMap((item) => {
    if (item.type !== "inputText") return [];
    const text = item.text.trim();
    return text ? [text] : [];
  });
}

export function isLikelyJsonText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
