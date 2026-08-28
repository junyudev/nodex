import { useState } from "react";
import type { FeedbackUploadParams, McpServerStatus } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import {
  ClipboardListIcon,
  MessageCirclePlusIcon,
  MessagesSquareIcon,
  SendIcon,
  SplitIcon,
} from "@/components/shared/icons/generic-icons";
import { CheckmarkIcon } from "@/components/shared/icons";
import {
  FastModeIcon,
  GoalTargetIcon,
  SettingsWorktreeIcon,
  SlashCodeReviewIcon,
  SlashFeedbackIcon,
  SlashMcpIcon,
  SlashMemoriesIcon,
  SlashModelIcon,
  SlashPersonalityIcon,
  SlashPetIcon,
  SlashReasoningIcon,
  SlashSideIcon,
  SlashStatusIcon,
  ComposerPlanModeIcon,
} from "@/components/shared/icons";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
} from "@/lib/codex-thread-settings";
import { toast } from "@/components/ui/toast";
import { useMcpServerStatuses } from "@/lib/use-mcp-queries";
import type { CodexPersonality, CodexReasoningEffort, CodexServiceTier } from "@/lib/types";
import type { ThreadFooterModel, ThreadStageActions } from "../../../thread-stage-types";
import { getThreadGoalMessage } from "../../../thread-goal-copy";
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
  if (model.isCloudNewThreadTarget) return false;

  return Boolean(model.newThreadTarget.sessionId && actions.onStartThreadForSession);
}

export function canUseComposerGoal(model: ThreadFooterModel, actions: ThreadStageActions): boolean {
  if (model.conversation === null) {
    return canStartNewThreadGoalDraft(model, actions);
  }

  return Boolean(actions.onGetThreadGoal && actions.onSetThreadGoal && actions.onClearThreadGoal);
}

export function buildComposerSlashCommands(input: BuildSlashCommandsInput): ComposerSlashCommand[] {
  const threadId = input.model.conversation?.threadId ?? input.model.threadId;
  const canUseThread = Boolean(threadId);
  const canUseExistingThread = Boolean(input.model.conversation);
  const canUseGoal = canUseComposerGoal(input.model, input.actions);
  const isSideConversation = input.model.conversation?.source?.sideConversation === true;
  const latestTurnId = input.model.body.latestTurnId;
  const commands: ComposerSlashCommand[] = [
    {
      id: "compact",
      title: "Compact",
      description: "Compact this thread's context",
      group: "Commands",
      icon: <ClipboardListIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(input.actions.onCompactThread),
      isEnabled: !input.model.isThreadRunning,
      onSelect: async () => {
        if (!threadId || !input.actions.onCompactThread) return;
        if (input.model.isThreadRunning) {
          toast.danger("Wait for Nodex to finish responding before compacting");
          return;
        }
        await runCommand("Failed to compact thread", async () => {
          await input.actions.onCompactThread?.(threadId);
        });
      },
    },
    {
      id: "service-tier:fast",
      title: "Fast",
      description: "1.5x speed, increased usage",
      group: "Commands",
      icon: <FastModeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      onSelect: () => {
        input.setServiceTier(input.serviceTier === "fast" ? null : "fast", "slash_command");
      },
    },
    {
      id: "feedback",
      title: "Feedback",
      description: "Send feedback about this chat",
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
      description: "Fork this chat into a new local chat",
      group: "Commands",
      icon: <SettingsWorktreeIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && !isSideConversation,
      isEnabled: Boolean(threadId && latestTurnId),
      Content: (props) => (
        <ForkCommandContent
          threadId={threadId}
          turnId={latestTurnId}
          onForkFromTurn={input.actions.onForkFromTurn}
          {...props}
        />
      ),
    },
    {
      id: "goal",
      title: getThreadGoalMessage("composer.goalSlashCommand.title"),
      description: getThreadGoalMessage("composer.goalSlashCommand.setDescription"),
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
      description: "Show MCP server status",
      group: "Commands",
      icon: <SlashMcpIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      Content: (props) => <McpCommandContent threadId={threadId} {...props} />,
    },
    {
      id: "memories",
      title: "Memories",
      description: "Configure memory for this thread",
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
      id: "personality",
      title: "Personality",
      description:
        input.model.selectedPersonality === "pragmatic"
          ? "Pragmatic"
          : input.model.selectedPersonality === "none"
            ? "None"
            : "Friendly",
      group: "Commands",
      icon: <SlashPersonalityIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: Boolean(input.actions.onPersonalityChange),
      Content: (props) => (
        <PersonalityCommandContent
          selectedPersonality={input.model.selectedPersonality ?? "friendly"}
          onPersonalityChange={input.actions.onPersonalityChange}
          {...props}
        />
      ),
    },
    {
      id: "pet",
      title: "Pet",
      description: "Wake or tuck away the desktop pet",
      group: "Commands",
      icon: <SlashPetIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      onSelect: () => input.onPetToggle(),
    },
    {
      id: "side",
      title: "Side",
      description: "Start a side conversation in an ephemeral fork",
      group: "Commands",
      icon: <SlashSideIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible:
        canUseExistingThread && !isSideConversation && Boolean(input.actions.onOpenSideChat),
      onSelect: async () => {
        await runCommand("Failed to open side chat", async () => {
          await input.actions.onOpenSideChat?.();
        });
      },
    },
    {
      id: "project",
      title: "Project",
      description: "Switch the new chat project",
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
      description: formatCodexReasoningEffortLabel(input.model.selectedReasoningEffort),
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
      description:
        input.model.selectedCollaborationMode === "plan"
          ? "Switch off plan mode"
          : "Switch to plan mode",
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
      description: "Show chat id, context usage, and rate limits",
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
        toast.info(`Thread ${threadId}`, {
          description: input.model.conversation?.statusType ?? "idle",
        });
      },
    },
    {
      id: "chat",
      title: "Chat",
      description: "Start a projectless chat",
      group: "Commands",
      icon: <MessagesSquareIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
    },
    {
      id: "hotkey-window-new",
      title: "New hotkey window",
      description: "Open a new hotkey window",
      group: "Commands",
      icon: <MessageCirclePlusIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
    },
    {
      id: "hotkey-window-resume",
      title: "Resume hotkey window",
      description: "Resume a previous hotkey window",
      group: "Commands",
      icon: <MessagesSquareIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
    },
    {
      id: "review-mode",
      title: "Auto review",
      description: "Review pending changes",
      group: "Commands",
      icon: <SlashCodeReviewIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
    },
    {
      id: "expanded-slash-command-dialog",
      title: "Slash commands",
      description: "Search and run slash commands",
      group: "Commands",
      icon: <SendIcon className={iconClassName} />,
      requiresEmptyComposer: true,
      isVisible: false,
      onSelect: input.openExpandedDialog,
    },
  ];

  return commands;
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
  return (
    <CommandPanel>
      {options.map((option) => (
        <CommandPanelRow
          key={option.reasoningEffort}
          title={formatCodexReasoningEffortLabel(option.reasoningEffort)}
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
  const selector = model.newThreadProjectSelector;
  if (!selector) return <CommandMessage>No projects</CommandMessage>;
  if (selector.disabled) {
    return <CommandMessage>Project is fixed for this task</CommandMessage>;
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
  close,
}: ComposerSlashCommandContentProps & {
  threadId: string | null | undefined;
  turnId: string | null | undefined;
  onForkFromTurn: ThreadStageActions["onForkFromTurn"];
}) {
  return (
    <CommandPanel>
      <CommandPanelRow
        title="Fork conversation"
        description="Create a new branch from the latest turn"
        disabled={!threadId || !turnId}
        onClick={async () => {
          if (!threadId || !turnId) return;
          await runCommand("Failed to fork thread", async () => {
            await onForkFromTurn({ threadId, turnId, message: "" });
            close();
          });
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
  const selectMode = async (mode: ThreadMemoryMode) => {
    if (!threadId || !setMemoryMode) return;
    await runCommand("Failed to update memories", async () => {
      await setMemoryMode({ threadId, mode });
      close();
    });
  };

  if (!setMemoryMode)
    return <CommandMessage>Memories are not available in this context</CommandMessage>;

  return (
    <CommandPanel>
      <CommandPanelRow
        title="Enabled"
        description="Allow thread memory updates"
        onClick={() => void selectMode("enabled")}
      />
      <CommandPanelRow
        title="Disabled"
        description="Do not update memories from this thread"
        onClick={() => void selectMode("disabled")}
      />
    </CommandPanel>
  );
}

const McpCommandContent: React.ComponentType<
  ComposerSlashCommandContentProps & { threadId: string | null | undefined }
> = () => {
  const { data: response, error, isPending } = useMcpServerStatuses();
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Could not load MCP status"
    : null;

  if (errorMessage) return <CommandMessage>{errorMessage}</CommandMessage>;
  if (isPending || !response) return <CommandMessage>Loading MCP servers</CommandMessage>;

  const statuses = response.data;
  if (statuses.length === 0) return <CommandMessage>No MCP servers</CommandMessage>;

  return (
    <CommandPanel>
      {statuses.map((status) => (
        <CommandPanelRow
          key={status.name}
          title={status.name}
          description={formatMcpAuthStatus(status.authStatus)}
          selected={status.authStatus !== "notLoggedIn"}
        />
      ))}
    </CommandPanel>
  );
};

function formatMcpAuthStatus(status: McpServerStatus["authStatus"]): string {
  if (status === "notLoggedIn") return "Login required";
  if (status === "bearerToken") return "Authenticated";
  if (status === "oAuth") return "OAuth connected";
  return "Available";
}

function FeedbackCommandContent({
  threadId,
  uploadFeedback,
  close,
}: ComposerSlashCommandContentProps & {
  threadId: string | null | undefined;
  uploadFeedback?: (params: FeedbackUploadParams) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);

  if (!uploadFeedback)
    return <CommandMessage>Feedback is not available in this context</CommandMessage>;

  return (
    <div className="space-y-2 p-2">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="What should we know?"
        className="min-h-24 w-full resize-none rounded-lg bg-token-input-background px-3 py-2 text-sm text-token-foreground outline-none ring-[0.5px] ring-token-border/50 placeholder:text-token-description-foreground"
      />
      <label className="flex items-center gap-2 text-sm text-token-description-foreground">
        <input
          type="checkbox"
          checked={includeLogs}
          onChange={(event) => setIncludeLogs(event.target.checked)}
        />
        Include logs
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
            await runCommand("Failed to send feedback", async () => {
              await uploadFeedback(params);
              toast.success("Feedback sent");
              close();
            });
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function PersonalityCommandContent({
  close,
  selectedPersonality,
  onPersonalityChange,
}: ComposerSlashCommandContentProps & {
  selectedPersonality: CodexPersonality;
  onPersonalityChange?: (personality: CodexPersonality) => void | Promise<void>;
}) {
  const selectPersonality = async (personality: CodexPersonality) => {
    if (!onPersonalityChange) return;
    await runCommand("Failed to change personality", async () => {
      await onPersonalityChange(personality);
      close();
    });
  };
  return (
    <CommandPanel>
      <CommandPanelRow
        title="Friendly"
        description="Warm, collaborative, and helpful"
        selected={selectedPersonality === "friendly"}
        onClick={() => void selectPersonality("friendly")}
      />
      <CommandPanelRow
        title="Pragmatic"
        description="Concise, task-focused, and direct"
        selected={selectedPersonality === "pragmatic"}
        onClick={() => void selectPersonality("pragmatic")}
      />
    </CommandPanel>
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
