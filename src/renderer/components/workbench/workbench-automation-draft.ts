import type {
  Automation,
  AutomationExecutionEnvironment,
  AutomationExecutionKind,
  AutomationMode,
  AgentModelOption,
  AutomationCreateInput,
  AutomationReasoningEffort,
  AutomationStatus,
  AutomationUpdateInput,
} from "@/lib/types";
import { getVisibleCodexModels, resolveCodexModelSelection } from "@/lib/codex-thread-settings";
import { hasAutomationRruleFrequency } from "@/lib/automation-rrule";
import type { AgentBackendBinding } from "../../../shared/agent-backend";

export const DEFAULT_WORKBENCH_AUTOMATION_RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
export const DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT = "medium";

function isAutomationReasoningEffort(value: string): value is AutomationReasoningEffort {
  return value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export interface WorkbenchAutomationDraft {
  id: string | null;
  backendBinding: AgentBackendBinding;
  kind: AutomationExecutionKind;
  status: AutomationStatus;
  projectId: string | null;
  targetSessionId: string;
  notificationPolicy?: AutomationCreateInput["notificationPolicy"];
  /** Whether a due run starts on its own or waits in the Inbox first. */
  mode: AutomationMode;
  ownerMemberId: string | null;
  scope?: Automation["scope"];
  conditionText: string;
  sourceCondition?: import("@/lib/types").AutomationSourceFilter | null;
  timezone: string;
  /** A Page every run follows as standing instructions. */
  runbookPageId: string | null;
  /** The runbook's title when it was chosen, for display only; never saved. */
  runbookTitle: string | null;
  expectedRevision?: number;
  name: string;
  prompt: string;
  rrule: string;
  model: string;
  reasoningEffort: AutomationReasoningEffort | "";
  serviceTier: string;
  cwds: string[];
  executionEnvironment: AutomationExecutionEnvironment;
  localEnvironmentConfigPath: string;
}

export interface WorkbenchAutomationDraftValidation {
  canSave: boolean;
  error: string | null;
  missingRequirements: WorkbenchAutomationDraftRequirement[];
}

export type WorkbenchAutomationDraftRequirement =
  | "name"
  | "prompt"
  | "cwd"
  | "thread"
  | "executionEnvironment"
  | "model"
  | "schedule"
  | "condition"
  | "events"
  | "workspace";

function normalizeOptionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeKind(kind: AutomationExecutionKind): AutomationExecutionKind {
  return kind === "cron" ? "cron" : "heartbeat";
}

function normalizeStatus(status: AutomationStatus): AutomationStatus {
  return status === "PAUSED" || status === "DELETED" ? status : "ACTIVE";
}

function normalizeExecutionEnvironment(
  executionEnvironment: AutomationExecutionEnvironment | null | undefined,
): AutomationExecutionEnvironment {
  return executionEnvironment === "local" ? "local" : "worktree";
}

/** Claude uses its own default; an ACP model sends only options it advertises. */
function defaultAutomationReasoningEffort(
  binding: AgentBackendBinding,
): AutomationReasoningEffort | "" {
  if (binding.kind === "claude") return "default";
  if (binding.kind === "acp") return "";
  return DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT;
}

export function createAutomationId(
  randomUUID: (() => string) | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
): string {
  const suffix = randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `automation-${suffix}`;
}

export function parseWorkbenchAutomationCwds(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function createWorkbenchAutomationDraft(
  input: {
    automation?: Automation | null;
    id?: string;
  } = {},
): WorkbenchAutomationDraft {
  const { automation } = input;
  const kind = normalizeKind(automation?.kind ?? "cron");
  const backendBinding = automation?.backendBinding ?? { kind: "codex" as const };
  return {
    id: automation?.id ?? input.id ?? createAutomationId(),
    expectedRevision: automation?.automationRevision,
    backendBinding,
    kind,
    status: normalizeStatus(automation?.status ?? "ACTIVE"),
    projectId: automation?.projectId ?? null,
    targetSessionId: automation?.targetSessionId ?? "",
    notificationPolicy: automation?.notificationPolicy,
    mode: automation?.mode ?? "run",
    ownerMemberId: automation?.ownerMemberId ?? null,
    scope: automation?.scope,
    conditionText: automation?.conditionText ?? "",
    sourceCondition: automation?.sourceCondition ?? null,
    timezone: automation?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    runbookPageId: automation?.runbookPageId ?? null,
    runbookTitle: automation?.runbookTitle ?? null,
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    rrule: automation?.rrule ?? DEFAULT_WORKBENCH_AUTOMATION_RRULE,
    model:
      kind === "cron"
        ? (automation?.model ?? (backendBinding.kind === "claude" ? "default" : ""))
        : "",
    reasoningEffort:
      kind === "cron"
        ? (automation?.reasoningEffort ?? defaultAutomationReasoningEffort(backendBinding))
        : "",
    serviceTier: kind === "cron" ? (automation?.serviceTier ?? "") : "",
    cwds: kind === "cron" ? [...(automation?.cwds ?? [])] : [],
    executionEnvironment: automation?.executionEnvironment ?? "local",
    localEnvironmentConfigPath:
      kind === "cron" ? (automation?.localEnvironmentConfigPath ?? "") : "",
  };
}

export function createWorkbenchAutomationDraftFromCreateInput(
  input: AutomationCreateInput,
): WorkbenchAutomationDraft {
  const kind = normalizeKind(input.kind);
  const backendBinding = input.backendBinding ?? { kind: "codex" as const };
  return {
    id: createAutomationId(),
    backendBinding,
    kind,
    status: "ACTIVE",
    projectId: kind === "cron" ? (input.projectId ?? null) : null,
    targetSessionId: kind === "heartbeat" ? (input.targetSessionId ?? "") : "",
    notificationPolicy: input.notificationPolicy,
    mode: input.mode ?? "run",
    ownerMemberId: input.ownerMemberId ?? null,
    scope: input.scope,
    conditionText: input.conditionText ?? "",
    sourceCondition: input.sourceCondition ?? null,
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    runbookPageId: input.runbookPageId ?? null,
    runbookTitle: null,
    name: input.name ?? "",
    prompt: input.prompt ?? "",
    rrule: input.rrule ?? DEFAULT_WORKBENCH_AUTOMATION_RRULE,
    model:
      kind === "cron" ? (input.model ?? (backendBinding.kind === "claude" ? "default" : "")) : "",
    reasoningEffort:
      kind === "cron"
        ? (input.reasoningEffort ?? defaultAutomationReasoningEffort(backendBinding))
        : "",
    serviceTier: kind === "cron" ? (input.serviceTier ?? "") : "",
    cwds: kind === "cron" ? [...(input.cwds ?? [])] : [],
    executionEnvironment: input.executionEnvironment ?? (input.projectId ? "worktree" : "local"),
    localEnvironmentConfigPath: kind === "cron" ? (input.localEnvironmentConfigPath ?? "") : "",
  };
}

export function createWorkbenchAutomationDraftFromUpdateInput(input: {
  update: AutomationUpdateInput;
  automation?: Automation | null;
}): WorkbenchAutomationDraft {
  const { update, automation } = input;
  const base =
    update.expectedRevision !== undefined
      ? createWorkbenchAutomationDraftFromCreateInput(update)
      : automation
        ? createWorkbenchAutomationDraft({ automation })
        : createWorkbenchAutomationDraft({ id: update.id });
  const kind = normalizeKind(update.kind ?? base.kind);
  return {
    ...base,
    id: update.id,
    backendBinding: update.backendBinding ?? base.backendBinding,
    expectedRevision: update.expectedRevision,
    notificationPolicy: update.notificationPolicy,
    mode: update.mode ?? automation?.mode ?? base.mode,
    ownerMemberId: update.ownerMemberId ?? automation?.ownerMemberId ?? base.ownerMemberId,
    scope: update.scope ?? automation?.scope ?? base.scope,
    conditionText: update.conditionText ?? automation?.conditionText ?? base.conditionText,
    sourceCondition: update.sourceCondition ?? automation?.sourceCondition ?? null,
    timezone: update.timezone ?? automation?.timezone ?? base.timezone,
    runbookPageId: update.runbookPageId === undefined ? base.runbookPageId : update.runbookPageId,
    runbookTitle:
      update.runbookPageId === undefined || update.runbookPageId === base.runbookPageId
        ? base.runbookTitle
        : null,
    kind,
    status: normalizeStatus(update.status ?? base.status),
    projectId:
      kind === "cron" ? (update.projectId === undefined ? base.projectId : update.projectId) : null,
    targetSessionId: kind === "heartbeat" ? (update.targetSessionId ?? base.targetSessionId) : "",
    name: update.name ?? base.name,
    prompt: update.prompt ?? base.prompt,
    rrule: update.rrule ?? base.rrule,
    model: kind === "cron" ? (update.model ?? base.model) : "",
    reasoningEffort:
      kind === "cron"
        ? (update.reasoningEffort ??
          base.reasoningEffort ??
          DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT)
        : "",
    serviceTier: kind === "cron" ? (update.serviceTier ?? base.serviceTier) : "",
    cwds: kind === "cron" ? [...(update.cwds ?? base.cwds)] : [],
    executionEnvironment:
      kind === "cron"
        ? normalizeExecutionEnvironment(update.executionEnvironment ?? base.executionEnvironment)
        : "worktree",
    localEnvironmentConfigPath:
      kind === "cron" ? (update.localEnvironmentConfigPath ?? base.localEnvironmentConfigPath) : "",
  };
}

export function resolveWorkbenchAutomationDraftModelSettings(input: {
  draft: WorkbenchAutomationDraft;
  models: readonly AgentModelOption[];
}): WorkbenchAutomationDraft {
  if (input.draft.backendBinding.kind !== "codex") return input.draft;
  if (input.draft.kind !== "cron") {
    if (
      input.draft.model === "" &&
      input.draft.reasoningEffort === "" &&
      input.draft.serviceTier === ""
    ) {
      return input.draft;
    }
    return {
      ...input.draft,
      model: "",
      reasoningEffort: "",
      serviceTier: "",
    };
  }

  if (getVisibleCodexModels(input.models).length === 0) {
    return input.draft;
  }

  const selection = resolveCodexModelSelection({
    model: input.draft.model,
    reasoningEffort: input.draft.reasoningEffort,
    models: input.models,
    fallbackReasoningEffort: DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  });
  const reasoningEffort = isAutomationReasoningEffort(selection.reasoningEffort)
    ? selection.reasoningEffort
    : DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT;

  if (input.draft.model === selection.model && input.draft.reasoningEffort === reasoningEffort) {
    return input.draft;
  }

  return {
    ...input.draft,
    model: selection.model,
    reasoningEffort,
  };
}

export function validateWorkbenchAutomationDraft(
  draft: WorkbenchAutomationDraft,
): WorkbenchAutomationDraftValidation {
  if (!normalizeOptionalText(draft.id ?? "")) {
    return {
      canSave: false,
      error: "Automation id is missing.",
      missingRequirements: [],
    };
  }

  const missingRequirements = resolveWorkbenchAutomationDraftMissingRequirements(draft);
  if (missingRequirements.length > 0) {
    return {
      canSave: false,
      error: formatWorkbenchAutomationDraftRequirementError(missingRequirements[0] ?? "name"),
      missingRequirements,
    };
  }

  return {
    canSave: true,
    error: null,
    missingRequirements,
  };
}

export function resolveWorkbenchAutomationDraftMissingRequirements(
  draft: WorkbenchAutomationDraft,
): WorkbenchAutomationDraftRequirement[] {
  const missingRequirements: WorkbenchAutomationDraftRequirement[] = [];

  if (!normalizeOptionalText(draft.name)) {
    missingRequirements.push("name");
  }

  if (!normalizeOptionalText(draft.prompt)) {
    missingRequirements.push("prompt");
  }

  if (draft.kind === "heartbeat" && !normalizeOptionalText(draft.targetSessionId)) {
    missingRequirements.push("thread");
  }

  if (
    draft.kind === "cron" &&
    ((draft.projectId !== null && draft.cwds.length === 0) ||
      (draft.projectId === null &&
        (draft.cwds.length > 0 || draft.executionEnvironment === "worktree")))
  ) {
    missingRequirements.push("cwd");
  }

  if (
    draft.kind === "cron" &&
    draft.executionEnvironment !== "local" &&
    draft.executionEnvironment !== "worktree"
  ) {
    missingRequirements.push("executionEnvironment");
  }

  if (draft.kind === "cron" && !normalizeOptionalText(draft.model)) {
    missingRequirements.push("model");
  }

  if (draft.sourceCondition) {
    if (draft.cwds.length > 1) missingRequirements.push("workspace");
    if (!draft.projectId && !missingRequirements.includes("cwd")) missingRequirements.push("cwd");
    if (!draft.conditionText.trim()) missingRequirements.push("condition");
    if (!draft.sourceCondition.kinds.length) missingRequirements.push("events");
  }
  const rrule = normalizeOptionalText(draft.rrule);
  if (!draft.sourceCondition && rrule && !hasAutomationRruleFrequency(rrule)) {
    missingRequirements.push("schedule");
  }

  return missingRequirements;
}

function formatWorkbenchAutomationDraftRequirementError(
  requirement: WorkbenchAutomationDraftRequirement,
): string {
  if (requirement === "name") return "Automation name is required.";
  if (requirement === "prompt") return "Automation prompt is required.";
  if (requirement === "condition") return "Condition is required.";
  if (requirement === "events") return "Choose an event kind.";
  if (requirement === "workspace") return "Choose one workspace for an event Automation.";
  if (requirement === "schedule") return "Schedule RRULE must include FREQ.";
  if (requirement === "thread") return "Chat is required for automation chats.";
  if (requirement === "cwd") return "Project is required.";
  if (requirement === "model") return "Model is required.";
  return "Execution environment is required.";
}

function formatWorkbenchAutomationDraftRequirementLabel(
  requirement: WorkbenchAutomationDraftRequirement,
  position: "initial" | "continuation",
): string {
  if (requirement === "condition") return "Add condition";
  if (requirement === "events") return "Choose events";
  if (requirement === "workspace") return "Choose one workspace";
  if (requirement === "name") return position === "initial" ? "Create title" : "create title";
  if (requirement === "prompt") return position === "initial" ? "Add prompt" : "add prompt";
  if (requirement === "cwd") return position === "initial" ? "Select project" : "select project";
  if (requirement === "thread") return position === "initial" ? "Select chat" : "select chat";
  if (requirement === "executionEnvironment") {
    return position === "initial" ? "Choose where to run it" : "choose where to run it";
  }
  if (requirement === "model") return position === "initial" ? "Choose a model" : "choose a model";
  return position === "initial" ? "Fix the schedule" : "fix the schedule";
}

function formatRequirementList(requirements: WorkbenchAutomationDraftRequirement[]): string {
  const labels = requirements.map((requirement, index) =>
    formatWorkbenchAutomationDraftRequirementLabel(
      requirement,
      index === 0 ? "initial" : "continuation",
    ),
  );
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0] ?? "";
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(labels);
}

export function formatWorkbenchAutomationDraftSaveTooltip(input: {
  draft: WorkbenchAutomationDraft;
  action: "create" | "save";
}): string | null {
  const requirements = resolveWorkbenchAutomationDraftMissingRequirements(input.draft);
  if (requirements.length === 0) return null;
  const requirementList = formatRequirementList(requirements);
  if (!requirementList) return null;
  return `${requirementList} to ${input.action}`;
}

type DraftAutomationPayload = AutomationCreateInput & {
  status: AutomationStatus;
};

function buildAutomationDraftPayload(
  draft: WorkbenchAutomationDraft,
): DraftAutomationPayload | null {
  const validation = validateWorkbenchAutomationDraft(draft);
  if (!validation.canSave) return null;

  const name = normalizeOptionalText(draft.name);
  const prompt = normalizeOptionalText(draft.prompt);
  if (!name || !prompt) return null;

  const kind = normalizeKind(draft.kind);
  const isHeartbeat = kind === "heartbeat";
  const rrule = normalizeOptionalText(draft.rrule);

  return {
    kind,
    backendBinding: draft.backendBinding,
    status: normalizeStatus(draft.status),
    projectId: isHeartbeat ? null : draft.projectId,
    targetSessionId: isHeartbeat ? normalizeOptionalText(draft.targetSessionId) : null,
    ...(draft.notificationPolicy !== undefined
      ? { notificationPolicy: draft.notificationPolicy }
      : {}),
    mode: draft.mode,
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(draft.ownerMemberId ? { ownerMemberId: draft.ownerMemberId } : {}),
    ...(draft.conditionText.trim() ? { conditionText: draft.conditionText.trim() } : {}),
    timezone: draft.timezone,
    sourceCondition: draft.sourceCondition ?? null,
    runbookPageId: draft.runbookPageId,
    name,
    prompt,
    rrule,
    model: isHeartbeat ? null : normalizeOptionalText(draft.model),
    reasoningEffort: isHeartbeat ? null : draft.reasoningEffort || null,
    serviceTier: isHeartbeat ? null : normalizeOptionalText(draft.serviceTier),
    cwds: isHeartbeat ? [] : [...draft.cwds],
    executionEnvironment: isHeartbeat
      ? null
      : normalizeExecutionEnvironment(draft.executionEnvironment),
    localEnvironmentConfigPath: isHeartbeat
      ? null
      : normalizeOptionalText(draft.localEnvironmentConfigPath),
  };
}

export function buildAutomationCreateInput(input: {
  draft: WorkbenchAutomationDraft;
}): AutomationCreateInput | null {
  const payload = buildAutomationDraftPayload(input.draft);
  if (!payload) return null;
  return {
    kind: payload.kind,
    backendBinding: payload.backendBinding,
    projectId: payload.projectId,
    targetSessionId: payload.targetSessionId,
    ...(payload.notificationPolicy !== undefined
      ? { notificationPolicy: payload.notificationPolicy }
      : {}),
    mode: payload.mode,
    ...(payload.scope ? { scope: payload.scope } : {}),
    ...(payload.ownerMemberId ? { ownerMemberId: payload.ownerMemberId } : {}),
    ...(payload.conditionText ? { conditionText: payload.conditionText } : {}),
    timezone: payload.timezone,
    sourceCondition: payload.sourceCondition ?? null,
    runbookPageId: payload.runbookPageId,
    name: payload.name,
    prompt: payload.prompt,
    rrule: payload.rrule,
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    serviceTier: payload.serviceTier,
    cwds: payload.cwds,
    executionEnvironment: payload.executionEnvironment,
    localEnvironmentConfigPath: payload.localEnvironmentConfigPath,
  };
}

export function buildAutomationUpdateInput(input: {
  draft: WorkbenchAutomationDraft;
  id?: string | null;
}): AutomationUpdateInput | null {
  const payload = buildAutomationDraftPayload(input.draft);
  if (!payload) return null;
  const id = normalizeOptionalText(input.id ?? input.draft.id ?? "");
  if (!id) return null;
  return {
    id,
    ...payload,
    ...(input.draft.expectedRevision !== undefined
      ? { expectedRevision: input.draft.expectedRevision }
      : {}),
  };
}

export function isWorkbenchAutomationDraftDirty(input: {
  draft: WorkbenchAutomationDraft;
  existing: Automation | null;
}): boolean {
  const { draft, existing } = input;
  if (!existing) return true;
  const nativeCron = draft.kind === "cron" && draft.backendBinding.kind === "claude";

  return (
    JSON.stringify(draft.backendBinding) !== JSON.stringify(existing.backendBinding) ||
    normalizeKind(draft.kind) !== existing.kind ||
    draft.projectId !== existing.projectId ||
    normalizeStatus(draft.status) !== existing.status ||
    (draft.kind === "heartbeat" ? normalizeOptionalText(draft.targetSessionId) : null) !==
      existing.targetSessionId ||
    (draft.notificationPolicy !== undefined &&
      draft.notificationPolicy !== existing.notificationPolicy) ||
    draft.mode !== existing.mode ||
    JSON.stringify(draft.scope) !== JSON.stringify(existing.scope) ||
    draft.ownerMemberId !== existing.ownerMemberId ||
    JSON.stringify(draft.sourceCondition ?? null) !==
      JSON.stringify(existing.sourceCondition ?? null) ||
    draft.conditionText.trim() !== existing.conditionText ||
    draft.timezone !== existing.timezone ||
    draft.runbookPageId !== existing.runbookPageId ||
    normalizeOptionalText(draft.name) !== existing.name ||
    normalizeOptionalText(draft.prompt) !== existing.prompt ||
    normalizeOptionalText(draft.rrule) !== existing.rrule ||
    (draft.kind === "cron" ? normalizeOptionalText(draft.model) : null) !==
      (nativeCron ? (existing.model ?? "default") : existing.model) ||
    (draft.kind === "cron" ? draft.reasoningEffort || null : null) !==
      (nativeCron ? (existing.reasoningEffort ?? "default") : existing.reasoningEffort) ||
    (draft.kind === "cron" ? normalizeOptionalText(draft.serviceTier) : null) !==
      existing.serviceTier ||
    (draft.kind === "cron"
      ? normalizeExecutionEnvironment(draft.executionEnvironment)
      : existing.executionEnvironment) !== existing.executionEnvironment ||
    (draft.kind === "cron" ? normalizeOptionalText(draft.localEnvironmentConfigPath) : null) !==
      existing.localEnvironmentConfigPath ||
    draft.cwds.length !== existing.cwds.length ||
    draft.cwds.some((cwd, index) => cwd !== existing.cwds[index])
  );
}

export function hasWorkbenchAutomationCreateDraftChanges(
  draft: WorkbenchAutomationDraft,
  initialDraft?: WorkbenchAutomationDraft | null,
): boolean {
  if (initialDraft) {
    return (
      JSON.stringify(draft.backendBinding) !== JSON.stringify(initialDraft.backendBinding) ||
      normalizeKind(draft.kind) !== normalizeKind(initialDraft.kind) ||
      draft.projectId !== initialDraft.projectId ||
      normalizeStatus(draft.status) !== normalizeStatus(initialDraft.status) ||
      normalizeOptionalText(draft.targetSessionId) !==
        normalizeOptionalText(initialDraft.targetSessionId) ||
      draft.mode !== initialDraft.mode ||
      JSON.stringify(draft.scope) !== JSON.stringify(initialDraft.scope) ||
      draft.ownerMemberId !== initialDraft.ownerMemberId ||
      JSON.stringify(draft.sourceCondition ?? null) !==
        JSON.stringify(initialDraft.sourceCondition ?? null) ||
      draft.conditionText.trim() !== initialDraft.conditionText.trim() ||
      draft.timezone !== initialDraft.timezone ||
      draft.runbookPageId !== initialDraft.runbookPageId ||
      normalizeOptionalText(draft.name) !== normalizeOptionalText(initialDraft.name) ||
      normalizeOptionalText(draft.prompt) !== normalizeOptionalText(initialDraft.prompt) ||
      normalizeOptionalText(draft.rrule) !== normalizeOptionalText(initialDraft.rrule) ||
      normalizeOptionalText(draft.model) !== normalizeOptionalText(initialDraft.model) ||
      (draft.reasoningEffort || "") !== (initialDraft.reasoningEffort || "") ||
      normalizeOptionalText(draft.serviceTier) !==
        normalizeOptionalText(initialDraft.serviceTier) ||
      draft.cwds.length !== initialDraft.cwds.length ||
      draft.cwds.some((cwd, index) => cwd !== initialDraft.cwds[index]) ||
      normalizeExecutionEnvironment(draft.executionEnvironment) !==
        normalizeExecutionEnvironment(initialDraft.executionEnvironment) ||
      normalizeOptionalText(draft.localEnvironmentConfigPath) !==
        normalizeOptionalText(initialDraft.localEnvironmentConfigPath)
    );
  }

  return (
    draft.backendBinding.kind !== "codex" ||
    normalizeKind(draft.kind) !== "cron" ||
    draft.projectId !== null ||
    normalizeStatus(draft.status) !== "ACTIVE" ||
    normalizeOptionalText(draft.targetSessionId) !== null ||
    draft.mode !== "run" ||
    draft.ownerMemberId !== null ||
    draft.sourceCondition != null ||
    draft.conditionText.trim() !== "" ||
    draft.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ||
    draft.runbookPageId !== null ||
    normalizeOptionalText(draft.name) !== null ||
    normalizeOptionalText(draft.prompt) !== null ||
    normalizeOptionalText(draft.rrule) !== DEFAULT_WORKBENCH_AUTOMATION_RRULE ||
    normalizeOptionalText(draft.model) !== null ||
    (draft.reasoningEffort !== "" &&
      draft.reasoningEffort !== DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT) ||
    normalizeOptionalText(draft.serviceTier) !== null ||
    draft.cwds.length > 0 ||
    normalizeExecutionEnvironment(draft.executionEnvironment) !== "local" ||
    normalizeOptionalText(draft.localEnvironmentConfigPath) !== null
  );
}
