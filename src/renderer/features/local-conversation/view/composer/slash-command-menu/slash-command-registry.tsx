import { defineMessage, getIntl, type IntlShape } from "@/lib/i18n";
import { isHostedChat } from "@/lib/hosted-chat";
import type { McpServerStatus } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import {
  ClipboardListIcon,
  GitMergeIcon,
  SplitIcon,
} from "@/components/shared/icons/generic-icons";
import {
  ClearContextIcon,
  FastModeIcon,
  FolderIcon,
  GoalTargetIcon,
  ForkIcon,
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
import { AgentInstanceIcon, AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import type { AgentIntelligenceMenu } from "@/components/shared/agent-runtime/use-agent-intelligence-menu";
import { toast } from "@/components/ui/toast";
import { sessionForkDestinations } from "@/lib/session-fork";
import type { ThreadFooterModel, ThreadStageActions } from "../../../thread-stage-types";
import { getThreadGoalMessage, THREAD_GOAL_DEFAULT_MESSAGES } from "../../../thread-goal-copy";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandSection,
  ComposerSlashSubmenuItem,
  ComposerSlashSubmenuSection,
} from "./slash-command-types";
import {
  buildComposerSkillSlashCommands,
  type ComposerSkillSlashCommandsInput,
} from "./slash-command-skills";
import { hasPlanMode, resolveNextComposerPlanMode } from "../composer-plan-mode";
import type { CodexSpeed } from "../../../../../../shared/codex-service-tier";

/** This desktop's MCP servers, read once their submenu opens. */
export interface ComposerSlashMcpStatus {
  readonly statuses: readonly McpServerStatus[] | undefined;
  readonly loading: boolean;
  readonly error: string | null;
}

interface BuildSlashCommandsInput {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  /** The Composer's model, effort and speed choices, shared with its model picker. */
  intelligence: AgentIntelligenceMenu;
  onPetToggle: () => void;
  activateGoalMode: () => void;
  openFeedback: () => void;
  mcp: ComposerSlashMcpStatus;
  /** Skills the draft can mention; absent where messages carry only words. */
  skills?: ComposerSkillSlashCommandsInput;
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

/**
 * Everything `/` offers: the chat's own commands, then skills, then the Agent's own commands.
 * A Nodex command stands for every Agent command it `supersedes`, whether or not it is available
 * right now, so the same capability is never listed twice.
 */
export function buildComposerSlashCommands(
  input: BuildSlashCommandsInput,
  intl = getIntl(),
): ComposerSlashCommand[] {
  const { model, actions, intelligence } = input;
  const threadId = model.conversation?.threadId ?? model.threadId;
  const canUseThread = Boolean(threadId);
  const canUseExistingThread = Boolean(model.conversation);
  const isSideConversation = model.conversation?.source?.sideConversation === true;
  const provider = model.provider;
  const isCodex = !provider || provider.kind === "codex";
  const inspectNativeRuntime =
    !isCodex && provider?.diagnostics && actions.onOpenStatusPanel && threadId
      ? () => actions.onOpenStatusPanel?.(threadId)
      : undefined;
  const { speed, fast, ultracode, effort } = intelligence;
  // Codex offers speed tiers; another Agent may have a Fast switch of its own.
  const speedTier = (value: CodexSpeed) => speed?.tiers.find((tier) => tier.value === value);
  const fastOn = speed ? speed.value === "fast" : fast?.on === true;
  const toggleSpeed = (value: CodexSpeed) =>
    runCommand(
      getIntl().formatMessage({
        id: "conversation.slashCommandRegistry.fastFailed",
        defaultMessage: "Could not change speed",
      }),
      async () => {
        if (speed) await speed.choose(speed.value === value ? null : value);
        else await fast?.set(!fast.on);
      },
    );

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
      icon: <ClipboardListIcon className={iconClassName} />,
      supersedes: ["compact"],
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(actions.onCompactThread),
      isEnabled: !model.isThreadRunning,
      action: {
        kind: "run",
        run: () =>
          runCommand(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.compactFailed",
              defaultMessage: "Failed to compact thread",
            }),
            async () => {
              if (threadId) await actions.onCompactThread?.(threadId);
            },
          ),
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
      icon: <ClearContextIcon className={iconClassName} />,
      supersedes: ["clear", "reset", "new"],
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(actions.onClearContext),
      isEnabled: !model.isThreadRunning,
      action: {
        kind: "run",
        run: () =>
          runCommand(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.clearFailed",
              defaultMessage: "Could not clear the context",
            }),
            async () => {
              await actions.onClearContext?.();
            },
          ),
      },
    },
    {
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
        : (speed ? speedTier("fast")?.description : fast?.description) ||
          intl.formatMessage({
            id: "conversation.slashCommandRegistry.fastUsage",
            defaultMessage: "Faster output, more usage",
          }),
      icon: <FastModeIcon className={iconClassName} />,
      supersedes: ["fast"],
      isVisible: speed ? speedTier("fast") !== undefined : fast !== null,
      action: { kind: "run", run: () => toggleSpeed("fast") },
    },
    {
      id: "ultrafast",
      title: "Ultrafast",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.ultrafast",
        defaultMessage: "Ultrafast",
      }),
      description:
        speed?.value === "ultrafast"
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultrafastOff",
              defaultMessage: "Turn Ultrafast off",
            })
          : speedTier("ultrafast")?.description ||
            intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultrafastUsage",
              defaultMessage: "Even faster, more expensive",
            }),
      icon: <UltrafastModeIcon className={iconClassName} />,
      isVisible: speedTier("ultrafast") !== undefined,
      action: { kind: "run", run: () => toggleSpeed("ultrafast") },
    },
    {
      id: "ultracode",
      title: "Ultracode",
      description:
        ultracode?.unavailableReason ??
        (ultracode?.on
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultracodeOff",
              defaultMessage: "Turn Ultracode off",
            })
          : intl.formatMessage({
              id: "conversation.slashCommandRegistry.ultracodeDescription",
              defaultMessage: "Run a multi-agent workflow for each task",
            })),
      icon: <UltracodeIcon className={iconClassName} />,
      supersedes: ["ultracode"],
      isVisible: ultracode !== null,
      isEnabled: !ultracode?.unavailableReason,
      action: {
        kind: "run",
        run: () =>
          runCommand(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.ultracodeFailed",
              defaultMessage: "Could not change Ultracode",
            }),
            async () => {
              await ultracode?.set(!ultracode.on);
            },
          ),
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
      icon: <SlashFeedbackIcon className={iconClassName} />,
      supersedes: ["feedback", "bug"],
      isVisible: Boolean(actions.onUploadFeedback),
      action: { kind: "run", run: input.openFeedback },
    },
    buildForkCommand(input, intl),
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
      icon: <GitMergeIcon className={iconClassName} />,
      supersedes: ["merge"],
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(actions.onMergeForkBack),
      isEnabled: !model.isThreadRunning,
      action: {
        kind: "run",
        run: () =>
          runCommand(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.mergeFailed",
              defaultMessage: "Could not merge this fork",
            }),
            async () => {
              await actions.onMergeForkBack?.();
            },
          ),
      },
    },
    {
      id: "goal",
      title: THREAD_GOAL_DEFAULT_MESSAGES["composer.goalSlashCommand.title"].defaultMessage,
      titleMessage: THREAD_GOAL_DEFAULT_MESSAGES["composer.goalSlashCommand.title"],
      description: getThreadGoalMessage("composer.goalSlashCommand.setDescription", intl),
      icon: <GoalTargetIcon className={iconClassName} />,
      supersedes: ["goal"],
      requiresEmptyComposer: false,
      isVisible: canUseComposerGoal(model, actions),
      action: { kind: "run", run: input.activateGoalMode },
    },
    {
      id: "mcp",
      title: "MCP",
      description: intl.formatMessage({
        id: "conversation.slashCommandRegistry.mcpDescription",
        defaultMessage: "Show MCP server status",
      }),
      icon: <SlashMcpIcon className={iconClassName} />,
      supersedes: ["mcp"],
      // This desktop's MCP servers are not a hosted chat's; its host runs its own tools.
      isVisible: (isCodex && !isHostedChat()) || Boolean(inspectNativeRuntime),
      action: inspectNativeRuntime
        ? { kind: "run", run: inspectNativeRuntime }
        : { kind: "submenu", submenu: { sections: [buildMcpSection(input.mcp, intl)] } },
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
        defaultMessage: "Choose whether this chat updates your memories",
      }),
      icon: <SlashMemoriesIcon className={iconClassName} />,
      supersedes: ["memory", "memories"],
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && Boolean(actions.onSetThreadMemoryMode),
      action: { kind: "submenu", submenu: buildMemoriesSubmenu(threadId, actions, intl) },
    },
    {
      id: "model",
      title: "Model",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.model",
        defaultMessage: "Model",
      }),
      description: intelligence.modelLabel,
      icon: <SlashModelIcon className={iconClassName} />,
      supersedes: ["model"],
      isVisible:
        intelligence.models.choices.length > 0 ||
        intelligence.models.loading ||
        intelligence.models.error !== null,
      action: { kind: "submenu", submenu: buildModelSubmenu(intelligence, intl) },
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
      icon: <SlashPetIcon className={iconClassName} />,
      supersedes: ["pet"],
      requiresEmptyComposer: true,
      action: { kind: "run", run: input.onPetToggle },
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
      icon: <SlashSideIcon className={iconClassName} />,
      supersedes: ["side"],
      requiresEmptyComposer: true,
      isVisible: canUseExistingThread && !isSideConversation && Boolean(actions.onOpenSideChat),
      action: {
        kind: "run",
        run: () =>
          runCommand(
            getIntl().formatMessage({
              id: "conversation.slashCommandRegistry.sideFailed",
              defaultMessage: "Failed to open side chat",
            }),
            async () => {
              await actions.onOpenSideChat?.();
            },
          ),
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
      icon: <SplitIcon className={iconClassName} />,
      supersedes: ["project"],
      isVisible: Boolean(
        model.isNewThreadTab &&
        model.newThreadProjectSelector &&
        !model.newThreadProjectSelector.disabled,
      ),
      action: { kind: "submenu", submenu: buildProjectSubmenu(model, actions) },
    },
    {
      id: "reasoning",
      title: "Reasoning",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.reasoning",
        defaultMessage: "Reasoning",
      }),
      description: effort?.label || effort?.choices.find((choice) => choice.current)?.label,
      icon: <SlashReasoningIcon className={iconClassName} />,
      searchAliases: ["effort", "thinking"],
      supersedes: ["effort", "reasoning", "thinking"],
      isVisible: effort !== null,
      action: {
        kind: "submenu",
        submenu: {
          sections: [
            {
              id: "efforts",
              items: (effort?.choices ?? []).map((choice) => ({
                id: choice.value,
                title: choice.label,
                // Levels read as one scale; what each means is there on hover.
                tooltip: choice.description,
                current: choice.current,
                run: () =>
                  runCommand(
                    getIntl().formatMessage({
                      id: "conversation.slashCommandRegistry.reasoningFailed",
                      defaultMessage: "Could not change reasoning",
                    }),
                    () => effort?.choose(choice.value) ?? Promise.resolve(),
                  ),
              })),
            },
          ],
        },
      },
    },
    {
      id: "plan-mode",
      title: "Plan mode",
      titleMessage: defineMessage({
        id: "conversation.slashCommandRegistry.planMode",
        defaultMessage: "Plan mode",
      }),
      description:
        model.selectedCollaborationMode === "plan"
          ? intl.formatMessage({
              id: "conversation.slashCommandRegistry.planModeOff",
              defaultMessage: "Switch off plan mode",
            })
          : intl.formatMessage({
              id: "conversation.slashCommandRegistry.planModeOn",
              defaultMessage: "Switch to plan mode",
            }),
      icon: <ComposerPlanModeIcon className={iconClassName} />,
      supersedes: ["plan"],
      requiresEmptyComposer: true,
      isVisible: hasPlanMode(model.collaborationModes),
      action: {
        kind: "run",
        run: () => {
          const nextMode = resolveNextComposerPlanMode({
            currentMode: model.selectedCollaborationMode,
            modes: model.collaborationModes,
          });
          if (nextMode) void actions.onCollaborationModeChange(nextMode);
        },
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
      icon: <SlashStatusIcon className={iconClassName} />,
      supersedes: ["status", "context", "usage", "cost", "stats"],
      requiresEmptyComposer: true,
      isVisible: canUseThread,
      action: {
        kind: "run",
        run: () => {
          if (!threadId) return;
          if (actions.onOpenStatusPanel) {
            actions.onOpenStatusPanel(threadId);
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
            { description: model.conversation?.statusType ?? "idle" },
          );
        },
      },
    },
  ];

  const skillCommands = input.skills ? buildComposerSkillSlashCommands(input.skills, intl) : [];
  if (!provider) return [...commands, ...skillCommands];
  return [
    ...commands,
    ...skillCommands,
    ...buildAgentCommands({
      provider,
      superseded: new Set(
        [
          ...commands.flatMap((command) => [command.id, ...(command.supersedes ?? [])]),
          ...(input.skills?.inventory ?? [])
            .filter((skill) => skill.userInvocable !== false)
            .map((skill) => skill.name),
        ].map((name) => name.toLowerCase()),
      ),
    }),
  ];
}

/**
 * The Agent's own commands that Nodex does not offer itself, under the Agent's name. Choosing one
 * writes `/name ` into the draft to finish and send.
 */
function buildAgentCommands(input: {
  provider: NonNullable<ThreadFooterModel["provider"]>;
  superseded: ReadonlySet<string>;
}): ComposerSlashCommand[] {
  const { provider, superseded } = input;
  const section: ComposerSlashCommandSection = { kind: "agent", label: provider.label };
  return provider.commands
    .filter(
      (command) =>
        !superseded.has(command.name.toLowerCase()) &&
        !command.aliases.some((alias) => superseded.has(alias.toLowerCase())),
    )
    .map((command): ComposerSlashCommand => ({
      id: `agent:${command.name}`,
      title: command.name,
      description: command.description,
      section,
      searchAliases: command.aliases,
      icon: <AgentProviderIcon kind={provider.kind} className="icon-xs shrink-0" />,
      ...(command.inputHint
        ? {
            trailing: (
              <span className="max-w-40 truncate text-token-description-foreground">
                {command.inputHint}
              </span>
            ),
          }
        : {}),
      action: { kind: "insert", insert: (draft) => draft.insertText(`/${command.name} `) },
    }));
}

/** Models as the model picker lists them; models turned off in Settings answer a search. */
function buildModelSubmenu(
  intelligence: AgentIntelligenceMenu,
  intl: IntlShape,
): { sections: ComposerSlashSubmenuSection[] } {
  const { models } = intelligence;
  const toItem = (choice: AgentIntelligenceMenu["models"]["choices"][number]) =>
    ({
      id: choice.key,
      title: choice.label,
      description: choice.detail,
      tooltip: choice.tooltip,
      searchAliases: [choice.searchText],
      icon: <AgentInstanceIcon binding={choice.binding} className="icon-xs shrink-0" />,
      current: choice.current,
      disabled: choice.disabled,
      run: () =>
        runCommand(
          getIntl().formatMessage({
            id: "conversation.slashCommandRegistry.modelFailed",
            defaultMessage: "Could not change the model",
          }),
          () => models.choose(choice),
        ),
    }) satisfies ComposerSlashSubmenuItem;
  return {
    sections: [
      {
        id: "models",
        items: models.choices.filter((choice) => !choice.off).map(toItem),
        loading: models.loading,
        emptyState: models.error
          ? models.error
          : models.loading
            ? intl.formatMessage({
                id: "conversation.slashCommandRegistry.loadingModels",
                defaultMessage: "Loading models…",
              })
            : intl.formatMessage({
                id: "conversation.slashCommandRegistry.noModels",
                defaultMessage: "No models available",
              }),
      },
      {
        // Each of these rows says it is off, as in the model picker.
        id: "off",
        items: models.choices.filter((choice) => choice.off).map(toItem),
        showOnlyWhenSearching: true,
      },
    ],
  };
}

/** Fork offers where the new chat will run; with one place, choosing Fork forks at once. */
function buildForkCommand(input: BuildSlashCommandsInput, intl: IntlShape): ComposerSlashCommand {
  const { model, actions } = input;
  const threadId = model.conversation?.threadId ?? model.threadId;
  const latestTurnId = model.body.latestTurnId;
  const destinations = actions.onForkThread
    ? (model.forkDestinations ??
      sessionForkDestinations({ isWorktree: false, canCreateWorktree: false }))
    : [];
  const fork = (target: "local" | "newWorktree") =>
    runCommand(
      getIntl().formatMessage({
        id: "conversation.slashCommandRegistry.forkFailed",
        defaultMessage: "Failed to fork thread",
      }),
      async () => {
        if (!threadId) return;
        if (actions.onForkThread) await actions.onForkThread(target);
        else if (latestTurnId)
          await actions.onForkFromTurn({ threadId, turnId: latestTurnId, message: "" });
      },
    );
  return {
    id: "fork",
    title: "Fork",
    titleMessage: defineMessage({
      id: "conversation.slashCommandRegistry.fork",
      defaultMessage: "Fork",
      description: "Action to fork a chat",
    }),
    description: intl.formatMessage({
      id: "conversation.slashCommandRegistry.forkDescription",
      defaultMessage: "Continue this chat in a new one",
    }),
    icon: <ForkIcon className={iconClassName} />,
    supersedes: ["fork", "branch"],
    requiresEmptyComposer: true,
    isVisible: Boolean(model.conversation) && model.conversation?.source?.sideConversation !== true,
    isEnabled: Boolean(threadId && (actions.onForkThread || latestTurnId)),
    action:
      destinations.length > 1
        ? {
            kind: "submenu",
            submenu: {
              sections: [
                {
                  id: "destinations",
                  items: destinations.map((destination) => ({
                    id: destination.target,
                    title: destination.label,
                    icon: (
                      <NativeMenuIcon iconKey={destination.iconKey} className={iconClassName} />
                    ),
                    run: () => fork(destination.target),
                  })),
                },
              ],
            },
          }
        : { kind: "run", run: () => fork("local") },
  };
}

function buildProjectSubmenu(
  model: ThreadFooterModel,
  actions: ThreadStageActions,
): { sections: ComposerSlashSubmenuSection[] } {
  const selector = model.newThreadProjectSelector;
  return {
    sections: [
      {
        id: "projects",
        items: (selector?.projects ?? []).map((project) => ({
          id: project.id,
          title: project.label,
          description: project.description,
          icon: <FolderIcon className={iconClassName} />,
          current: project.id === selector?.selectedProjectId,
          run: () => actions.onNewThreadProjectChange?.(project.id),
        })),
      },
    ],
  };
}

/** The chat's memory setting is written, not read back, so each row says what it does. */
function buildMemoriesSubmenu(
  threadId: string | null | undefined,
  actions: ThreadStageActions,
  intl: IntlShape,
): { sections: ComposerSlashSubmenuSection[] } {
  const setMode = (mode: ThreadMemoryMode, confirmation: string) =>
    runCommand(
      getIntl().formatMessage({
        id: "conversation.slashCommandRegistry.updateMemoriesFailed",
        defaultMessage: "Failed to update memories",
      }),
      async () => {
        if (!threadId || !actions.onSetThreadMemoryMode) return;
        await actions.onSetThreadMemoryMode({ threadId, mode });
        toast.success(confirmation);
      },
    );
  return {
    sections: [
      {
        id: "memory-modes",
        items: [
          {
            id: "enabled",
            title: intl.formatMessage({
              id: "conversation.slashCommandRegistry.memoriesEnable",
              defaultMessage: "Update memories from this chat",
            }),
            run: () =>
              setMode(
                "enabled",
                getIntl().formatMessage({
                  id: "conversation.slashCommandRegistry.memoriesEnabled",
                  defaultMessage: "This chat will update your memories",
                }),
              ),
          },
          {
            id: "disabled",
            title: intl.formatMessage({
              id: "conversation.slashCommandRegistry.memoriesDisable",
              defaultMessage: "Keep this chat out of memories",
            }),
            run: () =>
              setMode(
                "disabled",
                getIntl().formatMessage({
                  id: "conversation.slashCommandRegistry.memoriesDisabled",
                  defaultMessage: "This chat won’t update your memories",
                }),
              ),
          },
        ],
      },
    ],
  };
}

/** Each server with its authentication; the rows report state and run nothing. */
function buildMcpSection(
  mcp: ComposerSlashMcpStatus,
  intl: IntlShape,
): ComposerSlashSubmenuSection {
  const statuses = [...(mcp.statuses ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return {
    id: "servers",
    loading: mcp.loading,
    emptyState:
      mcp.error ??
      (mcp.loading
        ? intl.formatMessage({
            id: "conversation.slashCommandRegistry.loadingMcp",
            defaultMessage: "Loading MCP servers",
          })
        : intl.formatMessage({
            id: "conversation.slashCommandRegistry.noMcpServers",
            defaultMessage: "No MCP servers",
          })),
    items: statuses.map((status) => ({
      id: status.name,
      title: status.name,
      description: formatMcpAuthStatus(intl, status.authStatus),
    })),
  };
}

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

async function runCommand(errorMessage: string, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : errorMessage);
  }
}
