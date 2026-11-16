import { getIntl } from "@/lib/i18n";
import type {
  WorktreeEnvironmentActionIcon,
  WorktreeEnvironmentDefinition,
  WorktreeEnvironmentPlatform,
  WorktreeEnvironmentScriptDefinition,
} from "./types";

export interface LocalEnvironmentDraftAction {
  id: string;
  name: string;
  icon: WorktreeEnvironmentActionIcon | null;
  command: string;
  platform: WorktreeEnvironmentPlatform | null;
}

export interface LocalEnvironmentDraftScriptDefinition {
  script: string;
  platformScripts: Partial<Record<WorktreeEnvironmentPlatform, string>>;
}

export interface LocalEnvironmentDraft {
  version: number;
  name: string;
  setup: LocalEnvironmentDraftScriptDefinition;
  cleanup: LocalEnvironmentDraftScriptDefinition;
  actions: LocalEnvironmentDraftAction[];
}

export interface LocalEnvironmentDraftValidation {
  missingName: boolean;
  incompleteActionIds: string[];
  actionErrors: Record<string, { name?: string; command?: string }>;
}

export type LocalEnvironmentSaveDisabledReason =
  | "saving"
  | "read-error"
  | "missing-name"
  | "incomplete-action"
  | "no-changes"
  | "project-error"
  | "loading-project";

export const LOCAL_ENVIRONMENT_SAVE_DISABLED_COPY: Record<
  LocalEnvironmentSaveDisabledReason,
  string
> = {
  saving: "Saving…",
  get "read-error"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.retryEnvironment",
      defaultMessage: "Retry loading the environment before saving",
    });
  },
  get "missing-name"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.environmentNameRequired",
      defaultMessage: "Add an environment name to save",
    });
  },
  get "incomplete-action"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.actionFieldsRequired",
      defaultMessage: "Add both a name and command for each action",
    });
  },
  get "no-changes"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.noChanges",
      defaultMessage: "No changes to save",
    });
  },
  get "project-error"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.retryProject",
      defaultMessage: "Retry loading project information to save",
    });
  },
  get "loading-project"() {
    return getIntl().formatMessage({
      id: "lib.localEnvironmentForm.loadingProject",
      defaultMessage: "Loading project information",
    });
  },
};

function randomDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random()}`;
}

function toDraftScript(definition: WorktreeEnvironmentScriptDefinition) {
  return {
    script: definition.script ?? "",
    platformScripts: { ...definition.platformScripts },
  };
}

export function createLocalEnvironmentDraftAction(): LocalEnvironmentDraftAction {
  return {
    id: randomDraftId(),
    name: "",
    icon: "tool",
    command: "",
    platform: null,
  };
}

export function createLocalEnvironmentDraft(
  environment: WorktreeEnvironmentDefinition,
): LocalEnvironmentDraft {
  return {
    version: environment.version,
    name: environment.name,
    setup: toDraftScript(environment.setup),
    cleanup: toDraftScript(environment.cleanup),
    actions: environment.actions.map((action) => ({
      ...action,
      id: randomDraftId(),
    })),
  };
}

function toPersistedScript(
  definition: LocalEnvironmentDraftScriptDefinition,
): WorktreeEnvironmentScriptDefinition {
  return {
    script: definition.script.length > 0 ? definition.script : null,
    platformScripts: Object.fromEntries(
      Object.entries(definition.platformScripts).filter(
        (entry): entry is [WorktreeEnvironmentPlatform, string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
      ),
    ),
  };
}

export function toPersistedLocalEnvironmentDefinition(
  draft: LocalEnvironmentDraft,
): WorktreeEnvironmentDefinition {
  return {
    version: draft.version,
    name: draft.name.trim(),
    setup: toPersistedScript(draft.setup),
    cleanup: toPersistedScript(draft.cleanup),
    actions: draft.actions.flatMap((action) => {
      const name = action.name.trim();
      const command = action.command.trim();
      if (!name || !command) return [];
      return [
        {
          name,
          icon: action.icon,
          command,
          platform: action.platform,
        },
      ];
    }),
  };
}

export function validateLocalEnvironmentDraft(
  draft: LocalEnvironmentDraft,
): LocalEnvironmentDraftValidation {
  const actionErrors: LocalEnvironmentDraftValidation["actionErrors"] = {};
  const incompleteActionIds = draft.actions.flatMap((action) => {
    const hasName = action.name.trim().length > 0;
    const hasCommand = action.command.trim().length > 0;
    if (hasName === hasCommand) return [];

    actionErrors[action.id] = hasName
      ? {
          command: getIntl().formatMessage({
            id: "lib.localEnvironmentForm.actionCommand",
            defaultMessage: "Enter an action command",
          }),
        }
      : {
          name: getIntl().formatMessage({
            id: "lib.localEnvironmentForm.actionName",
            defaultMessage: "Enter an action name",
          }),
        };
    return [action.id];
  });

  return {
    missingName: draft.name.trim().length === 0,
    incompleteActionIds,
    actionErrors,
  };
}

export function resolveLocalEnvironmentSaveDisabledReason(input: {
  dirty: boolean;
  isSaving: boolean;
  ready: boolean;
  projectError?: boolean;
  readError?: boolean;
  validation: LocalEnvironmentDraftValidation;
}): LocalEnvironmentSaveDisabledReason | null {
  if (input.isSaving) return "saving";
  if (!input.ready) return input.projectError ? "project-error" : "loading-project";
  if (input.readError) return "read-error";
  if (input.validation.missingName) return "missing-name";
  if (input.validation.incompleteActionIds.length > 0) return "incomplete-action";
  if (!input.dirty) return "no-changes";
  return null;
}

export function readLocalEnvironmentPlatformSlot(
  definition: LocalEnvironmentDraftScriptDefinition,
  platform: "default" | WorktreeEnvironmentPlatform,
): string {
  return platform === "default" ? definition.script : (definition.platformScripts[platform] ?? "");
}

export function writeLocalEnvironmentPlatformSlot(
  definition: LocalEnvironmentDraftScriptDefinition,
  platform: "default" | WorktreeEnvironmentPlatform,
  script: string,
): LocalEnvironmentDraftScriptDefinition {
  if (platform === "default") return { ...definition, script };
  return {
    ...definition,
    platformScripts: { ...definition.platformScripts, [platform]: script },
  };
}
