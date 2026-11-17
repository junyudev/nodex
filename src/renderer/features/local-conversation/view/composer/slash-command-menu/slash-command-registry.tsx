import { defineMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { isHostedChat } from "@/lib/hosted-chat";
import { useState } from "react";
import type { FeedbackUploadParams, McpServerStatus } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import {
  ClipboardListIcon,
  GitMergeIcon,
  SendIcon,
  SplitIcon,
} from "@/components/shared/icons/generic-icons";
import { CheckmarkIcon } from "@/components/shared/icons";
import {
  ClearContextIcon,
  FastModeIcon,
  GoalTargetIcon,
  SettingsWorktreeIcon,
  SlashFeedbackIcon,
  SlashMcpIcon,
  SlashMemoriesIcon,
  SlashModelIcon,
  SlashPetIcon,
  SlashReasoningIcon,
  SlashSideIcon,
  SlashStatusIcon,
  ComposerPlanModeIcon,
  UltracodeIcon,
  UltrafastModeIcon,
} from "@/components/shared/icons";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  resolveCodexSpeedTiers,
} from "@/lib/codex-thread-settings";
import { codexSpeed, type CodexSpeed } from "../../../../../../shared/codex-service-tier";
import { toast } from "@/components/ui/toast";
import { useMcpServerStatuses } from "@/lib/use-mcp-queries";
import type { CodexReasoningEffort, CodexServiceTier } from "@/lib/types";
import type { ThreadFooterModel, ThreadStageActions } from "../../../thread-stage-types";
import { getThreadGoalMessage, THREAD_GOAL_DEFAULT_MESSAGES } from "../../../thread-goal-copy";
import type { ComposerSlashCommand, ComposerSlashCommandContentProps } from "./slash-command-types";
import { hasPlanMode, resolveNextComposerPlanMode } from "../composer-plan-mode";

interface BuildSlashCommandsInput {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  serviceTier: CodexServiceTier;
  setServiceTier: (tier: CodexServiceTier, source: string) => void;
  openExpandedDialog: () => void;
  onPetToggle: () => void;
  activateGoalMode: () => void;
}

const iconClassName = "icon-xs shrink-0";

function canStartNewThreadGoalDraft(
  model: ThreadFooterModel,
  actions: ThreadStageActions,
): boolean {
  if (!model.isNewThreadTab) return false;
  if (!model.newThreadTarget) return false;

  return Boolean(model.newThreadTarget.sessionId && actions.onStartThreadForSession);
}

export function canUseComposerGoal(model: ThreadFooterModel, actions: ThreadStageActions): boolean {
  if (model.provider && model.provider.kind !== "codex") return false;
  if (model.provider?.controls?.goals === false) return false;
  if (model.conversation === null) {
    return canStartNewThreadGoalDraft(model, actions);
  }

  return Boolean(actions.onGetThreadGoal && actions.onSetThreadGoal && actions.onClearThreadGoal);
}

export function buildComposerSlashCommands(
  input: BuildSlashCommandsInput,
  intl = getIntl(),
): ComposerSlashCommand[] {
  const threadId = input.model.conversation?.threadId ?? input.model.threadId;
  const canUseThread = Boolean(threadId);
  const canUseExistingThread = Boolean(input.model.conversation);
  const canUseGoal = canUseComposerGoal(input.model, input.actions);
  const isSideConversation = input.model.conversation?.source?.sideConversation === true;
  const latestTurnId = input.model.body.latestTurnId;
  const provider = input.model.provider;
  const isCodex = !provider || provider.kind === "codex";
  const native = provider?.nativeIntelligence;
  // A conversation that owns its speed changes its own selection, not the saved default.
  const ownedServiceTier = provider?.serviceTier;
  const codexTier = codexSpeed(
    ownedServiceTier !== undefined ? ownedServiceTier : input.serviceTier,
  );
  const speedTiers = isCodex
    ? resolveCodexSpeedTiers(input.model.selectedModel, input.model.availableModels)
    : [];
  const fastOn = native ? native.selected.fast === true : codexTier === "fast";
  const setCodexSpeed = async (speed: CodexSpeed) => {
    const serviceTier = codexTier === speed ? null : speed;
    const commit = input.actions.onIntelligenceSelectionChange;
    if (ownedServiceTier === undefined || !commit) {
      input.setServiceTier(serviceTier, "slash_command");
      return;
    }
    await runCommand(
      getIntl().formatMessage({
        id: "conversation.slashCommandRegistry.fastFailed",
        defaultMessage: "Could not change speed",
      }),
      () =>
        commit({
          kind: input.model.provider?.kind ?? "codex",
          model: input.model.selectedModel,
          reasoningEffort: input.model.selectedReasoningEffort,
          serviceTier,
        }),
    );
  };
  const speedTier = (speed: CodexSpeed) => speedTiers.find((tier) => tier.value === speed);
  const ultracodeOn = native?.capabilities.ultracode === true && native.selected.ultracode === true;
  const ultracodeUnavailable = native?.capabilities.ultracodeUnavailableReason;
  const inspectNativeRuntime =
    !isCodex && provider?.diagnostics && input.actions.onOpenStatusPanel && threadId
      ? () => input.actions.onOpenStatusPanel?.(threadId)
      : undefined;
  const commands: ComposerSlashCommand[] = [
    {
      id: "compact",
      title: "Compact",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.compact",
        defaultMessage: "Compact",
        description: "Action to compact the chat context",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.compactDescription",
        defaultMessage: "Compact this thread's context",
      }),
      group: "Commands",
      icon: <ClipboardListIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(input.actions.onCompactThread),
      isEnabled: !input.model.isThreadRunning,
      onSelect: async () => {
        if (!threadId || !input.actions.onCompactThread) return;
        if (input.model.isThreadRunning) {
          toast.danger(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.waitBeforeCompacting",
              defaultMessage: "Wait for Nodex to finish responding before compacting",
            }),
          );
          return;
        }
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.compactFailed",
            defaultMessage: "Failed to compact thread",
          }),
          async () => {
            await input.actions.onCompactThread?.(threadId);
          },
        );
      },
    },
    {
      id: "clear",
      title: "Clear context",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.clear",
        defaultMessage: "Clear context",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.clearDescription",
        defaultMessage: "Clear this chat's context; its workspace stays",
      }),
      group: "Commands",
      icon: <ClearContextIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(input.actions.onClearContext),
      isEnabled: !input.model.isThreadRunning,
      onSelect: async () => {
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.clearFailed",
            defaultMessage: "Could not clear the context",
          }),
          async () => {
            await input.actions.onClearContext?.();
          },
        );
      },
    },
    {
      // Named like the mode so a native `/fast` command never shows twice.
      id: "fast",
      title: "Fast",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.fast",
        defaultMessage: "Fast",
      }),
      description: fastOn
        ? intl.formatMessage({
            id: "conversation.slashCommandRegistry.fastOff",
            defaultMessage: "Turn Fast off",
          })
        : speedTier("fast")?.description ||
          intl.formatMessage({
            id: "conversation.slashCommandRegistry.fastUsage",
            defaultMessage: "Faster output, more usage",
          }),
      group: "Commands",
      icon: <FastModeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: native ? native.capabilities.fastMode === true : speedTier("fast") !== undefined,
      onSelect: async () => {
        if (!native) return await setCodexSpeed("fast");
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.fastFailed",
            defaultMessage: "Could not change speed",
          }),
          () => native.change({ fast: !fastOn }),
        );
      },
    },
    {
      id: "ultrafast",
      title: "Ultrafast",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.ultrafast",
        defaultMessage: "Ultrafast",
      }),
      description:
        codexTier === "ultrafast"
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultrafastOff",
              defaultMessage: "Turn Ultrafast off",
            })
          : speedTier("ultrafast")?.description ||
            intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultrafastUsage",
              defaultMessage: "Even faster, more expensive",
            }),
      group: "Commands",
      icon: <UltrafastModeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: !native && speedTier("ultrafast") !== undefined,
      onSelect: () => setCodexSpeed("ultrafast"),
    },
    {
      id: "ultracode",
      title: "Ultracode",
      description:
        ultracodeUnavailable ??
        (ultracodeOn
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultracodeOff",
              defaultMessage: "Turn Ultracode off",
            })
          : intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultracodeDescription",
              defaultMessage: "Run a multi-agent workflow for each task",
            })),
      group: "Commands",
      icon: <UltracodeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: native?.capabilities.ultracode === true || ultracodeUnavailable !== undefined,
      isEnabled: ultracodeUnavailable === undefined,
      onSelect: async () => {
        if (!native || ultracodeUnavailable !== undefined) return;
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.ultracodeFailed",
            defaultMessage: "Could not change Ultracode",
          }),
          () => native.change({ ultracode: !ultracodeOn }),
        );
      },
    },
    {
      id: "feedback",
      title: "Feedback",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.feedback",
        defaultMessage: "Feedback",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.feedbackDescription",
        defaultMessage: "Send feedback about this chat",
      }),
      group: "Commands",
      icon: <SlashFeedbackIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: Boolean(input.actions.onUploadFeedback),
      Content: (props) => (
        <FeedbackCommandContent
          threadId={threadId}
          uploadFeedback={input.actions.onUploadFeedback}
          {...props}
        />
      ),
    },
    {
      id: "fork",
      title: "Fork",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.fork",
        defaultMessage: "Fork",
        description: "Action to fork a chat",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.forkDescription",
        defaultMessage: "Fork this chat into a new local chat",
      }),
      group: "Commands",
      icon: <SettingsWorktreeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && !isSideConversation,
      isEnabled: Boolean(threadId && (input.actions.onForkThread || latestTurnId)),
      Content: (props) => (
        <ForkCommandContent
          threadId={threadId}
          turnId={latestTurnId}
          onForkFromTurn={input.actions.onForkFromTurn}
          onForkThread={input.actions.onForkThread}
          {...props}
        />
      ),
    },
    {
      id: "merge",
      title: "Merge back",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.merge",
        defaultMessage: "Merge back",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.mergeDescription",
        defaultMessage: "Bring this fork's work into the chat it came from",
      }),
      group: "Commands",
      icon: <GitMergeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(input.actions.onMergeForkBack),
      isEnabled: !input.model.isThreadRunning,
      onSelect: async () => {
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.mergeFailed",
            defaultMessage: "Could not merge this fork",
          }),
          async () => {
            await input.actions.onMergeForkBack?.();
          },
        );
      },
    },
    {
      id: "goal",
      title: THREAD_GOAL_DEFAULT_MESSAGES["composer.goalSlashCommand.title"].defaultMessage,
      titleMessage: THREAD_GOAL_DEFAULT_MESSAGES["composer.goalSlashCommand.title"],
      description: getThreadGoalMessage("composer.goalSlashCommand.setDescription", intl),
      group: "Commands",
      icon: <GoalTargetIcon className={iconClassName} />,
      requiresEmptyComposer: false,
      isVisible: canUseGoal,
      onSelect: () => {
        input.activateGoalMode();
      },
      onSelectFromInlineSlash: (selection) => {
        selection.clearTrigger();
        input.activateGoalMode();
      },
    },
    {
      id: "mcp",
      title: "MCP",
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.mcpDescription",
        defaultMessage: "Show MCP server status",
      }),
      group: "Commands",
      icon: <SlashMcpIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      // This desktop's MCP servers are not a hosted chat's; its host runs its own tools.
      isVisible: (isCodex && !isHostedChat()) || Boolean(inspectNativeRuntime),
      ...(inspectNativeRuntime
        ? { onSelect: inspectNativeRuntime }
        : {
            Content: (props: ComposerSlashCommandContentProps) => (
              <McpCommandContent threadId={threadId} {...props} />
            ),
          }),
    },
    {
      id: "memories",
      title: "Memories",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.memories",
        defaultMessage: "Memories",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.memoriesDescription",
        defaultMessage: "Configure memory for this thread",
      }),
      group: "Commands",
      icon: <SlashMemoriesIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(input.actions.onSetThreadMemoryMode),
      Content: (props) => (
        <MemoryCommandContent
          threadId={threadId}
          setMemoryMode={input.actions.onSetThreadMemoryMode}
          {...props}
        />
      ),
    },
    {
      id: "model",
      title: "Model",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.model",
        defaultMessage: "Model",
      }),
      description: formatCodexModelLabel(input.model.selectedModel, input.model.availableModels),
      group: "Commands",
      icon: <SlashModelIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      Content: (props) => (
        <ModelCommandContent
          model={input.model}
          onModelChange={input.actions.onModelChange}
          {...props}
        />
      ),
    },
    {
      id: "pet",
      title: "Pet",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.pet",
        defaultMessage: "Pet",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.petDescription",
        defaultMessage: "Wake or tuck away the desktop pet",
      }),
      group: "Commands",
      icon: <SlashPetIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      onSelect: () => input.onPetToggle(),
    },
    {
      id: "side",
      title: "Side",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.side",
        defaultMessage: "Side",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.sideDescription",
        defaultMessage: "Open an independent chat beside this one",
      }),
      group: "Commands",
      icon: <SlashSideIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible:
        canUseExistingThread && !isSideConversation && Boolean(input.actions.onOpenSideChat),
      onSelect: async () => {
        await runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.sideFailed",
            defaultMessage: "Failed to open side chat",
          }),
          async () => {
            await input.actions.onOpenSideChat?.();
          },
        );
      },
    },
    {
      id: "project",
      title: "Project",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.project",
        defaultMessage: "Project",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.projectDescription",
        defaultMessage: "Switch the new chat project",
      }),
      group: "Commands",
      icon: <SplitIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: Boolean(
        input.model.isNewThreadTab &&
        input.model.newThreadProjectSelector &&
        !input.model.newThreadProjectSelector.disabled,
      ),
      Content: (props) => (
        <ProjectCommandContent model={input.model} actions={input.actions} {...props} />
      ),
    },
    {
      id: "reasoning",
      title: "Reasoning",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.reasoning",
        defaultMessage: "Reasoning",
      }),
      description: formatCodexReasoningEffortLabel(input.model.selectedReasoningEffort, intl),
      group: "Commands",
      icon: <SlashReasoningIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      Content: (props) => (
        <ReasoningCommandContent
          selectedReasoningEffort={input.model.selectedReasoningEffort}
          options={input.model.reasoningEffortOptions}
          onReasoningEffortChange={input.actions.onReasoningEffortChange}
          {...props}
        />
      ),
    },
    {
      id: "plan-mode",
      title: "Plan mode",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.planMode",
        defaultMessage: "Plan mode",
      }),
      description:
        input.model.selectedCollaborationMode === "plan"
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.planModeOff",
              defaultMessage: "Switch off plan mode",
            })
          : intl.formatMessage({
              id: "conversation.slashCommandRegistry.planModeOn",
              defaultMessage: "Switch to plan mode",
            }),
      group: "Commands",
      icon: <ComposerPlanModeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: hasPlanMode(input.model.collaborationModes),
      onSelect: () => {
        const nextMode = resolveNextComposerPlanMode({
          currentMode: input.model.selectedCollaborationMode,
          modes: input.model.collaborationModes,
        });
        if (!nextMode) return;
        void input.actions.onCollaborationModeChange(nextMode);
      },
    },
    {
      id: "status",
      title: "Status",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.status",
        defaultMessage: "Status",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.statusDescription",
        defaultMessage: "Show chat id, context usage, and rate limits",
      }),
      group: "Commands",
      icon: <SlashStatusIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseThread,
      onSelect: () => {
        if (!threadId) return;
        if (input.actions.onOpenStatusPanel) {
          input.actions.onOpenStatusPanel(threadId);
          return;
        }
        toast.info(
          getIntl().formatMessage(
            {
              id: "conversation.slashCommandRegistry.threadId",
              defaultMessage: "Thread {threadId}",
            },
            { threadId },
          ),
          {
            description: input.model.conversation?.statusType ?? "idle",
          },
        );
      },
    },
    {
      id: "expanded-slash-command-dialog",
      title: "Slash commands",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.slashCommands",
        defaultMessage: "Slash commands",
      }),
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.slashCommandsDescription",
        defaultMessage: "Search and run slash commands",
      }),
      group: "Commands",
      icon: <SendIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
      onSelect: input.openExpandedDialog,
    },
  ];

  if (!provider) return commands;
  // App commands advertise their own semantic capability above. Provider identity must not
  // hide common chat actions; native commands fill only names the app cannot currently offer.
  const nativeCommands = provider.commands.filter(
    (command) =>
      !commands.some((shared) => shared.id === command.name && shared.isVisible !== false),
  );
  return [
    ...commands.filter((command) => !nativeCommands.some((native) => native.name === command.id)),
    ...nativeCommands.map((command): ComposerSlashCommand => ({
      id: command.name,
      title: command.name,
      description: command.description,
      group: "Commands",
      icon: <SendIcon className={iconClassName} />,
      onSelectFromInlineSlash: (selection) => selection.replaceTrigger(`/${command.name} `),
      onSelect: async () => {
        await input.actions.onSendPrompt(`/${command.name}`);
      },
    })),
  ];
}

function ModelCommandContent({
  model,
  onModelChange,
  close,
}: ComposerSlashCommandContentProps & {
  model: ThreadFooterModel;
  onModelChange: (model: string) => void;
}) {
  return (
    <CommandPanel>
      {model.availableModels
        .filter((candidate) => !candidate.hidden)
        .map((candidate) => (
          <CommandPanelRow
            key={candidate.id}
            title={formatCodexModelLabel(candidate.id, model.availableModels)}
            description={candidate.description}
            selected={candidate.id === model.selectedModel}
            onClick={() => {
              onModelChange(candidate.id);
              close();
            }}
          />
        ))}
    </CommandPanel>
  );
}

function ReasoningCommandContent({
  selectedReasoningEffort,
  options,
  onReasoningEffortChange,
  close,
}: ComposerSlashCommandContentProps & {
  selectedReasoningEffort: CodexReasoningEffort;
  options: ThreadFooterModel["reasoningEffortOptions"];
  onReasoningEffortChange: (effort: CodexReasoningEffort) => void;
}) {
  const intl = useIntl();
  return (
    <CommandPanel>
      {options.map((option) => (
        <CommandPanelRow
          key={option.reasoningEffort}
          title={formatCodexReasoningEffortLabel(option.reasoningEffort, intl)}
          description={option.description}
          selected={option.reasoningEffort === selectedReasoningEffort}
          onClick={() => {
            onReasoningEffortChange(option.reasoningEffort);
            close();
          }}
        />
      ))}
    </CommandPanel>
  );
}

function ProjectCommandContent({
  model,
  actions,
  close,
}: ComposerSlashCommandContentProps & {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
}) {
  const intl = useIntl();
  const selector = model.newThreadProjectSelector;
  if (!selector)
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.noProjects",
          defaultMessage: "No projects",
        })}
      </CommandMessage>
    );
  if (selector.disabled) {
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.projectFixed",
          defaultMessage: "Project is fixed for this task",
        })}
      </CommandMessage>
    );
  }

  return (
    <CommandPanel>
      {selector.projects.map((project) => (
        <CommandPanelRow
          key={project.id}
          title={project.label}
          description={project.description}
          selected={project.id === selector.selectedProjectId}
          onClick={() => {
            actions.onNewThreadProjectChange?.(project.id);
            close();
          }}
        />
      ))}
    </CommandPanel>
  );
}

function ForkCommandContent({
  threadId,
  turnId,
  onForkFromTurn,
  onForkThread,
  close,
}: ComposerSlashCommandContentProps & {
  threadId: string | null | undefined;
  turnId: string | null | undefined;
  onForkFromTurn: ThreadStageActions["onForkFromTurn"];
  onForkThread?: ThreadStageActions["onForkThread"];
}) {
  const intl = useIntl();
  return (
    <CommandPanel>
      <CommandPanelRow
        title={intl.formatMessage({
          id: "conversation.slashCommandRegistry.forkChat",
          defaultMessage: "Fork chat",
        })}
        description={intl.formatMessage({
          id: "conversation.slashCommandRegistry.forkChatDescription",
          defaultMessage: "Continue this conversation in a new chat",
        })}
        disabled={!threadId || (!onForkThread && !turnId)}
        onClick={async () => {
          if (!threadId || (!onForkThread && !turnId)) return;
          await runCommand(
            intl.formatMessage({
              id: "conversation.slashCommandRegistry.forkFailed",
              defaultMessage: "Failed to fork thread",
            }),
            async () => {
              if (onForkThread) await onForkThread("local");
              else if (turnId) await onForkFromTurn({ threadId, turnId, message: "" });
              close();
            },
          );
        }}
      />
    </CommandPanel>
  );
}

function MemoryCommandContent({
  threadId,
  setMemoryMode,
  close,
}: ComposerSlashCommandContentProps & {
  threadId: string | null | undefined;
  setMemoryMode?: (input: { threadId: string; mode: ThreadMemoryMode }) => Promise<void>;
}) {
  const intl = useIntl();
  const selectMode = async (mode: ThreadMemoryMode) => {
    if (!threadId || !setMemoryMode) return;
    await runCommand(
      intl.formatMessage({
        id: "conversation.slashCommandRegistry.updateMemoriesFailed",
        defaultMessage: "Failed to update memories",
      }),
      async () => {
        await setMemoryMode({ threadId, mode });
        close();
      },
    );
  };

  if (!setMemoryMode)
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.memoriesUnavailable",
          defaultMessage: "Memories are not available in this context",
        })}
      </CommandMessage>
    );

  return (
    <CommandPanel>
      <CommandPanelRow
        title={intl.formatMessage({
          id: "conversation.slashCommandRegistry.memoriesEnabled",
          defaultMessage: "Enabled",
        })}
        description={intl.formatMessage({
          id: "conversation.slashCommandRegistry.enableMemoriesHint",
          defaultMessage: "Allow thread memory updates",
        })}
        onClick={() => void selectMode("enabled")}
      />
      <CommandPanelRow
        title={intl.formatMessage({
          id: "conversation.slashCommandRegistry.memoriesDisabled",
          defaultMessage: "Disabled",
        })}
        description={intl.formatMessage({
          id: "conversation.slashCommandRegistry.disableMemoriesHint",
          defaultMessage: "Do not update memories from this thread",
        })}
        onClick={() => void selectMode("disabled")}
      />
    </CommandPanel>
  );
}

const McpCommandContent: React.ComponentType<
  ComposerSlashCommandContentProps & { threadId: string | null | undefined }
> = () => {
  const intl = useIntl();
  const { data: response, error, isPending } = useMcpServerStatuses();
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : intl.formatMessage({
          id: "conversation.slashCommandRegistry.loadMcpFailed",
          defaultMessage: "Could not load MCP status",
        })
    : null;

  if (errorMessage) return <CommandMessage>{errorMessage}</CommandMessage>;
  if (isPending || !response)
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.loadingMcp",
          defaultMessage: "Loading MCP servers",
        })}
      </CommandMessage>
    );

  const statuses = response.data;
  if (statuses.length === 0)
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.noMcpServers",
          defaultMessage: "No MCP servers",
        })}
      </CommandMessage>
    );

  return (
    <CommandPanel>
      {statuses.map((status) => (
        <CommandPanelRow
          key={status.name}
          title={status.name}
          description={formatMcpAuthStatus(intl, status.authStatus)}
          selected={status.authStatus !== "notLoggedIn"}
        />
      ))}
    </CommandPanel>
  );
};

function formatMcpAuthStatus(intl: IntlShape, status: McpServerStatus["authStatus"]): string {
  if (status === "notLoggedIn")
    return intl.formatMessage({
      id: "conversation.slashCommandRegistry.mcpLoginRequired",
      defaultMessage: "Login required",
    });
  if (status === "bearerToken")
    return intl.formatMessage({
      id: "conversation.slashCommandRegistry.mcpAuthenticated",
      defaultMessage: "Authenticated",
    });
  if (status === "oAuth")
    return intl.formatMessage({
      id: "conversation.slashCommandRegistry.oauthConnected",
      defaultMessage: "OAuth connected",
    });
  return intl.formatMessage({
    id: "conversation.slashCommandRegistry.mcpAvailable",
    defaultMessage: "Available",
  });
}

function FeedbackCommandContent({
  threadId,
  uploadFeedback,
  close,
}: ComposerSlashCommandContentProps & {
  threadId: string | null | undefined;
  uploadFeedback?: (params: FeedbackUploadParams) => Promise<void>;
}) {
  const intl = useIntl();
  const [reason, setReason] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);

  if (!uploadFeedback)
    return (
      <CommandMessage>
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.feedbackUnavailable",
          defaultMessage: "Feedback is not available in this context",
        })}
      </CommandMessage>
    );

  return (
    <div className="space-y-2 p-2">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={intl.formatMessage({
          id: "conversation.slashCommandRegistry.feedbackPlaceholder",
          defaultMessage: "What should we know?",
        })}
        className="min-h-24 w-full resize-none rounded-lg bg-token-input-background px-3 py-2 text-sm text-token-foreground outline-none ring-[0.5px] ring-token-border/50 placeholder:text-token-description-foreground"
      />
      <label className="flex items-center gap-2 text-sm text-token-description-foreground">
        <input
          type="checkbox"
          checked={includeLogs}
          onChange={(event) => setIncludeLogs(event.target.checked)}
        />
        {intl.formatMessage({
          id: "conversation.slashCommandRegistry.includeLogs",
          defaultMessage: "Include logs",
        })}
      </label>
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md bg-token-foreground px-2 py-1 text-sm text-token-dropdown-background disabled:opacity-50"
          disabled={reason.trim().length === 0}
          onClick={async () => {
            const params: FeedbackUploadParams = {
              classification: "feedback",
              reason: reason.trim(),
              threadId: threadId ?? null,
              includeLogs,
            };
            await runCommand(
              intl.formatMessage({
                id: "conversation.slashCommandRegistry.sendFeedbackFailed",
                defaultMessage: "Failed to send feedback",
              }),
              async () => {
                await uploadFeedback(params);
                toast.success(
                  intl.formatMessage({
                    id: "conversation.slashCommandRegistry.feedbackSent",
                    defaultMessage: "Feedback sent",
                  }),
                );
                close();
              },
            );
          }}
        >
          {intl.formatMessage({
            id: "conversation.slashCommandRegistry.sendFeedback",
            defaultMessage: "Send",
          })}
        </button>
      </div>
    </div>
  );
}

function CommandPanel({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col py-1">{children}</div>;
}

function CommandPanelRow({
  title,
  description,
  selected = false,
  disabled = false,
  onClick,
}: {
  title: string;
  description?: string | null;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="mx-1 flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-token-foreground hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-45"
      // Like the command rows, a panel row keeps the Composer focused so the menu stays open
      // until its click runs.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span className="icon-xs shrink-0 text-token-description-foreground">
        {selected ? <CheckmarkIcon className={iconClassName} /> : <span className="block size-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {description ? (
        <span className="min-w-0 flex-1 truncate text-token-description-foreground">
          {description}
        </span>
      ) : null}
    </button>
  );
}

function CommandMessage({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-sm text-token-description-foreground">{children}</div>;
}

async function runCommand(errorMessage: string, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : errorMessage);
  }
}
