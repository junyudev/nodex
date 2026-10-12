import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import {
  ActivitySpinnerIcon,
  DeleteIcon,
  getLocalEnvironmentActionIconOption,
  LOCAL_ENVIRONMENT_ACTION_ICON_OPTIONS,
  LocalEnvironmentActionIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { handleFormSubmit } from "@/lib/forms";
import {
  createLocalEnvironmentDraft,
  createLocalEnvironmentDraftAction,
  LOCAL_ENVIRONMENT_SAVE_DISABLED_COPY,
  readLocalEnvironmentPlatformSlot,
  resolveLocalEnvironmentSaveDisabledReason,
  toPersistedLocalEnvironmentDefinition,
  validateLocalEnvironmentDraft,
  writeLocalEnvironmentPlatformSlot,
  type LocalEnvironmentDraft,
  type LocalEnvironmentDraftAction,
  type LocalEnvironmentDraftScriptDefinition,
} from "@/lib/local-environment-form";
import type {
  WorktreeEnvironmentDefinition,
  WorktreeEnvironmentPlatform,
  WorktreeEnvironmentSaveResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { LocalEnvironmentVariablesPopover } from "./local-environment-variables-popover";

type LifecyclePlatform = "default" | WorktreeEnvironmentPlatform;
type ActionPlatform = "all" | WorktreeEnvironmentPlatform;

const LIFECYCLE_PLATFORM_OPTIONS: ReadonlyArray<{
  value: LifecyclePlatform;
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

const ACTION_PLATFORM_OPTIONS: ReadonlyArray<{
  value: ActionPlatform;
  label: string;
}> = [
  { value: "all", label: "All platforms" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

const SETUP_PLACEHOLDER =
  'cd "$CODEX_WORKTREE_PATH"\npip install -r requirements.txt\nnpm install\n./run/setup.sh';
const WINDOWS_SETUP_PLACEHOLDER = "python -m pip install -r requirements.txt\npnpm install";
const CLEANUP_PLACEHOLDER = "docker compose down --remove-orphans\nrm -rf .cache/tmp";
const WINDOWS_CLEANUP_PLACEHOLDER = "docker compose down --remove-orphans";

function SegmentedSelector<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((option) => (
        <NodexButton
          key={option.value}
          size="composer"
          variant={value === option.value ? "secondary" : "ghost"}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </NodexButton>
      ))}
    </div>
  );
}

function LifecycleEditor({
  kind,
  definition,
  onChange,
}: {
  kind: "setup" | "cleanup";
  definition: LocalEnvironmentDraftScriptDefinition;
  onChange: (definition: LocalEnvironmentDraftScriptDefinition) => void;
}) {
  const [platform, setPlatform] = useState<LifecyclePlatform>("default");
  const title = kind === "setup" ? "Setup script" : "Cleanup script";
  const textareaId = `local-environment-${kind}-script`;
  const placeholder =
    kind === "setup"
      ? platform === "win32"
        ? WINDOWS_SETUP_PLACEHOLDER
        : SETUP_PLACEHOLDER
      : platform === "win32"
        ? WINDOWS_CLEANUP_PLACEHOLDER
        : CLEANUP_PLACEHOLDER;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={textareaId} className="text-base font-medium text-token-text-primary">
            {title}
          </label>
          <p className="text-sm text-token-text-secondary">
            {kind === "setup"
              ? "Runs at the project root on worktree creation"
              : "Runs at the project root before worktree cleanup"}
          </p>
        </div>
        {kind === "setup" ? <LocalEnvironmentVariablesPopover /> : null}
      </div>
      <SegmentedSelector
        label={`${title} platform`}
        value={platform}
        options={LIFECYCLE_PLATFORM_OPTIONS}
        onChange={setPlatform}
      />
      <textarea
        id={textareaId}
        rows={6}
        value={readLocalEnvironmentPlatformSlot(definition, platform)}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(writeLocalEnvironmentPlatformSlot(definition, platform, event.target.value));
        }}
        className={cn(
          "w-full resize-y rounded-lg border-[0.5px] border-token-border bg-token-input-background px-3 py-2.5",
          "font-mono text-sm text-token-text-primary outline-hidden placeholder:text-token-text-secondary/60",
          "focus-visible:ring-2 focus-visible:ring-token-focus-border",
        )}
      />
    </section>
  );
}

function ActionIconMenu({
  action,
  onChange,
}: {
  action: LocalEnvironmentDraftAction;
  onChange: (action: LocalEnvironmentDraftAction) => void;
}) {
  const current = getLocalEnvironmentActionIconOption(action.icon);
  return (
    <NodexDropdownMenu
      contentWidth="icon"
      align="start"
      triggerButton={
        <NodexButton
          variant="secondary"
          className="size-12 shrink-0 justify-center px-0"
          aria-label={current.label}
        >
          <LocalEnvironmentActionIcon icon={action.icon} />
        </NodexButton>
      }
    >
      {LOCAL_ENVIRONMENT_ACTION_ICON_OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <NodexDropdownItem
            key={option.value}
            leftSlot={<Icon className="icon-sm" />}
            onSelect={() => onChange({ ...action, icon: option.value })}
          >
            {option.label}
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );
}

function ActionEditor({
  action,
  error,
  onChange,
  onDelete,
}: {
  action: LocalEnvironmentDraftAction;
  error: { name?: string; command?: string } | undefined;
  onChange: (action: LocalEnvironmentDraftAction) => void;
  onDelete: () => void;
}) {
  const nameErrorId = `local-environment-action-${action.id}-name-error`;
  const commandErrorId = `local-environment-action-${action.id}-command-error`;
  const nameId = `local-environment-action-${action.id}-name`;
  const commandId = `local-environment-action-${action.id}-command`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-token-border bg-token-input-background p-3">
      <div className="flex flex-col gap-2">
        <label
          htmlFor={nameId}
          className="text-xs font-medium tracking-wide text-token-text-secondary uppercase"
        >
          Name
        </label>
        <div className="flex items-center gap-2">
          <ActionIconMenu action={action} onChange={onChange} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Input
              id={nameId}
              value={action.name}
              aria-invalid={Boolean(error?.name)}
              aria-describedby={error?.name ? nameErrorId : undefined}
              onChange={(event) => onChange({ ...action, name: event.target.value })}
            />
            {error?.name ? (
              <p id={nameErrorId} className="text-sm text-token-error-foreground">
                {error.name}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor={commandId}
          className="text-xs font-medium tracking-wide text-token-text-secondary uppercase"
        >
          Action script
        </label>
        <textarea
          id={commandId}
          rows={4}
          value={action.command}
          placeholder="npm run dev"
          aria-invalid={Boolean(error?.command)}
          aria-describedby={error?.command ? commandErrorId : undefined}
          onChange={(event) => onChange({ ...action, command: event.target.value })}
          className={cn(
            "w-full resize-y rounded-lg border-[0.5px] border-token-border bg-token-input-background px-3 py-2.5",
            "font-mono text-sm text-token-text-primary outline-hidden placeholder:text-token-text-secondary/60",
            "focus-visible:ring-2 focus-visible:ring-token-focus-border",
          )}
        />
        {error?.command ? (
          <p id={commandErrorId} className="text-sm text-token-error-foreground">
            {error.command}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-xs font-medium tracking-wide text-token-text-secondary uppercase">
            Platforms
          </div>
          <SegmentedSelector
            label={`Platforms for ${action.name || "action"}`}
            value={action.platform ?? "all"}
            options={ACTION_PLATFORM_OPTIONS}
            onChange={(platform) =>
              onChange({
                ...action,
                platform: platform === "all" ? null : platform,
              })
            }
          />
        </div>
        <div className="flex justify-end sm:justify-center">
          <NodexButton variant="ghost" size="icon-sm" aria-label="Delete" onClick={onDelete}>
            <DeleteIcon className="icon-sm" />
          </NodexButton>
        </div>
      </div>
    </div>
  );
}

export interface LocalEnvironmentEditorProps {
  environment: WorktreeEnvironmentDefinition;
  parseErrorMessage?: string | null;
  onSave: (environment: WorktreeEnvironmentDefinition) => Promise<WorktreeEnvironmentSaveResult>;
  onSaved: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
}

export function LocalEnvironmentEditor({
  environment,
  parseErrorMessage,
  onSave,
  onSaved,
  onDiscard,
}: LocalEnvironmentEditorProps) {
  const [saveError, setSaveError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const [reloading, setReloading] = useState(false);
  // Draft action IDs belong to this editor session. Recreating them on render makes
  // TanStack Form reset untouched values and remount every keyed action subtree.
  const [defaultValues] = useState(() => createLocalEnvironmentDraft(environment));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const validation = validateLocalEnvironmentDraft(value);
      if (
        !form.state.isDirty ||
        validation.missingName ||
        validation.incompleteActionIds.length > 0 ||
        conflict
      )
        return;

      setSaveError(false);
      try {
        const result = await onSave(toPersistedLocalEnvironmentDefinition(value));
        if (result.type === "conflict") {
          setConflict(true);
          toast.warning(
            "This environment changed on disk. Discard your edits before saving again",
            {
              id: "local-environment-save-conflict",
            },
          );
          return;
        }
      } catch {
        setSaveError(true);
        return;
      }

      try {
        await onSaved();
        toast.success("Saved local environment", { id: "local-environment-saved" });
      } catch {
        setSelectionError(true);
        toast.warning("Saved the environment file, but could not select it", {
          id: "local-environment-selection-failed",
        });
      }
    },
  });
  const values = useStore(form.store, (state) => state.values as LocalEnvironmentDraft);
  const dirty = useStore(form.store, (state) => state.isDirty);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const validation = validateLocalEnvironmentDraft(values);
  const disabledReason = resolveLocalEnvironmentSaveDisabledReason({
    dirty,
    isSaving: isSubmitting || discarding || reloading,
    ready: true,
    validation,
  });
  const nameErrorId = "local-environment-name-error";

  function updateAction(nextAction: LocalEnvironmentDraftAction): void {
    form.setFieldValue(
      "actions",
      values.actions.map((action) => (action.id === nextAction.id ? nextAction : action)),
    );
  }

  const saveButton = conflict ? (
    <NodexButton
      onClick={() => {
        setDiscarding(true);
        void Promise.resolve(onDiscard()).finally(() => setDiscarding(false));
      }}
      disabled={discarding}
    >
      {discarding ? <ActivitySpinnerIcon className="icon-xs" /> : null}
      Discard edits
    </NodexButton>
  ) : selectionError ? (
    <NodexButton
      onClick={() => {
        setReloading(true);
        void Promise.resolve(onSaved())
          .then(() => {
            setSelectionError(false);
            toast.success("Saved local environment", { id: "local-environment-saved" });
          })
          .catch(() => {
            toast.warning("Saved the environment file, but could not select it", {
              id: "local-environment-selection-failed",
            });
          })
          .finally(() => setReloading(false));
      }}
      disabled={reloading}
    >
      {reloading ? <ActivitySpinnerIcon className="icon-xs" /> : null}
      Retry loading
    </NodexButton>
  ) : (
    <NodexButton type="submit" disabled={disabledReason !== null}>
      {isSubmitting ? <ActivitySpinnerIcon className="icon-xs" /> : null}
      {saveError ? "Retry save" : "Save"}
    </NodexButton>
  );

  return (
    <form
      className="flex flex-col gap-[var(--padding-panel)]"
      aria-busy={isSubmitting || discarding || reloading}
      onSubmit={(event) =>
        handleFormSubmit(event, () => {
          const currentValidation = validateLocalEnvironmentDraft(form.state.values);
          const currentReason = resolveLocalEnvironmentSaveDisabledReason({
            dirty: form.state.isDirty,
            isSaving: form.state.isSubmitting || discarding || reloading,
            ready: true,
            validation: currentValidation,
          });
          if (currentReason || conflict || selectionError) return;
          return form.handleSubmit();
        })
      }
    >
      <fieldset disabled={isSubmitting || discarding || reloading} className="contents">
        {parseErrorMessage ? (
          <div className="rounded-lg border-[0.5px] border-token-warning-foreground/30 bg-token-warning-background px-3 py-2 text-sm text-token-warning-foreground">
            This file could not be parsed. Saving will replace its current contents.
          </div>
        ) : null}

        {conflict ? (
          <div className="rounded-lg border-[0.5px] border-token-warning-foreground/30 bg-token-warning-background px-3 py-2 text-sm text-token-warning-foreground">
            This environment changed on disk. Continuing will discard your unsaved edits
          </div>
        ) : selectionError ? (
          <div className="rounded-lg border-[0.5px] border-token-warning-foreground/30 bg-token-warning-background px-3 py-2 text-sm text-token-warning-foreground">
            Saved the environment file, but could not select it
          </div>
        ) : saveError ? (
          <div className="rounded-lg border-[0.5px] border-token-error-foreground/30 bg-token-error-background px-3 py-2 text-sm text-token-error-foreground">
            Could not save the environment. Try again
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <label
            htmlFor="local-environment-name"
            className="text-base font-medium text-token-text-primary"
          >
            Name
          </label>
          <Input
            id="local-environment-name"
            className="max-w-72"
            value={values.name}
            aria-invalid={validation.missingName}
            aria-describedby={validation.missingName ? nameErrorId : undefined}
            onChange={(event) => form.setFieldValue("name", event.target.value)}
          />
          {validation.missingName ? (
            <p id={nameErrorId} className="text-sm text-token-error-foreground">
              Enter an environment name
            </p>
          ) : null}
        </section>

        <LifecycleEditor
          kind="setup"
          definition={values.setup}
          onChange={(setup) => form.setFieldValue("setup", setup)}
        />
        <LifecycleEditor
          kind="cleanup"
          definition={values.cleanup}
          onChange={(cleanup) => form.setFieldValue("cleanup", cleanup)}
        />

        <section className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-medium text-token-text-primary">Actions</h2>
              <p className="text-sm text-token-text-secondary">
                These actions can run any command and will be displayed in the header
              </p>
            </div>
            <NodexButton
              size="composer"
              variant="secondary"
              onClick={() =>
                form.setFieldValue("actions", [
                  ...values.actions,
                  createLocalEnvironmentDraftAction(),
                ])
              }
            >
              <PlusIcon className="icon-xs" />
              Add action
            </NodexButton>
          </div>

          <div className="flex flex-col gap-3">
            {values.actions.map((action) => (
              <ActionEditor
                key={action.id}
                action={action}
                error={validation.actionErrors[action.id]}
                onChange={updateAction}
                onDelete={() =>
                  form.setFieldValue(
                    "actions",
                    values.actions.filter((candidate) => candidate.id !== action.id),
                  )
                }
              />
            ))}
          </div>
        </section>
      </fieldset>

      <div className="flex justify-end">
        {!conflict && disabledReason ? (
          <NodexTooltip tooltipContent={LOCAL_ENVIRONMENT_SAVE_DISABLED_COPY[disabledReason]}>
            <span
              tabIndex={0}
              aria-label={LOCAL_ENVIRONMENT_SAVE_DISABLED_COPY[disabledReason]}
              className="inline-flex rounded-lg focus-visible:ring-2 focus-visible:ring-token-focus-border"
            >
              {saveButton}
            </span>
          </NodexTooltip>
        ) : (
          saveButton
        )}
      </div>
    </form>
  );
}
