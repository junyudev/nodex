import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { codexModelsListQueryOptions } from "@/lib/query-options";
import type { CodexScheduledAutomation, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildCodexScheduledAutomationCreateInput,
  buildCodexScheduledAutomationUpdateInput,
  createWorkbenchAutomationDraft,
  formatWorkbenchAutomationDraftSaveTooltip,
  hasWorkbenchAutomationCreateDraftChanges,
  isWorkbenchAutomationDraftDirty,
  resolveWorkbenchAutomationDraftModelSettings,
  validateWorkbenchAutomationDraft,
  type WorkbenchAutomationDraft,
} from "@/components/workbench/workbench-automation-draft";
import {
  createWorkbenchAutomationDraftFromTemplate,
  type WorkbenchAutomationTemplate,
} from "@/components/workbench/workbench-automation-templates";
import type { ScheduledTaskChatOption } from "./scheduled-task-fields";
import { ScheduledTaskForm } from "./scheduled-task-form";
import { deriveScheduledTaskName } from "./scheduled-task-model";
import { seedWorkbenchAutomationProject } from "@/components/workbench/workbench-automation-project-options";
import type { ScheduledTasks } from "./use-scheduled-tasks";

export type ScheduledTaskDialogRequest =
  | {
      readonly kind: "create";
      readonly template: WorkbenchAutomationTemplate | null;
      /** A Page the new task follows as its runbook, and its title when it was chosen. */
      readonly runbook?: { readonly pageId: string; readonly title: string | null } | null;
      /** The Project the new task starts in. */
      readonly projectId?: string | null;
    }
  | { readonly kind: "edit"; readonly task: CodexScheduledAutomation };

/** A task created from a Page starts by following it; its instructions can add to that. */
const RUNBOOK_INSTRUCTIONS = "Follow the runbook.";

interface ScheduledTaskDialogProps {
  readonly request: ScheduledTaskDialogRequest | null;
  readonly tasks: ScheduledTasks;
  readonly projects: readonly Project[];
  readonly chats: readonly ScheduledTaskChatOption[];
  readonly onClose: () => void;
  readonly onCreated: (task: CodexScheduledAutomation) => void;
  readonly onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
}

/** 36px pill actions at the foot of the dialog. */
const DIALOG_PILL_CLASS = "h-9 rounded-full px-4 py-0 text-base leading-5";
const SECONDARY_PILL_CLASS = cn(
  DIALOG_PILL_CLASS,
  "bg-token-foreground/5 text-token-foreground enabled:hover:bg-token-foreground/10",
);

function initialDraft(
  request: ScheduledTaskDialogRequest,
  projects: readonly Project[],
): WorkbenchAutomationDraft {
  if (request.kind === "edit") return createWorkbenchAutomationDraft({ automation: request.task });
  const template = request.template
    ? createWorkbenchAutomationDraftFromTemplate(request.template)
    : createWorkbenchAutomationDraft();
  const project = seedWorkbenchAutomationProject(
    projects.find((candidate) => candidate.id === request.projectId),
  );
  const draft = project ? { ...template, ...project } : template;
  return request.runbook
    ? {
        ...draft,
        runbookPageId: request.runbook.pageId,
        runbookTitle: request.runbook.title,
        prompt: draft.prompt || RUNBOOK_INSTRUCTIONS,
      }
    : draft;
}

/** A new task without a name is named after its runbook when it has one, else its instructions. */
function draftToSave(
  request: ScheduledTaskDialogRequest,
  draft: WorkbenchAutomationDraft,
): WorkbenchAutomationDraft {
  if (request.kind === "edit" || draft.name.trim()) return draft;
  const runbookTitle = draft.runbookPageId ? draft.runbookTitle?.trim() : null;
  return { ...draft, name: runbookTitle || deriveScheduledTaskName(draft.prompt) };
}

function ScheduledTaskEditor({
  request,
  tasks,
  projects,
  chats,
  onClose,
  onCancel,
  onCreated,
  onOpenLocalEnvironmentsSettings,
  onDirtyChange,
  nameInputRef,
  instructionsRef,
}: Omit<ScheduledTaskDialogProps, "request"> & {
  readonly request: ScheduledTaskDialogRequest;
  readonly onCancel: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly nameInputRef: React.RefObject<HTMLInputElement | null>;
  readonly instructionsRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const modelsQuery = useQuery(codexModelsListQueryOptions());
  const [baseline, setBaseline] = useState(() => initialDraft(request, projects));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  // Model defaults resolve once the model catalog arrives, for both the draft and its baseline.
  const models = modelsQuery.data;
  const [resolvedModels, setResolvedModels] = useState<typeof models>(undefined);
  if (models && models !== resolvedModels) {
    setResolvedModels(models);
    setBaseline(resolveWorkbenchAutomationDraftModelSettings({ draft: baseline, models }));
    setDraft(resolveWorkbenchAutomationDraftModelSettings({ draft, models }));
  }
  const editedTask = request.kind === "edit" ? request.task : null;
  const liveTask = editedTask
    ? (tasks.tasks.find((task) => task.id === editedTask.id) ?? editedTask)
    : null;
  const submitted = draftToSave(request, draft);
  const validation = validateWorkbenchAutomationDraft(submitted);
  const dirty = editedTask
    ? isWorkbenchAutomationDraftDirty({ draft, existing: editedTask })
    : hasWorkbenchAutomationCreateDraftChanges(draft, baseline);
  const busy = saving || (liveTask !== null && tasks.pendingTaskId === liveTask.id);
  const saveTooltip = formatWorkbenchAutomationDraftSaveTooltip({
    draft: submitted,
    action: request.kind === "edit" ? "save" : "create",
  });

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const submit = async () => {
    if (!validation.canSave || busy) return;
    setSaving(true);
    try {
      if (editedTask) {
        const update = buildCodexScheduledAutomationUpdateInput({
          draft: { ...submitted, status: liveTask?.status ?? submitted.status },
          id: editedTask.id,
        });
        if (update && (await tasks.updateTask(update, "Could not save task"))) onClose();
        return;
      }
      const input = buildCodexScheduledAutomationCreateInput({ draft: submitted });
      const created = input ? await tasks.createTask(input) : null;
      if (created) onCreated(created);
    } finally {
      setSaving(false);
    }
  };

  const paused = liveTask?.status === "PAUSED";
  return (
    <form
      className="flex max-h-[min(85dvh,52rem)] min-h-0 flex-col gap-5 p-5"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <NodexDialogTitle className="shrink-0 pe-8 !text-lg !leading-[26px] !font-[590] !tracking-normal">
        {request.kind === "edit" ? "Edit task" : "Schedule a task"}
      </NodexDialogTitle>
      <div className="hide-scrollbar -mx-1 min-h-0 flex-auto overflow-y-auto px-1">
        <ScheduledTaskForm
          showName={request.kind === "edit"}
          kindLocked={request.kind === "edit"}
          draft={draft}
          onDraftChange={setDraft}
          projects={projects}
          chats={chats}
          codexModels={modelsQuery.data ?? []}
          disabled={busy}
          nameInputRef={nameInputRef}
          instructionsRef={instructionsRef}
          // A task started from a Page shows the runbook it follows, with its Project and Agent.
          advancedInitiallyOpen={request.kind === "create" && Boolean(request.runbook)}
          onSubmit={() => void submit()}
          onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
        />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-3">
        {liveTask ? (
          <NodexDialogAction
            className={SECONDARY_PILL_CLASS}
            disabled={busy}
            aria-busy={tasks.pendingTaskId === liveTask.id || undefined}
            onClick={() => void tasks.setTaskStatus(liveTask, paused ? "ACTIVE" : "PAUSED")}
          >
            {paused ? "Resume" : "Pause"}
          </NodexDialogAction>
        ) : (
          <NodexDialogAction className={SECONDARY_PILL_CLASS} onClick={onCancel}>
            Cancel
          </NodexDialogAction>
        )}
        <NodexTooltip tooltipContent={saveTooltip} disabled={saveTooltip === null} delayOpen>
          <span className="inline-flex">
            <NodexDialogAction
              type="submit"
              tone="primary"
              className={DIALOG_PILL_CLASS}
              disabled={busy || !validation.canSave || (editedTask !== null && !dirty)}
            >
              {request.kind === "edit" ? "Save" : "Create"}
            </NodexDialogAction>
          </span>
        </NodexTooltip>
      </div>
    </form>
  );
}

function DiscardChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <NodexDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Discard changes?</NodexDialogTitle>
            <NodexDialogDescription>Your changes will not be saved</NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction className={SECONDARY_PILL_CLASS} onClick={onKeepEditing}>
              Keep editing
            </NodexDialogAction>
            <NodexDialogAction tone="danger" className={DIALOG_PILL_CLASS} onClick={onDiscard}>
              Discard changes
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/**
 * Creates or edits a scheduled task over the Scheduled page. Closing with unsaved changes asks
 * before discarding them.
 */
export function ScheduledTaskDialog({
  request,
  onClose,
  ...editorProps
}: ScheduledTaskDialogProps) {
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const requestKey =
    request === null
      ? null
      : request.kind === "edit"
        ? `edit:${request.task.id}`
        : `create:${request.template?.id ?? ""}`;
  const requestClose = () => {
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <NodexDialog
        open={request !== null}
        onOpenChange={(open, details) => {
          if (open) return;
          details.cancel();
          requestClose();
        }}
      >
        <NodexDialogContent
          aria-describedby={undefined}
          closeButtonClassName="top-5 right-5"
          className="w-[680px] rounded-[30px] bg-token-dropdown-background shadow-[0_8px_10px_-6px_rgb(0_0_0/0.1),0_20px_25px_-5px_rgb(0_0_0/0.1)] backdrop-blur-none"
          initialFocus={() => {
            if (request?.kind !== "edit") return instructionsRef.current;
            nameInputRef.current?.select();
            return nameInputRef.current;
          }}
        >
          {request ? (
            <ScheduledTaskEditor
              key={requestKey}
              request={request}
              onClose={onClose}
              onCancel={requestClose}
              onDirtyChange={setDirty}
              nameInputRef={nameInputRef}
              instructionsRef={instructionsRef}
              {...editorProps}
            />
          ) : null}
        </NodexDialogContent>
      </NodexDialog>
      <DiscardChangesDialog
        open={confirmingDiscard}
        onKeepEditing={() => setConfirmingDiscard(false)}
        onDiscard={() => {
          setConfirmingDiscard(false);
          setDirty(false);
          onClose();
        }}
      />
    </>
  );
}
