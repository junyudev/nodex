import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationExecutionEnvironment,
  CodexScheduledAutomationKind,
  CodexModelOption,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationReasoningEffort,
  CodexScheduledAutomationStatus,
  CodexScheduledAutomationUpdateInput,
} from "@/lib/types";
import { getVisibleCodexModels, resolveCodexModelSelection } from "@/lib/codex-thread-settings";
import { hasCodexScheduledAutomationRruleFrequency } from "@/lib/codex-scheduled-automation-rrule";

export const DEFAULT_WORKBENCH_AUTOMATION_RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
export const DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT = "medium";

function isScheduledAutomationReasoningEffort(
  value: string,
): value is CodexScheduledAutomationReasoningEffort {
  return value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export interface WorkbenchAutomationDraft {
  id: string | null;
  kind: CodexScheduledAutomationKind;
  status: CodexScheduledAutomationStatus;
  targetThreadId: string;
  name: string;
  prompt: string;
  rrule: string;
  model: string;
  reasoningEffort: CodexScheduledAutomationReasoningEffort | "";
  serviceTier: string;
  cwds: string[];
  executionEnvironment: CodexScheduledAutomationExecutionEnvironment;
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
  | "schedule";

function normalizeOptionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeKind(kind: CodexScheduledAutomationKind): CodexScheduledAutomationKind {
  return kind === "cron" ? "cron" : "heartbeat";
}

function normalizeStatus(status: CodexScheduledAutomationStatus): CodexScheduledAutomationStatus {
  return status === "PAUSED" || status === "DELETED" ? status : "ACTIVE";
}

function normalizeExecutionEnvironment(
  executionEnvironment: CodexScheduledAutomationExecutionEnvironment | null | undefined,
): CodexScheduledAutomationExecutionEnvironment {
  return executionEnvironment === "local" ? "local" : "worktree";
}

export function createCodexScheduledAutomationId(
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

export function cloneWorkbenchAutomationDraft(
  draft: WorkbenchAutomationDraft,
): WorkbenchAutomationDraft {
  return {
    ...draft,
    cwds: [...draft.cwds],
  };
}

export function createWorkbenchAutomationDraft(
  input: {
    automation?: CodexScheduledAutomation | null;
    id?: string;
  } = {},
): WorkbenchAutomationDraft {
  const { automation } = input;
  const kind = normalizeKind(automation?.kind ?? "cron");
  return {
    id: automation?.id ?? input.id ?? createCodexScheduledAutomationId(),
    kind,
    status: normalizeStatus(automation?.status ?? "ACTIVE"),
    targetThreadId: automation?.targetThreadId ?? "",
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    rrule: automation?.rrule ?? DEFAULT_WORKBENCH_AUTOMATION_RRULE,
    model: kind === "cron" ? (automation?.model ?? "") : "",
    reasoningEffort:
      kind === "cron"
        ? (automation?.reasoningEffort ?? DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT)
        : "",
    serviceTier: kind === "cron" ? (automation?.serviceTier ?? "") : "",
    cwds: kind === "cron" ? [...(automation?.cwds ?? [])] : [],
    executionEnvironment: normalizeExecutionEnvironment(automation?.executionEnvironment),
    localEnvironmentConfigPath:
      kind === "cron" ? (automation?.localEnvironmentConfigPath ?? "") : "",
  };
}

export function createWorkbenchAutomationDraftFromCreateInput(
  input: CodexScheduledAutomationCreateInput,
): WorkbenchAutomationDraft {
  const kind = normalizeKind(input.kind);
  return {
    id: createCodexScheduledAutomationId(),
    kind,
    status: "ACTIVE",
    targetThreadId: kind === "heartbeat" ? (input.targetThreadId ?? "") : "",
    name: input.name ?? "",
    prompt: input.prompt ?? "",
    rrule: input.rrule ?? DEFAULT_WORKBENCH_AUTOMATION_RRULE,
    model: kind === "cron" ? (input.model ?? "") : "",
    reasoningEffort:
      kind === "cron"
        ? (input.reasoningEffort ?? DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT)
        : "",
    serviceTier: kind === "cron" ? (input.serviceTier ?? "") : "",
    cwds: kind === "cron" ? [...(input.cwds ?? [])] : [],
    executionEnvironment: normalizeExecutionEnvironment(input.executionEnvironment),
    localEnvironmentConfigPath: kind === "cron" ? (input.localEnvironmentConfigPath ?? "") : "",
  };
}

export function createWorkbenchAutomationDraftFromUpdateInput(input: {
  update: CodexScheduledAutomationUpdateInput;
  automation?: CodexScheduledAutomation | null;
}): WorkbenchAutomationDraft {
  const { update, automation } = input;
  const base = automation
    ? createWorkbenchAutomationDraft({ automation })
    : createWorkbenchAutomationDraft({ id: update.id });
  const kind = normalizeKind(update.kind ?? base.kind);
  return {
    ...base,
    id: update.id,
    kind,
    status: normalizeStatus(update.status ?? base.status),
    targetThreadId: kind === "heartbeat" ? (update.targetThreadId ?? base.targetThreadId) : "",
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
  models: readonly CodexModelOption[];
}): WorkbenchAutomationDraft {
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
  const reasoningEffort = isScheduledAutomationReasoningEffort(selection.reasoningEffort)
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
      error: "Scheduled task id is missing.",
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

  if (draft.kind === "heartbeat" && !normalizeOptionalText(draft.targetThreadId)) {
    missingRequirements.push("thread");
  }

  if (draft.kind === "cron" && draft.cwds.length === 0) {
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

  const rrule = normalizeOptionalText(draft.rrule);
  if (rrule && !hasCodexScheduledAutomationRruleFrequency(rrule)) {
    missingRequirements.push("schedule");
  }

  return missingRequirements;
}

function formatWorkbenchAutomationDraftRequirementError(
  requirement: WorkbenchAutomationDraftRequirement,
): string {
  if (requirement === "name") return "Scheduled task name is required.";
  if (requirement === "prompt") return "Scheduled task prompt is required.";
  if (requirement === "schedule") return "Schedule RRULE must include FREQ.";
  if (requirement === "thread") return "Chat is required for scheduled task chats.";
  if (requirement === "cwd") return "Project is required.";
  if (requirement === "model") return "Model is required.";
  return "Execution environment is required.";
}

function formatWorkbenchAutomationDraftRequirementLabel(
  requirement: WorkbenchAutomationDraftRequirement,
  position: "initial" | "continuation",
): string {
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

type DraftAutomationPayload = CodexScheduledAutomationCreateInput & {
  status: CodexScheduledAutomationStatus;
};

function buildCodexScheduledAutomationDraftPayload(
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
    status: normalizeStatus(draft.status),
    targetThreadId: isHeartbeat ? normalizeOptionalText(draft.targetThreadId) : null,
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

export function buildCodexScheduledAutomationCreateInput(input: {
  draft: WorkbenchAutomationDraft;
}): CodexScheduledAutomationCreateInput | null {
  const payload = buildCodexScheduledAutomationDraftPayload(input.draft);
  if (!payload) return null;
  return {
    kind: payload.kind,
    targetThreadId: payload.targetThreadId,
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

export function buildCodexScheduledAutomationUpdateInput(input: {
  draft: WorkbenchAutomationDraft;
  id?: string | null;
}): CodexScheduledAutomationUpdateInput | null {
  const payload = buildCodexScheduledAutomationDraftPayload(input.draft);
  if (!payload) return null;
  const id = normalizeOptionalText(input.id ?? input.draft.id ?? "");
  if (!id) return null;
  return {
    id,
    ...payload,
  };
}

export function isWorkbenchAutomationDraftDirty(input: {
  draft: WorkbenchAutomationDraft;
  existing: CodexScheduledAutomation | null;
}): boolean {
  const { draft, existing } = input;
  if (!existing) return true;

  return (
    normalizeKind(draft.kind) !== existing.kind ||
    normalizeStatus(draft.status) !== existing.status ||
    (draft.kind === "heartbeat" ? normalizeOptionalText(draft.targetThreadId) : null) !==
      existing.targetThreadId ||
    normalizeOptionalText(draft.name) !== existing.name ||
    normalizeOptionalText(draft.prompt) !== existing.prompt ||
    normalizeOptionalText(draft.rrule) !== existing.rrule ||
    (draft.kind === "cron" ? normalizeOptionalText(draft.model) : null) !== existing.model ||
    (draft.kind === "cron" ? draft.reasoningEffort || null : null) !== existing.reasoningEffort ||
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
      normalizeKind(draft.kind) !== normalizeKind(initialDraft.kind) ||
      normalizeStatus(draft.status) !== normalizeStatus(initialDraft.status) ||
      normalizeOptionalText(draft.targetThreadId) !==
        normalizeOptionalText(initialDraft.targetThreadId) ||
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
    normalizeKind(draft.kind) !== "cron" ||
    normalizeStatus(draft.status) !== "ACTIVE" ||
    normalizeOptionalText(draft.targetThreadId) !== null ||
    normalizeOptionalText(draft.name) !== null ||
    normalizeOptionalText(draft.prompt) !== null ||
    normalizeOptionalText(draft.rrule) !== DEFAULT_WORKBENCH_AUTOMATION_RRULE ||
    normalizeOptionalText(draft.model) !== null ||
    (draft.reasoningEffort !== "" &&
      draft.reasoningEffort !== DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT) ||
    normalizeOptionalText(draft.serviceTier) !== null ||
    draft.cwds.length > 0 ||
    normalizeExecutionEnvironment(draft.executionEnvironment) !== "worktree" ||
    normalizeOptionalText(draft.localEnvironmentConfigPath) !== null
  );
}
