import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AutomationTemplateColorIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { codexModelsListQueryOptions } from "@/lib/query-options";
import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  Project,
} from "@/lib/types";
import {
  buildCodexScheduledAutomationCreateInput,
  buildCodexScheduledAutomationUpdateInput,
  createWorkbenchAutomationDraft,
  createWorkbenchAutomationDraftFromCreateInput,
  createWorkbenchAutomationDraftFromUpdateInput,
  formatWorkbenchAutomationDraftSaveTooltip,
  isWorkbenchAutomationDraftDirty,
  resolveWorkbenchAutomationDraftModelSettings,
  validateWorkbenchAutomationDraft,
  type WorkbenchAutomationDraft,
} from "@/components/workbench/workbench-automation-draft";
import type { ScheduledTaskChatOption } from "./scheduled-task-fields";
import { ScheduledTaskForm } from "./scheduled-task-form";
import { useScheduledTasks } from "./use-scheduled-tasks";

export interface ScheduledTaskSidePanelProps {
  readonly automationId?: string | null;
  readonly createInput?: CodexScheduledAutomationCreateInput | null;
  /** `open` edits a saved task; the suggested modes review an Agent's proposal before saving it. */
  readonly mode?: "open" | "suggested-create" | "suggested-update";
  readonly projects: readonly Project[];
  readonly chats: readonly ScheduledTaskChatOption[];
  readonly title: string;
  readonly updateInput?: CodexScheduledAutomationUpdateInput | null;
  readonly onClose: () => void | Promise<void>;
  readonly onOpenInScheduled: (automationId: string) => void | Promise<void>;
  readonly onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
  readonly onSaved?: (automation: CodexScheduledAutomation) => void;
  readonly onTitleChange?: (title: string) => void;
}

function Unavailable({ description }: { description: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-token-main-surface-primary p-panel">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <AutomationTemplateColorIcon iconName="exclamationmark-bubble" className="icon-sm" />
        <div className="text-base text-token-foreground">Scheduled task unavailable</div>
        <div className="text-sm text-token-description-foreground">{description}</div>
      </div>
    </div>
  );
}

function seedDraft(input: {
  mode: NonNullable<ScheduledTaskSidePanelProps["mode"]>;
  createInput: CodexScheduledAutomationCreateInput | null | undefined;
  updateInput: CodexScheduledAutomationUpdateInput | null | undefined;
  task: CodexScheduledAutomation | null;
}): WorkbenchAutomationDraft | null {
  if (input.mode === "suggested-create")
    return input.createInput
      ? createWorkbenchAutomationDraftFromCreateInput(input.createInput)
      : null;
  if (input.mode === "suggested-update")
    return input.updateInput
      ? createWorkbenchAutomationDraftFromUpdateInput({
          update: input.updateInput,
          automation: input.task,
        })
      : null;
  return input.task ? createWorkbenchAutomationDraft({ automation: input.task }) : null;
}

/**
 * A scheduled task in a Chat's side panel: an Agent's proposed task or change to review, or a saved
 * task to adjust without leaving the Chat. Nothing is saved until the user confirms.
 */
export function ScheduledTaskSidePanel({
  automationId,
  createInput,
  mode = "open",
  projects,
  chats,
  updateInput,
  onClose,
  onOpenInScheduled,
  onOpenLocalEnvironmentsSettings,
  onSaved,
  onTitleChange,
}: ScheduledTaskSidePanelProps) {
  const tasks = useScheduledTasks();
  const modelsQuery = useQuery(codexModelsListQueryOptions());
  const targetId = updateInput?.id ?? automationId ?? null;
  const task = targetId
    ? (tasks.tasks.find((candidate) => candidate.id === targetId) ?? null)
    : null;
  const [draft, setDraft] = useState<WorkbenchAutomationDraft | null>(() =>
    seedDraft({ mode, createInput, updateInput, task }),
  );
  const [saving, setSaving] = useState(false);
  const lastTitleRef = useRef<string | null>(null);

  // A saved task may arrive after the panel opens.
  if (draft === null && mode === "open" && task) {
    setDraft(createWorkbenchAutomationDraft({ automation: task }));
  }

  // Model defaults resolve once the model catalog arrives.
  const models = modelsQuery.data;
  const [resolvedModels, setResolvedModels] = useState<typeof models>(undefined);
  if (draft && models && models !== resolvedModels) {
    setResolvedModels(models);
    setDraft(resolveWorkbenchAutomationDraftModelSettings({ draft, models }));
  }

  const name = draft?.name.trim() ?? "";
  useEffect(() => {
    if (!name || name === lastTitleRef.current) return;
    lastTitleRef.current = name;
    onTitleChange?.(name);
  }, [name, onTitleChange]);

  if (draft === null) {
    if (tasks.isLoading && targetId) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-token-description-foreground">
          Loading scheduled task…
        </div>
      );
    }
    return (
      <Unavailable
        description={
          mode === "open" || targetId
            ? "This scheduled task may have been deleted or is no longer available on this machine."
            : "This scheduled task proposal is missing required fields."
        }
      />
    );
  }

  const creates = mode === "suggested-create";
  const validation = validateWorkbenchAutomationDraft(draft);
  const dirty = creates || isWorkbenchAutomationDraftDirty({ draft, existing: task });
  const canSave = validation.canSave && dirty && !saving;
  const saveTooltip = formatWorkbenchAutomationDraftSaveTooltip({
    draft,
    action: creates ? "create" : "save",
  });
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const saved = creates
        ? await (async () => {
            const input = buildCodexScheduledAutomationCreateInput({ draft });
            return input ? await tasks.createTask(input) : null;
          })()
        : await (async () => {
            const update = buildCodexScheduledAutomationUpdateInput({
              draft,
              id: task?.id ?? updateInput?.id ?? draft.id,
            });
            return update ? await tasks.updateTask(update) : null;
          })();
      if (saved) onSaved?.(saved);
    } finally {
      setSaving(false);
    }
  };
  const acceptLabel = creates ? "Create" : mode === "suggested-update" ? "Apply changes" : "Save";
  const savedId = task?.id ?? (mode === "open" ? (automationId ?? null) : null);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-automation-side-panel-tab="true"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-panel">
        <div className="mx-auto w-full max-w-2xl">
          <ScheduledTaskForm
            showName
            kindLocked={!creates}
            draft={draft}
            onDraftChange={(update) =>
              setDraft((current) =>
                current === null
                  ? current
                  : typeof update === "function"
                    ? update(current)
                    : update,
              )
            }
            projects={projects}
            chats={chats}
            advancedInitiallyOpen
            codexModels={modelsQuery.data ?? []}
            disabled={saving}
            onSubmit={() => void save()}
            onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-token-border p-panel">
        {mode === "open" ? (
          <NodexButton
            variant="ghost"
            size="sm"
            disabled={!savedId}
            onClick={() => savedId && void onOpenInScheduled(savedId)}
          >
            Open in Scheduled
          </NodexButton>
        ) : (
          <NodexButton variant="ghost" size="sm" disabled={saving} onClick={() => void onClose()}>
            Cancel
          </NodexButton>
        )}
        <NodexTooltip tooltipContent={saveTooltip} disabled={saveTooltip === null} delayOpen>
          <span className="inline-flex">
            <NodexButton
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {acceptLabel}
            </NodexButton>
          </span>
        </NodexTooltip>
      </div>
    </div>
  );
}
