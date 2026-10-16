import {
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDownIcon } from "@/components/shared/icons";
import { NodexSwitch } from "@/components/ui/button";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { AgentModelOption, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AutomationIntelligenceDropdown } from "@/components/workbench/workbench-automation-intelligence";
import {
  DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  resolveWorkbenchAutomationDraftModelSettings,
  type WorkbenchAutomationDraft,
} from "@/components/workbench/workbench-automation-draft";
import {
  ScheduledChatField,
  ScheduledEnvironmentField,
  ScheduledFieldRow,
  ScheduledFieldTrigger,
  ScheduledProjectField,
  ScheduledScheduleFields,
  type ScheduledTaskChatOption,
} from "./scheduled-task-fields";

export interface ScheduledTaskFormProps {
  /** A new task in the dialog is named after its instructions; elsewhere the name is editable. */
  readonly showName: boolean;
  /** Whether runs share one chat is fixed once a task exists. */
  readonly kindLocked: boolean;
  readonly draft: WorkbenchAutomationDraft;
  readonly onDraftChange: Dispatch<SetStateAction<WorkbenchAutomationDraft>>;
  readonly projects: readonly Project[];
  readonly chats: readonly ScheduledTaskChatOption[];
  readonly codexModels: readonly AgentModelOption[];
  readonly disabled: boolean;
  readonly nameInputRef?: Ref<HTMLInputElement>;
  readonly instructionsRef?: Ref<HTMLTextAreaElement>;
  /** Reviewing a whole proposal shows every setting up front. */
  readonly advancedInitiallyOpen?: boolean;
  readonly onSubmit: () => void;
  readonly onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
}

const NOTIFICATION_CHOICES = [
  { value: "all", label: "All runs" },
  { value: "failed_runs_only", label: "Failed runs only" },
] as const;
const WORKSPACE_CHOICES = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "Worktree" },
] as const;

/** Each run starts its own chat (a cron task) or continues one chat (a Heartbeat). */
function withNewChatEachRun(
  draft: WorkbenchAutomationDraft,
  newChatEachRun: boolean,
  codexModels: readonly AgentModelOption[],
): WorkbenchAutomationDraft {
  if (!newChatEachRun) {
    return {
      ...draft,
      kind: "heartbeat",
      projectId: null,
      cwds: [],
      model: "",
      reasoningEffort: "",
      serviceTier: "",
      executionEnvironment: "worktree",
      localEnvironmentConfigPath: "",
    };
  }
  const next: WorkbenchAutomationDraft = {
    ...draft,
    kind: "cron",
    targetSessionId: "",
    executionEnvironment: "local",
    localEnvironmentConfigPath: "",
    model: draft.backendBinding.kind === "claude" ? "default" : "",
    reasoningEffort:
      draft.backendBinding.kind === "claude"
        ? "default"
        : DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  };
  return codexModels.length > 0
    ? resolveWorkbenchAutomationDraftModelSettings({ draft: next, models: codexModels })
    : next;
}

/** One advanced setting, set apart in its own rounded card. */
function AdvancedCard({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-token-border">{children}</div>;
}

/**
 * The scheduled task editor shared by the Scheduled dialog and the side panel: name (when editing),
 * instructions, the schedule card, and the Advanced settings.
 */
export function ScheduledTaskForm({
  showName,
  kindLocked,
  draft,
  onDraftChange,
  projects,
  chats,
  codexModels,
  disabled,
  nameInputRef,
  instructionsRef,
  advancedInitiallyOpen = false,
  onSubmit,
  onOpenLocalEnvironmentsSettings,
}: ScheduledTaskFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(advancedInitiallyOpen);
  const reducedMotion = useReducedMotion();
  const patch = (next: Partial<WorkbenchAutomationDraft>) =>
    onDraftChange((current) => ({ ...current, ...next }));
  const isCron = draft.kind === "cron";
  const submitOnModEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 text-base">
      {showName ? (
        <input
          ref={nameInputRef}
          aria-label="Name"
          placeholder="Task name"
          value={draft.name}
          maxLength={250}
          disabled={disabled}
          className="h-10 w-full rounded-2xl border border-token-foreground/[0.08] bg-transparent px-[18px] text-base text-token-foreground outline-none placeholder:text-token-text-tertiary focus-visible:border-token-focus-border"
          onChange={(event) => patch({ name: event.currentTarget.value })}
          onKeyDown={submitOnModEnter}
        />
      ) : null}
      <textarea
        aria-label="Instructions"
        placeholder="Instructions…"
        value={draft.prompt}
        ref={instructionsRef}
        disabled={disabled}
        className="min-h-[122px] w-full resize-none rounded-[20px] border border-token-foreground/[0.08] bg-transparent px-[18px] py-4 text-base leading-5 text-token-foreground outline-none [field-sizing:content] placeholder:text-token-text-tertiary focus-visible:border-token-focus-border"
        onChange={(event) => patch({ prompt: event.currentTarget.value })}
        onKeyDown={submitOnModEnter}
      />
      <div
        role="group"
        aria-label="Schedule"
        // Rows are separated by inset hairlines.
        className="rounded-[20px] border border-token-foreground/[0.16] *:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-token-border-light [&>*+*]:before:content-['']"
      >
        <ScheduledScheduleFields
          rrule={draft.rrule}
          intervalStyle={isCron ? "default" : "heartbeat"}
          disabled={disabled}
          onRruleChange={(rrule) => patch({ rrule })}
        />
      </div>
      <div className="flex flex-col">
        <button
          type="button"
          id="scheduled-task-advanced-trigger"
          aria-expanded={advancedOpen}
          aria-controls="scheduled-task-advanced"
          className="no-drag inline-flex shrink-0 cursor-interaction items-center gap-1 self-start rounded-md px-2 py-1 text-base leading-[18px] text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-foreground"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          Advanced
          <ChevronDownIcon
            className={cn(
              "icon-2xs motion-safe:transition-transform motion-safe:duration-200",
              advancedOpen && "-rotate-180",
            )}
          />
        </button>
        <AnimatePresence initial={false}>
          {advancedOpen ? (
            <motion.div
              id="scheduled-task-advanced"
              role="region"
              aria-labelledby="scheduled-task-advanced-trigger"
              className="grid overflow-hidden"
              initial={{ gridTemplateRows: "0fr", opacity: 0 }}
              animate={{ gridTemplateRows: "1fr", opacity: 1 }}
              exit={{ gridTemplateRows: "0fr", opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.2, 0, 0, 1] }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="flex flex-col gap-3 pt-3">
                  <AdvancedCard>
                    <ScheduledFieldRow label="Notifications">
                      <NodexOptionPicker
                        value={draft.notificationPolicy ?? "all"}
                        options={NOTIFICATION_CHOICES}
                        title="Notifications"
                        align="end"
                        side="bottom"
                        contentWidth="sm"
                        disabled={disabled}
                        onValueChange={(value) =>
                          patch({
                            notificationPolicy: value === "failed_runs_only" ? value : null,
                          })
                        }
                        triggerButton={
                          <ScheduledFieldTrigger ariaLabel="Notifications" disabled={disabled}>
                            {draft.notificationPolicy === "failed_runs_only"
                              ? "Failed runs only"
                              : "All runs"}
                          </ScheduledFieldTrigger>
                        }
                      />
                    </ScheduledFieldRow>
                  </AdvancedCard>
                  <AdvancedCard>
                    <ScheduledFieldRow label="Start each run in new chat">
                      <NodexTooltip
                        tooltipContent="Chosen when the task is created"
                        disabled={!kindLocked}
                      >
                        <span className="inline-flex pe-3">
                          <NodexSwitch
                            ariaLabel="Start each run in new chat"
                            checked={isCron}
                            disabled={disabled || kindLocked}
                            onCheckedChange={(checked) =>
                              onDraftChange((current) =>
                                withNewChatEachRun(current, checked, codexModels),
                              )
                            }
                          />
                        </span>
                      </NodexTooltip>
                    </ScheduledFieldRow>
                  </AdvancedCard>
                  {isCron ? null : (
                    <AdvancedCard>
                      <ScheduledChatField
                        chats={chats}
                        selectedChatId={draft.targetSessionId}
                        disabled={disabled}
                        onSelectedChatIdChange={(targetSessionId) => patch({ targetSessionId })}
                      />
                    </AdvancedCard>
                  )}
                  {isCron ? (
                    <AdvancedCard>
                      <ScheduledProjectField
                        projects={projects}
                        selectedRoots={draft.cwds}
                        selectedProjectId={draft.projectId}
                        disabled={disabled}
                        onSelectionChange={(selection) =>
                          patch({
                            ...selection,
                            localEnvironmentConfigPath: "",
                            ...(selection.projectId === null
                              ? { executionEnvironment: "local" as const }
                              : {}),
                          })
                        }
                      />
                    </AdvancedCard>
                  ) : null}
                  {isCron && draft.projectId !== null ? (
                    <AdvancedCard>
                      <ScheduledFieldRow label="Workspace">
                        <NodexOptionPicker
                          value={draft.executionEnvironment}
                          options={WORKSPACE_CHOICES}
                          title="Workspace"
                          align="end"
                          side="bottom"
                          contentWidth="sm"
                          disabled={disabled}
                          onValueChange={(value) =>
                            patch({
                              executionEnvironment: value === "worktree" ? "worktree" : "local",
                              localEnvironmentConfigPath: "",
                            })
                          }
                          triggerButton={
                            <ScheduledFieldTrigger ariaLabel="Workspace" disabled={disabled}>
                              {draft.executionEnvironment === "worktree" ? "Worktree" : "Local"}
                            </ScheduledFieldTrigger>
                          }
                        />
                      </ScheduledFieldRow>
                    </AdvancedCard>
                  ) : null}
                  {isCron &&
                  draft.backendBinding.kind === "codex" &&
                  draft.executionEnvironment === "worktree" &&
                  draft.cwds.length === 1 ? (
                    <AdvancedCard>
                      <ScheduledEnvironmentField
                        projects={projects.filter((project) => project.id === draft.projectId)}
                        selectedRoot={draft.cwds[0] ?? ""}
                        selectedConfigPath={draft.localEnvironmentConfigPath}
                        disabled={disabled}
                        onSelectedConfigPathChange={(localEnvironmentConfigPath) =>
                          patch({ localEnvironmentConfigPath })
                        }
                        onOpenSettings={onOpenLocalEnvironmentsSettings}
                      />
                    </AdvancedCard>
                  ) : null}
                  <AdvancedCard>
                    <ScheduledFieldRow label={isCron ? "Model" : "Agent"}>
                      <span className="pe-1.5">
                        <AutomationIntelligenceDropdown
                          draft={draft}
                          codexModels={codexModels}
                          disabled={disabled}
                          onChange={(next) => onDraftChange(next)}
                        />
                      </span>
                    </ScheduledFieldRow>
                  </AdvancedCard>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
