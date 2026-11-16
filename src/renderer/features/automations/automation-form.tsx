import { FormattedMessage, defineMessage, useIntl } from "@/lib/i18n";
import {
  DEFAULT_AUTOMATION_SOURCE_FILTER,
  AutomationSourceFields,
} from "./automation-event-fields";
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
import { useLocalMember, useMembers } from "@/lib/members-runtime";
import {
  AutomationAgentDropdown,
  AutomationModelPicker,
  useAutomationAgent,
} from "@/components/workbench/workbench-automation-intelligence";
import {
  DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  resolveWorkbenchAutomationDraftModelSettings,
  type WorkbenchAutomationDraft,
} from "@/components/workbench/workbench-automation-draft";
import {
  AutomationChatField,
  AutomationEnvironmentField,
  AutomationFieldRow,
  AutomationFieldTrigger,
  AutomationModeField,
  AutomationProjectField,
  AutomationRunbookField,
  AutomationScheduleFields,
  type AutomationChatOption,
} from "./automation-fields";

export interface AutomationFormProps {
  /** A new task in the dialog is named after its instructions; elsewhere the name is editable. */
  readonly showName: boolean;
  /** Whether runs share one chat is fixed once a task exists. */
  readonly kindLocked: boolean;
  readonly draft: WorkbenchAutomationDraft;
  readonly onDraftChange: Dispatch<SetStateAction<WorkbenchAutomationDraft>>;
  readonly projects: readonly Project[];
  readonly chats: readonly AutomationChatOption[];
  readonly codexModels: readonly AgentModelOption[];
  readonly disabled: boolean;
  readonly readOnly?: boolean;
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
  {
    value: "all",
    label: defineMessage({ id: "automations.automationForm.allRuns", defaultMessage: "All runs" }),
  },
  {
    value: "failed_runs_only",
    label: defineMessage({
      id: "automations.automationForm.failedRunsOnly",
      defaultMessage: "Failed runs only",
    }),
  },
] as const;
const WORKSPACE_CHOICES = [
  {
    value: "local",
    label: defineMessage({ id: "automations.automationForm.local", defaultMessage: "Local" }),
  },
  {
    value: "worktree",
    label: defineMessage({ id: "automations.automationForm.worktree", defaultMessage: "Worktree" }),
  },
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
      sourceCondition: null,
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
        : draft.backendBinding.kind === "acp"
          ? ""
          : DEFAULT_WORKBENCH_AUTOMATION_REASONING_EFFORT,
  };
  return codexModels.length > 0
    ? resolveWorkbenchAutomationDraftModelSettings({ draft: next, models: codexModels })
    : next;
}

/** Rows that share a card are separated by inset hairlines. */
const ROW_HAIRLINES =
  "*:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-token-border-light [&>*+*]:before:content-['']";

/** One advanced setting, set apart in its own rounded card. */
function AdvancedCard({ children }: { children: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-token-border", ROW_HAIRLINES)}>{children}</div>
  );
}

/** The Agent a task runs with and, when each run starts a new chat, that Agent's model. */
function AutomationAgentFields({
  draft,
  codexModels,
  disabled,
  onChange,
}: {
  readonly draft: WorkbenchAutomationDraft;
  readonly codexModels: readonly AgentModelOption[];
  readonly disabled: boolean;
  readonly onChange: (draft: WorkbenchAutomationDraft) => void;
}) {
  const intl = useIntl();
  const agent = useAutomationAgent({ draft, codexModels, onChange });
  return (
    <>
      <AutomationFieldRow
        label={intl.formatMessage({
          id: "automations.automationForm.agent",
          defaultMessage: "Agent",
        })}
      >
        <span className="pe-1.5">
          <AutomationAgentDropdown agent={agent} disabled={disabled} />
        </span>
      </AutomationFieldRow>
      {draft.kind === "cron" ? (
        <AutomationFieldRow
          label={intl.formatMessage({
            id: "automations.automationForm.model",
            defaultMessage: "Model",
          })}
        >
          <span className="pe-1.5">
            <AutomationModelPicker
              agent={agent}
              draft={draft}
              codexModels={codexModels}
              disabled={disabled}
              onChange={onChange}
            />
          </span>
        </AutomationFieldRow>
      ) : null}
    </>
  );
}

/**
 * The automation editor shared by the Automations dialog and the side panel: name (when editing),
 * instructions, the schedule card, and the Advanced settings.
 */
export function AutomationForm({
  showName,
  kindLocked,
  draft,
  onDraftChange,
  projects,
  chats,
  codexModels,
  disabled: pending,
  readOnly = false,
  nameInputRef,
  instructionsRef,
  advancedInitiallyOpen = false,
  onSubmit,
  onOpenLocalEnvironmentsSettings,
}: AutomationFormProps) {
  const intl = useIntl();
  const [advancedOpen, setAdvancedOpen] = useState(advancedInitiallyOpen);
  const members = useMembers();
  const localMember = useLocalMember();
  const ownerMemberId = draft.ownerMemberId ?? localMember.data?.id ?? "";
  const activeMembers = members.data?.filter((member) => member.lifecycle === "active") ?? [];
  const canChangeMode = localMember.data?.id === ownerMemberId;
  const disabled = pending || readOnly;
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
          aria-label={intl.formatMessage({
            id: "automations.automationForm.name",
            defaultMessage: "Name",
          })}
          placeholder={intl.formatMessage({
            id: "automations.automationForm.automationName",
            defaultMessage: "Automation name",
          })}
          value={draft.name}
          maxLength={250}
          disabled={disabled}
          className="h-10 w-full rounded-2xl border border-token-foreground/[0.08] bg-transparent px-[18px] text-base text-token-foreground outline-none placeholder:text-token-text-tertiary focus-visible:border-token-focus-border"
          onChange={(event) => patch({ name: event.currentTarget.value })}
          onKeyDown={submitOnModEnter}
        />
      ) : null}
      <input
        aria-label={intl.formatMessage({
          id: "automations.automationForm.condition",
          defaultMessage: "Condition",
        })}
        placeholder={intl.formatMessage({
          id: "automations.automationForm.when",
          defaultMessage: "When…",
        })}
        value={draft.conditionText}
        disabled={disabled}
        className="h-10 w-full rounded-2xl border border-token-foreground/[0.08] bg-transparent px-[18px] text-base text-token-foreground outline-none placeholder:text-token-text-tertiary focus-visible:border-token-focus-border"
        onChange={(event) => patch({ conditionText: event.currentTarget.value })}
        onKeyDown={submitOnModEnter}
      />
      <textarea
        aria-label={intl.formatMessage({
          id: "automations.automationForm.instructions",
          defaultMessage: "Instructions",
        })}
        placeholder={intl.formatMessage({
          id: "automations.automationForm.instructions2",
          defaultMessage: "Instructions…",
        })}
        value={draft.prompt}
        ref={instructionsRef}
        disabled={disabled}
        className="min-h-[122px] w-full resize-none rounded-[20px] border border-token-foreground/[0.08] bg-transparent px-[18px] py-4 text-base leading-5 text-token-foreground outline-none [field-sizing:content] placeholder:text-token-text-tertiary focus-visible:border-token-focus-border"
        onChange={(event) => patch({ prompt: event.currentTarget.value })}
        onKeyDown={submitOnModEnter}
      />
      <div
        role="group"
        aria-label={intl.formatMessage({
          id: "automations.automationForm.schedule",
          defaultMessage: "Schedule",
        })}
        className={cn("rounded-[20px] border border-token-foreground/[0.16]", ROW_HAIRLINES)}
      >
        {isCron ? (
          <AutomationFieldRow
            label={intl.formatMessage({
              id: "automations.automationForm.when2",
              defaultMessage: "When",
            })}
          >
            <NodexOptionPicker
              value={draft.sourceCondition ? "source" : "clock"}
              options={[
                {
                  value: "clock",
                  label: intl.formatMessage({
                    id: "automations.automationForm.onASchedule",
                    defaultMessage: "On a schedule",
                  }),
                },
                {
                  value: "source",
                  label: intl.formatMessage({
                    id: "automations.automationForm.somethingHappensOnGitHub",
                    defaultMessage: "Something happens on GitHub",
                  }),
                },
              ]}
              search="none"
              title={intl.formatMessage({
                id: "automations.automationForm.when2",
                defaultMessage: "When",
              })}
              disabled={disabled}
              onValueChange={(value) =>
                patch({
                  sourceCondition: value === "source" ? DEFAULT_AUTOMATION_SOURCE_FILTER : null,
                  mode: value === "source" ? "dry_run" : draft.mode,
                })
              }
              triggerButton={
                <AutomationFieldTrigger
                  ariaLabel={intl.formatMessage({
                    id: "automations.automationForm.when2",
                    defaultMessage: "When",
                  })}
                  disabled={disabled}
                >
                  {draft.sourceCondition
                    ? intl.formatMessage({
                        id: "automations.automationForm.somethingHappensOnGitHub",
                        defaultMessage: "Something happens on GitHub",
                      })
                    : intl.formatMessage({
                        id: "automations.automationForm.onASchedule",
                        defaultMessage: "On a schedule",
                      })}
                </AutomationFieldTrigger>
              }
            />
          </AutomationFieldRow>
        ) : null}
        {draft.sourceCondition ? (
          <AutomationSourceFields
            value={draft.sourceCondition}
            disabled={disabled}
            onChange={(sourceCondition) => patch({ sourceCondition })}
          />
        ) : (
          <AutomationScheduleFields
            rrule={draft.rrule}
            timezone={draft.timezone}
            intervalStyle={isCron ? "default" : "heartbeat"}
            disabled={disabled}
            onRruleChange={(rrule) => patch({ rrule })}
          />
        )}
        <AutomationModeField
          mode={draft.mode}
          disabled={disabled || !canChangeMode}
          canChooseRun={canChangeMode}
          onModeChange={(mode) => patch({ mode })}
        />
        {!draft.sourceCondition ? (
          <AutomationFieldRow
            label={intl.formatMessage({
              id: "automations.automationForm.timeZone",
              defaultMessage: "Time zone",
            })}
          >
            <NodexOptionPicker
              value={draft.timezone}
              options={[...new Set([draft.timezone, ...Intl.supportedValuesOf("timeZone")])].map(
                (value) => ({ value, label: value.replaceAll("_", " ") }),
              )}
              search="filter"
              title={intl.formatMessage({
                id: "automations.automationForm.timeZone",
                defaultMessage: "Time zone",
              })}
              searchAriaLabel="Search time zones"
              disabled={disabled}
              onValueChange={(timezone) => patch({ timezone })}
              triggerButton={
                <AutomationFieldTrigger
                  ariaLabel={intl.formatMessage({
                    id: "automations.automationForm.timeZone",
                    defaultMessage: "Time zone",
                  })}
                  disabled={disabled}
                >
                  {draft.timezone.replaceAll("_", " ")}
                </AutomationFieldTrigger>
              }
            />
          </AutomationFieldRow>
        ) : null}
        {members.data && members.data.length > 1 ? (
          <AutomationFieldRow
            label={intl.formatMessage({
              id: "automations.automationForm.owner",
              defaultMessage: "Owner",
            })}
          >
            <NodexOptionPicker
              value={ownerMemberId}
              options={activeMembers.map((member) => ({
                value: member.id,
                label: member.display_name,
              }))}
              search="filter"
              title={intl.formatMessage({
                id: "automations.automationForm.owner",
                defaultMessage: "Owner",
              })}
              searchAriaLabel="Search Members"
              disabled={disabled}
              onValueChange={(ownerMemberId) =>
                patch({
                  ownerMemberId,
                  mode:
                    draft.mode === "run" && ownerMemberId !== localMember.data?.id
                      ? "ask_first"
                      : draft.mode,
                })
              }
              triggerButton={
                <AutomationFieldTrigger
                  ariaLabel={intl.formatMessage({
                    id: "automations.automationForm.owner",
                    defaultMessage: "Owner",
                  })}
                  disabled={disabled}
                >
                  {activeMembers.find((member) => member.id === ownerMemberId)?.display_name ??
                    intl.formatMessage({
                      id: "automations.automationForm.removedMember",
                      defaultMessage: "Removed Member",
                    })}
                </AutomationFieldTrigger>
              }
            />
          </AutomationFieldRow>
        ) : null}
      </div>
      <div className="flex flex-col">
        <button
          type="button"
          id="automation-advanced-trigger"
          aria-expanded={advancedOpen}
          aria-controls="automation-advanced"
          className="no-drag inline-flex shrink-0 cursor-interaction items-center gap-1 self-start rounded-md px-2 py-1 text-base leading-[18px] text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-foreground"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <FormattedMessage id="automations.automationForm.advanced" defaultMessage="Advanced" />
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
              id="automation-advanced"
              role="region"
              aria-labelledby="automation-advanced-trigger"
              className="grid overflow-hidden"
              initial={{ gridTemplateRows: "0fr", opacity: 0 }}
              animate={{ gridTemplateRows: "1fr", opacity: 1 }}
              exit={{ gridTemplateRows: "0fr", opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.2, 0, 0, 1] }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="flex flex-col gap-3 pt-3">
                  <AdvancedCard>
                    <AutomationFieldRow
                      label={intl.formatMessage({
                        id: "automations.automationForm.notifications",
                        defaultMessage: "Notifications",
                      })}
                    >
                      <NodexOptionPicker
                        value={draft.notificationPolicy ?? "all"}
                        options={NOTIFICATION_CHOICES.map((choice) => ({
                          ...choice,
                          label: intl.formatMessage(choice.label),
                        }))}
                        title={intl.formatMessage({
                          id: "automations.automationForm.notifications",
                          defaultMessage: "Notifications",
                        })}
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
                          <AutomationFieldTrigger
                            ariaLabel={intl.formatMessage({
                              id: "automations.automationForm.notifications",
                              defaultMessage: "Notifications",
                            })}
                            disabled={disabled}
                          >
                            {draft.notificationPolicy === "failed_runs_only"
                              ? intl.formatMessage({
                                  id: "automations.automationForm.failedRunsOnly",
                                  defaultMessage: "Failed runs only",
                                })
                              : intl.formatMessage({
                                  id: "automations.automationForm.allRuns",
                                  defaultMessage: "All runs",
                                })}
                          </AutomationFieldTrigger>
                        }
                      />
                    </AutomationFieldRow>
                  </AdvancedCard>
                  <AdvancedCard>
                    <AutomationFieldRow
                      label={intl.formatMessage({
                        id: "automations.automationForm.startEachRunInNew",
                        defaultMessage: "Start each run in new chat",
                      })}
                    >
                      <NodexTooltip
                        tooltipContent={intl.formatMessage({
                          id: "automations.automationForm.chosenWhenTheTaskIs",
                          defaultMessage: "Chosen when the task is created",
                        })}
                        disabled={!kindLocked}
                      >
                        <span className="inline-flex pe-3">
                          <NodexSwitch
                            ariaLabel={intl.formatMessage({
                              id: "automations.automationForm.startEachRunInNew",
                              defaultMessage: "Start each run in new chat",
                            })}
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
                    </AutomationFieldRow>
                  </AdvancedCard>
                  {isCron ? null : (
                    <AdvancedCard>
                      <AutomationChatField
                        chats={chats}
                        selectedChatId={draft.targetSessionId}
                        disabled={disabled}
                        onSelectedChatIdChange={(targetSessionId) => patch({ targetSessionId })}
                      />
                    </AdvancedCard>
                  )}
                  {isCron ? (
                    <AdvancedCard>
                      <AutomationProjectField
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
                      <AutomationFieldRow
                        label={intl.formatMessage({
                          id: "automations.automationForm.workspace",
                          defaultMessage: "Workspace",
                        })}
                      >
                        <NodexOptionPicker
                          value={draft.executionEnvironment}
                          options={WORKSPACE_CHOICES.map((choice) => ({
                            ...choice,
                            label: intl.formatMessage(choice.label),
                          }))}
                          title={intl.formatMessage({
                            id: "automations.automationForm.workspace",
                            defaultMessage: "Workspace",
                          })}
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
                            <AutomationFieldTrigger
                              ariaLabel={intl.formatMessage({
                                id: "automations.automationForm.workspace",
                                defaultMessage: "Workspace",
                              })}
                              disabled={disabled}
                            >
                              {draft.executionEnvironment === "worktree"
                                ? intl.formatMessage({
                                    id: "automations.automationForm.worktree",
                                    defaultMessage: "Worktree",
                                  })
                                : intl.formatMessage({
                                    id: "automations.automationForm.local",
                                    defaultMessage: "Local",
                                  })}
                            </AutomationFieldTrigger>
                          }
                        />
                      </AutomationFieldRow>
                    </AdvancedCard>
                  ) : null}
                  {isCron &&
                  draft.backendBinding.kind === "codex" &&
                  draft.executionEnvironment === "worktree" &&
                  draft.cwds.length === 1 ? (
                    <AdvancedCard>
                      <AutomationEnvironmentField
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
                    <AutomationRunbookField
                      pageId={draft.runbookPageId}
                      title={draft.runbookTitle}
                      disabled={disabled}
                      onChange={({ pageId, title }) =>
                        patch({ runbookPageId: pageId, runbookTitle: title })
                      }
                    />
                  </AdvancedCard>
                  <AdvancedCard>
                    <AutomationAgentFields
                      draft={draft}
                      codexModels={codexModels}
                      disabled={disabled}
                      onChange={(next) => onDraftChange(next)}
                    />
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
