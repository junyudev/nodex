import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useLayoutEffect } from "react";
import { fireEvent, getByRole, waitFor } from "@testing-library/dom";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY } from "@/lib/codex-service-tier-settings";
import { writeAtom } from "@/lib/persisted-atom-store";
import { useSetScopedAtom } from "@/lib/maitai";
import { NodexModalHost } from "@/lib/modal-registry";
import type {
  CodexCollaborationModeKind,
  CodexModelOption,
  CodexPermissionMode,
  CodexReasoningEffortOption,
} from "@/lib/types";
import type {
  NewChatProjectSelectorModel,
  ThreadFooterModel,
  ThreadStageActions,
} from "../../thread-stage-types";
import {
  buildThreadStageStorySurfaceModels,
  buildThreadStageStoryScenario,
  type ThreadStageStoryControls,
} from "../thread-stage-story-fixtures";
import { ThreadComposer } from "./local-conversation-thread-composer";
import {
  composerAppshotContextsAtom,
  composerFileAttachmentsAtom,
  composerImageAttachmentsAtom,
  composerPastedTextAttachmentsAtom,
} from "./composer-draft-state";
import { PROMPT_HISTORY_ATOM_KEY } from "./thread-composer-prompt-history";
import { TestComposerScopePath } from "@/test/maitai-scope-harness";

interface ComposerSendButtonStoryProps {
  isQueueingEnabled: boolean;
  composerEnterBehavior: "enter" | "cmdIfMultiline";
  draftPrompt: string;
  initialServiceTier: "standard" | "fast";
  permissionMode: CodexPermissionMode;
  selectedModel: string;
  selectedModelDisplayName: string;
  modelCatalog: "default" | "expanded" | "rich" | "loading";
  selectedModelReasoningSupport: "default" | "highOnly";
  selectedCollaborationMode: CodexCollaborationModeKind;
  threadState: "existingThread" | "interruptedThread" | "newChat";
  surfaceWidth: "normal" | "narrow";
  addContextState: "default" | "plugins";
  savedGoalState: "none" | "active";
  seedPromptHistory: boolean;
  seedCompletedContext: boolean;
  seedAppshot: boolean;
  seedImageAttachment: boolean;
  pastedTextState: "none" | "pending" | "ready" | "failed";
}

const LONG_PROMPT_STORY_DRAFT = Array.from(
  { length: 32 },
  (_, index) =>
    `Refine the composer scroll behavior pass ${index + 1}: keep the native textarea as the only vertical scroll surface while preserving the footer controls.`,
).join("\n");

const STORY_ACTIVE_THREAD_GOAL: ThreadGoal = {
  threadId: "thread_storybook",
  objective: "Keep migrating the composer goal workflow until it matches the reference behavior.",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 45,
  createdAt: 1,
  updatedAt: 1,
};

function resolveStoryReasoningOptions(
  args: ComposerSendButtonStoryProps,
  fallback: CodexReasoningEffortOption[],
) {
  if (args.selectedModelReasoningSupport === "highOnly") {
    return [
      {
        reasoningEffort: "high" as const,
        description: "Spend more time reasoning before answering.",
      },
    ];
  }

  return fallback;
}

function resolveStoryAvailableModels(input: {
  args: ComposerSendButtonStoryProps;
  footerModel: ThreadFooterModel;
  selectedModelOption: CodexModelOption;
}): CodexModelOption[] {
  if (input.args.modelCatalog === "loading") {
    return [];
  }

  if (input.args.modelCatalog === "rich") {
    const efforts = ["low", "medium", "high", "xhigh", "ultra"] as const;
    return [
      {
        id: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        description: "Fast, efficient reasoning for everyday work.",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "low",
        inputModalities: ["text", "image"],
        multiAgentVersion: "v2",
        serviceTiers: [],
        defaultServiceTier: null,
        supportedReasoningEfforts: efforts.slice(0, 4).map((reasoningEffort) => ({
          reasoningEffort,
          description: "",
        })),
      },
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier reasoning for demanding work.",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        inputModalities: ["text", "image"],
        multiAgentVersion: "v2",
        serviceTiers: [],
        defaultServiceTier: null,
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
          reasoningEffort,
          description: "",
        })),
      },
    ];
  }

  const baseModels = [
    input.selectedModelOption,
    ...input.footerModel.availableModels.filter((model) => model.id !== input.args.selectedModel),
  ];

  if (input.args.modelCatalog !== "expanded") {
    return baseModels;
  }

  const expandedModels: CodexModelOption[] = [
    {
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "Previous stable Codex model.",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      supportedReasoningEfforts: input.footerModel.reasoningEffortOptions,
    },
    {
      id: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4-Mini",
      description: "Small fast Codex model.",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      supportedReasoningEfforts: input.footerModel.reasoningEffortOptions,
    },
    {
      id: "gpt-5.3-codex-spark",
      model: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      description: "Ultra-fast Codex model.",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      supportedReasoningEfforts: input.footerModel.reasoningEffortOptions,
    },
  ];
  const selectedAndExpandedModelIds = new Set([
    input.selectedModelOption.id,
    ...expandedModels.map((model) => model.id),
  ]);

  return [
    input.selectedModelOption,
    ...expandedModels.filter((model) => model.id !== input.selectedModelOption.id),
    ...input.footerModel.availableModels.filter(
      (model) => !selectedAndExpandedModelIds.has(model.id),
    ),
  ];
}

function buildModel(args: ComposerSendButtonStoryProps): ThreadFooterModel {
  const controls: ThreadStageStoryControls = {
    preset: args.threadState === "newChat" ? "new-thread" : "streaming",
    permissionMode: args.permissionMode,
    authenticatedAccount: true,
    isQueueingEnabled: args.isQueueingEnabled,
    collapseAgentBody: false,
  };
  const scenario = buildThreadStageStoryScenario(controls);
  const newChatTarget = scenario.runtime.newThreadTarget
    ? {
        ...scenario.runtime.newThreadTarget,
        sessionId: "session_story",
        runInTarget: "localProject" as const,
      }
    : null;
  const runtime = {
    ...scenario.runtime,
    ...(args.threadState === "newChat"
      ? {
          newThreadTarget: newChatTarget,
        }
      : {}),
    composerIntent:
      args.draftPrompt.trim().length === 0
        ? null
        : {
            prompt: args.draftPrompt,
            focusNonce: 1,
          },
  };
  const footerModel = buildThreadStageStorySurfaceModels(scenario, controls, runtime).footerModel;
  const interruptedConversation =
    args.threadState === "interruptedThread" && footerModel.conversation
      ? {
          ...footerModel.conversation,
          statusType: "idle" as const,
          statusActiveFlags: [],
          threadRuntimeStatus: { type: "idle" as const },
          turns: footerModel.conversation.turns.map((turn, index, turns) =>
            index === turns.length - 1 ? { ...turn, status: "interrupted" as const } : turn,
          ),
        }
      : footerModel.conversation;
  const conversation =
    args.savedGoalState === "active" && interruptedConversation
      ? {
          ...interruptedConversation,
          threadGoal: STORY_ACTIVE_THREAD_GOAL,
        }
      : interruptedConversation;
  const selectedModelReasoningOptions = resolveStoryReasoningOptions(
    args,
    footerModel.reasoningEffortOptions,
  );
  const selectedModelOption: CodexModelOption = {
    id: args.selectedModel,
    model: args.selectedModel,
    displayName: args.selectedModelDisplayName,
    description: "Story-selected Codex model.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort:
      selectedModelReasoningOptions[0]?.reasoningEffort ?? footerModel.selectedReasoningEffort,
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    supportedReasoningEfforts: selectedModelReasoningOptions,
  };

  return {
    ...footerModel,
    conversation,
    ...(args.threadState === "interruptedThread"
      ? { activeTurn: null, isThreadRunning: false }
      : {}),
    availableModels: resolveStoryAvailableModels({ args, footerModel, selectedModelOption }),
    selectedModel: args.selectedModel,
    selectedReasoningEffort: selectedModelReasoningOptions.some(
      (option) => option.reasoningEffort === footerModel.selectedReasoningEffort,
    )
      ? footerModel.selectedReasoningEffort
      : (selectedModelReasoningOptions[0]?.reasoningEffort ?? footerModel.selectedReasoningEffort),
    reasoningEffortOptions: selectedModelReasoningOptions,
    selectedCollaborationMode: args.selectedCollaborationMode,
    ...(args.threadState === "newChat" && newChatTarget
      ? {
          newThreadTarget: newChatTarget,
          newThreadProjectSelector: {
            selectedProjectId: newChatTarget.projectId,
            disabled: false,
            canAddProject: true,
            projects: [
              ...(newChatTarget.projectId === null
                ? []
                : [
                    {
                      id: newChatTarget.projectId,
                      label: newChatTarget.projectName,
                      appearance: {
                        color: "green",
                        marker: { kind: "icon", icon: "plant" },
                      } as const,
                      description: footerModel.projectWorkspacePath ?? "/Users/asc/repo/nodex",
                      primaryWorkspaceRoot:
                        footerModel.projectWorkspacePath ?? "/Users/asc/repo/nodex",
                      searchText: `${newChatTarget.projectId} ${newChatTarget.projectName}`,
                    },
                  ]),
              {
                id: "project_devtools_codex",
                label: "Devtools Codex",
                appearance: {
                  color: "blue",
                  marker: { kind: "icon", icon: "function" },
                } as const,
                description: "/Users/asc/repo/devtools-codex",
                primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
                searchText: "project_devtools_codex devtools codex",
              },
            ] satisfies NewChatProjectSelectorModel["projects"],
          },
          newThreadStartInSelector: {
            target: {
              runInTarget: "localProject" as const,
            },
            disabled: false,
            worktreeAvailable: true,
            environments: [],
            environmentsLoading: false,
            environmentsError: false,
            selectedEnvironmentPath: null,
            defaultEnvironmentPath: null,
            environmentNeedsAttention: false,
            environmentRepairConfigPath: null,
          },
        }
      : {}),
    ...(args.addContextState === "plugins"
      ? {
          composerPlugins: [
            {
              id: "browser@openai-bundled",
              name: "Browser",
              displayName: "Browser",
              description: "Control the in-app browser with ChatGPT",
              defaultPrompt: null,
              installed: true,
              enabled: true,
              path: "plugin://browser@openai-bundled",
              iconUrl: null,
              iconUrlDark: null,
              brandColor: "#4b8df8",
            },
            {
              id: "computer-use@openai-bundled",
              name: "Computer",
              displayName: "Computer",
              description: "Control Mac apps from ChatGPT",
              defaultPrompt: null,
              installed: true,
              enabled: true,
              path: "plugin://computer-use@openai-bundled",
              iconUrl: null,
              iconUrlDark: null,
              brandColor: null,
            },
            {
              id: "record-and-replay@openai-bundled",
              name: "record-and-replay",
              displayName: "Record and Replay",
              description: "Turn a workflow into a reusable skill",
              defaultPrompt: "Record this workflow as a reusable skill.",
              installed: false,
              enabled: false,
              path: "plugin://record-and-replay@openai-bundled",
              iconUrl: null,
              iconUrlDark: null,
              brandColor: null,
            },
          ],
          composerApps: [
            {
              id: "plugin-management",
              name: "Plugin Management",
              description: "Manage plugins, permissions, and connections",
              logoUrl: null,
              logoUrlDark: null,
              iconAssets: null,
              iconDarkAssets: null,
              distributionChannel: null,
              branding: null,
              appMetadata: null,
              labels: null,
              installUrl: null,
              isAccessible: true,
              isEnabled: true,
              pluginDisplayNames: [],
            },
          ],
          composerSkills: [
            {
              name: "plugin-creator",
              displayName: "Plugin Creator",
              description: "Create and scaffold Codex plugins",
              iconUrl: null,
              brandColor: null,
              path: "/skills/plugin-creator/SKILL.md",
              scope: "system",
            },
            {
              name: "pdf",
              displayName: "PDF",
              description: "Read, create, and verify PDF files",
              iconUrl: null,
              brandColor: null,
              path: "/skills/pdf/SKILL.md",
              scope: "user",
            },
          ],
          composerSitesAvailable: true,
          composerSites: [
            {
              id: "appgprj_pals",
              title: "Pals Board",
              slug: "pals-board",
              currentLiveUrl: "https://pals-board.chatgpt.site",
              path: "sites-project://appgprj_pals",
            },
            {
              id: "appgprj_feels",
              title: "Feels right",
              slug: "feels-right",
              currentLiveUrl: "https://feels-right.chatgpt.site",
              path: "sites-project://appgprj_feels",
            },
          ],
          composerChatGptConversationsAvailable: true,
          composerChatGptConversations: [
            {
              conversationId: "conversation-hangzhou",
              title: "Hangzhou Weekend Picks",
              path: "chatgpt-conversation://conversation-hangzhou",
            },
            {
              conversationId: "conversation-research",
              title: "Browser parity research",
              path: "chatgpt-conversation://conversation-research",
            },
          ],
        }
      : {}),
    composerEnterBehavior: args.composerEnterBehavior,
  };
}

function buildActions(): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
    onPersonalityChange: () => {},
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onResumeInterruptedTurn: async () => {},
    onRespondApproval: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditLastUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
    onNewThreadProjectChange: () => {},
    onRequestNewChatProjectCreate: () => {},
    onStartThreadForSession: async () => {},
    onNewThreadStartInTargetChange: () => {},
    onNewThreadStartInEnvironmentChange: () => {},
    onRefreshNewThreadStartInEnvironments: async () => {},
    onOpenNewThreadLocalEnvironmentsSettings: () => {},
    onGetThreadGoal: async () => null,
    onSetThreadGoal: async () => null,
    onClearThreadGoal: async () => {},
  };
}

function ComposerCompletedContextSeeder({
  enabled,
  seedAppshot,
  seedImageAttachment,
  pastedTextState,
}: {
  enabled: boolean;
  seedAppshot: boolean;
  seedImageAttachment: boolean;
  pastedTextState: ComposerSendButtonStoryProps["pastedTextState"];
}) {
  const setAppshotContexts = useSetScopedAtom(composerAppshotContextsAtom);
  const setFileAttachments = useSetScopedAtom(composerFileAttachmentsAtom);
  const setImageAttachments = useSetScopedAtom(composerImageAttachmentsAtom);
  const setPastedTextAttachments = useSetScopedAtom(composerPastedTextAttachmentsAtom);

  useLayoutEffect(() => {
    if (!enabled && !seedAppshot && !seedImageAttachment && pastedTextState === "none") {
      setAppshotContexts([]);
      setFileAttachments([]);
      setImageAttachments([]);
      setPastedTextAttachments([]);
      return;
    }

    setFileAttachments(
      enabled
        ? [
            {
              uiId: "story-file-view-state-ownership",
              attachment: {
                label: "renderer-view-state-ownership.md",
                path: "docs/renderer-view-state-ownership.md",
                fsPath: "/workspace/nodex/docs/renderer-view-state-ownership.md",
              },
            },
          ]
        : [],
    );
    setAppshotContexts(
      seedAppshot
        ? [
            {
              id: "story-appshot-safari",
              appName: "Safari",
              bundleIdentifier: "com.apple.Safari",
              windowTitle: "Nodex implementation plan",
              axTree: "AXWindow title=Nodex implementation plan",
              imageName: "Safari Appshot.png",
              imageDataUrl:
                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='720' height='480'%3E%3Crect width='720' height='480' fill='%23e8edf3'/%3E%3Crect x='24' y='24' width='672' height='48' rx='12' fill='%23ffffff'/%3E%3Crect x='24' y='96' width='672' height='360' rx='12' fill='%23ffffff'/%3E%3Cpath d='M72 150h440M72 196h520M72 242h360' stroke='%239aa6b2' stroke-width='16' stroke-linecap='round'/%3E%3C/svg%3E",
              appIconDataUrl: null,
            },
          ]
        : [],
    );
    setImageAttachments(
      seedImageAttachment
        ? [
            {
              id: "story-composer-image",
              filename: "painted-mountain.png",
              mimeType: "image/png",
              src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='320'%3E%3Cdefs%3E%3ClinearGradient id='g' x2='1' y2='1'%3E%3Cstop stop-color='%23ffb37b'/%3E%3Cstop offset='1' stop-color='%23ca4b5f'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='320' height='320' fill='url(%23g)'/%3E%3Ccircle cx='220' cy='95' r='52' fill='%23ffe5ba' fill-opacity='.9'/%3E%3Cpath d='M0 270L85 165l58 67 48-46 129 134H0z' fill='%23532855' fill-opacity='.72'/%3E%3C/svg%3E",
              origin: "restored",
              materialization: null,
              materializationStatus: "failed",
              uploadStatus: "idle",
              generation: 1,
            },
          ]
        : [],
    );

    const resolvedPastedTextState =
      pastedTextState === "none" && enabled ? "ready" : pastedTextState;
    const pastedTextBase = {
      id: "story-pasted-acceptance-notes",
      preview: "Verify one header, restored draft context…",
      characterCount: 5_000,
    };
    if (resolvedPastedTextState === "pending") {
      setPastedTextAttachments([{ ...pastedTextBase, status: "pending", generation: 1 }]);
    } else if (resolvedPastedTextState === "failed") {
      setPastedTextAttachments([
        {
          ...pastedTextBase,
          status: "failed",
          generation: 1,
          error: "Could not save pasted text. Try again.",
        },
      ]);
    } else if (resolvedPastedTextState === "ready") {
      setPastedTextAttachments([
        {
          ...pastedTextBase,
          status: "ready",
          attachment: {
            file: {
              label: "Pasted text.txt",
              path: "/workspace/.nodex/pasted-text.txt",
              fsPath: "/workspace/.nodex/pasted-text.txt",
            },
            preview: pastedTextBase.preview,
            characterCount: pastedTextBase.characterCount,
          },
        },
      ]);
    } else {
      setPastedTextAttachments([]);
    }

    return () => {
      setAppshotContexts([]);
      setFileAttachments([]);
      setImageAttachments([]);
      setPastedTextAttachments([]);
    };
  }, [
    enabled,
    pastedTextState,
    seedAppshot,
    seedImageAttachment,
    setAppshotContexts,
    setFileAttachments,
    setImageAttachments,
    setPastedTextAttachments,
  ]);

  return null;
}

function ComposerSendButtonStory(args: ComposerSendButtonStoryProps) {
  useEffect(() => {
    void writeAtom(
      PROMPT_HISTORY_ATOM_KEY,
      args.seedPromptHistory
        ? {
            thread_storybook: [
              "Re-run the composer prompt history parity checklist.",
              "Apply the latest queued follow-up before restoring history.",
            ],
          }
        : [],
    );
  }, [args.seedPromptHistory]);

  if (typeof localStorage !== "undefined") {
    if (args.initialServiceTier === "fast") {
      localStorage.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "fast");
    } else {
      localStorage.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
    }
  }

  const surfaceWidthClassName = args.surfaceWidth === "narrow" ? "max-w-[390px]" : "max-w-3xl";

  return (
    <div className="min-h-[320px] rounded-[24px] border border-(--border) bg-(--background) p-5 shadow-[0_18px_48px_rgba(0,0,0,0.16)]">
      <div className="mb-4 max-w-2xl">
        <div className="text-sm font-semibold text-(--foreground)">Thread Composer</div>
        <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
          Focused composer footer states for inspecting running-thread actions, Plan mode,
          permissions, and compact footer wrapping.
        </div>
      </div>
      <TooltipProvider>
        <div className={surfaceWidthClassName}>
          <TestComposerScopePath>
            <ComposerCompletedContextSeeder
              enabled={args.seedCompletedContext}
              seedAppshot={args.seedAppshot}
              seedImageAttachment={args.seedImageAttachment}
              pastedTextState={args.pastedTextState}
            />
            <ThreadComposer
              model={buildModel(args)}
              actions={buildActions()}
              errorMessage={null}
              onErrorMessage={() => {}}
            />
            <NodexModalHost />
          </TestComposerScopePath>
        </div>
      </TooltipProvider>
    </div>
  );
}

const meta = {
  title: "Workbench/Threads/Composer Footer",
  component: ComposerSendButtonStory,
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    initialServiceTier: "standard",
    permissionMode: "auto",
    selectedModel: "gpt-5.5",
    selectedModelDisplayName: "GPT-5.5",
    modelCatalog: "default",
    selectedModelReasoningSupport: "default",
    selectedCollaborationMode: "default",
    threadState: "existingThread",
    surfaceWidth: "normal",
    addContextState: "default",
    savedGoalState: "none",
    seedPromptHistory: false,
    seedCompletedContext: false,
    seedAppshot: false,
    seedImageAttachment: false,
    pastedTextState: "none",
  },
  argTypes: {
    isQueueingEnabled: {
      control: "boolean",
    },
    composerEnterBehavior: {
      control: "radio",
      options: ["enter", "cmdIfMultiline"],
    },
    draftPrompt: {
      control: "text",
    },
    initialServiceTier: {
      control: "radio",
      options: ["standard", "fast"],
    },
    permissionMode: {
      control: "radio",
      options: ["auto", "full-access", "custom"],
    },
    selectedModel: {
      control: "text",
    },
    selectedModelDisplayName: {
      control: "text",
    },
    modelCatalog: {
      control: "radio",
      options: ["default", "expanded", "rich", "loading"],
    },
    selectedModelReasoningSupport: {
      control: "radio",
      options: ["default", "highOnly"],
    },
    selectedCollaborationMode: {
      control: "radio",
      options: ["default", "plan"],
    },
    threadState: {
      control: "radio",
      options: ["existingThread", "interruptedThread", "newChat"],
    },
    surfaceWidth: {
      control: "radio",
      options: ["normal", "narrow"],
    },
    addContextState: {
      control: "radio",
      options: ["default", "plugins"],
    },
    savedGoalState: {
      control: "radio",
      options: ["none", "active"],
    },
    seedPromptHistory: {
      control: "boolean",
    },
    seedCompletedContext: {
      control: "boolean",
    },
    seedAppshot: {
      control: "boolean",
    },
    seedImageAttachment: {
      control: "boolean",
    },
    pastedTextState: {
      control: "inline-radio",
      options: ["none", "pending", "ready", "failed"],
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          "Focused Codex-style parity story for the thread composer footer. Variants cover running-thread submit modes, active Plan mode, compact footer wrapping, and platform keycap tooltip rows.",
      },
    },
  },
} satisfies Meta<typeof ComposerSendButtonStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RunningStop: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
  },
};

export const InterruptedResume: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    threadState: "interruptedThread",
  },
};

export const NewChatEmptyNarrow: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    threadState: "newChat",
    surfaceWidth: "narrow",
  },
};

export const IntelligenceAnchorStability: Story = {
  args: {
    threadState: "newChat",
    modelCatalog: "expanded",
    selectedModel: "gpt-5.5",
    selectedModelDisplayName: "GPT-5.5",
  },
  play: async ({ canvasElement }) => {
    const trigger = getByRole(canvasElement, "button", { name: "Select model" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => getByRole(document.body, "menuitem", { name: /Model/ }));
  },
  parameters: {
    docs: {
      description: {
        story:
          "Open the Codex Intelligence selector. The trigger expands to its stable candidate width so model, reasoning, or speed changes cannot move the open menu anchor.",
      },
    },
  },
};

export const PlanModeFooterAccessory: Story = {
  args: {
    selectedCollaborationMode: "plan",
    permissionMode: "full-access",
    draftPrompt: "Draft a migration plan for the composer footer parity work.",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Active Plan mode footer accessory parity: Add context, permission selector, divider, then the Plan toggle chip.",
      },
    },
  },
};

export const RunningSteer: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "Steer the current run toward the MCP transcript cleanup.",
  },
};

export const RunningQueue: Story = {
  args: {
    isQueueingEnabled: true,
    composerEnterBehavior: "enter",
    draftPrompt: "Queue this after the current tool-call batch finishes.",
  },
};

export const RunningQueueMultilineCmdEnter: Story = {
  args: {
    isQueueingEnabled: true,
    composerEnterBehavior: "cmdIfMultiline",
    draftPrompt:
      "Queue this after the current tool-call batch finishes.\nInclude a compact reasoning summary.",
  },
};

export const RunningQueueSingleLineCmdIfMultiline: Story = {
  args: {
    isQueueingEnabled: true,
    composerEnterBehavior: "cmdIfMultiline",
    draftPrompt: "Queue this after the current tool-call batch finishes.",
  },
};

export const RunningSteerMultilineCmdEnter: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "cmdIfMultiline",
    draftPrompt:
      "Steer the current run toward the MCP transcript cleanup.\nPrefer deduping the approval rows.",
  },
};

export const LongPromptScroll: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "cmdIfMultiline",
    draftPrompt: LONG_PROMPT_STORY_DRAFT,
    surfaceWidth: "narrow",
  },
};

export const RestoredDraftAndCompletedContext: Story = {
  args: {
    draftPrompt:
      "Continue the renderer lifecycle migration and preserve this authored draft across task remounts.",
    seedCompletedContext: true,
    surfaceWidth: "narrow",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Composer restoration acceptance state with authored prompt text plus completed file, pasted-text, and capability context owned by the current ComposerScope.",
      },
    },
  },
};

export const AppshotAttachment: Story = {
  args: {
    seedAppshot: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "A captured foreground macOS application, including its screenshot and accessibility context, attached above the composer.",
      },
    },
  },
};

export const ImageAttachment: Story = {
  args: {
    seedImageAttachment: true,
  },
  parameters: {
    docs: {
      description: {
        story: "The image-only Composer state uses the full-size thumbnail shell above the prompt.",
      },
    },
  },
};

export const ImageAndFileAttachments: Story = {
  args: {
    seedCompletedContext: true,
    seedImageAttachment: true,
    surfaceWidth: "narrow",
  },
  parameters: {
    docs: {
      description: {
        story:
          "A mixed attachment row compacts the image while preserving one shared scrolling baseline.",
      },
    },
  },
};

export const PastedTextPending: Story = {
  args: {
    pastedTextState: "pending",
    surfaceWidth: "narrow",
  },
};

export const PastedTextReady: Story = {
  args: {
    pastedTextState: "ready",
    surfaceWidth: "narrow",
  },
};

export const PastedTextFailed: Story = {
  args: {
    pastedTextState: "failed",
    surfaceWidth: "narrow",
  },
};

export const RunningQueueFastTier: Story = {
  args: {
    isQueueingEnabled: true,
    composerEnterBehavior: "enter",
    draftPrompt: "Queue this after the current tool-call batch finishes.",
    initialServiceTier: "fast",
  },
};

export const PromptHistoryAndQueuedFollowUpRecall: Story = {
  args: {
    isQueueingEnabled: true,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    seedPromptHistory: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Seeds thread-scoped prompt history while the streaming fixture also exposes a queued follow-up; ArrowUp should consume the latest queued follow-up before restoring history.",
      },
    },
  },
};

export const FastModelIndicator: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    initialServiceTier: "fast",
  },
};

export const DefaultModelSelector: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
  },
};

export const RichModelCatalog: Story = {
  args: {
    modelCatalog: "rich",
    selectedModel: "gpt-5.6-sol",
    selectedModelDisplayName: "GPT-5.6 Sol",
  },
  play: async ({ canvasElement }) => {
    const trigger = getByRole(canvasElement, "button", { name: "Select model" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => getByRole(document.body, "menuitem", { name: /Model/ }));
    getByRole(document.body, "menuitem", { name: /Effort/ });
    getByRole(document.body, "menuitem", { name: /Speed/ });
  },
  parameters: {
    docs: {
      description: {
        story:
          "A heterogeneous runtime catalog uses the same provider-neutral Model, Effort, and Speed hierarchy without a secondary picker mode.",
      },
    },
  },
};

export const ExpandedModelCatalog: Story = {
  args: {
    modelCatalog: "expanded",
    selectedModel: "gpt-5.5",
    selectedModelDisplayName: "GPT-5.5",
  },
  play: async ({ canvasElement }) => {
    const trigger = getByRole(canvasElement, "button", { name: "Select model" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => getByRole(document.body, "menuitem", { name: /Model/ }));
  },
};

export const RichCatalogWithUnlistedSelection: Story = {
  args: {
    modelCatalog: "rich",
    selectedModel: "gpt-5.5",
    selectedModelDisplayName: "GPT-5.5",
  },
  play: async ({ canvasElement }) => {
    const trigger = getByRole(canvasElement, "button", { name: "Select model" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => getByRole(document.body, "menuitem", { name: /Model/ }));
  },
};

export const RichCatalogUltraEffort: Story = {
  ...RichModelCatalog,
  play: async (context) => {
    await RichModelCatalog.play?.(context);
    const effort = getByRole(document.body, "menuitem", { name: /Effort/ });
    fireEvent.pointerMove(effort);
    fireEvent.click(effort);
    await waitFor(() => getByRole(document.body, "menuitem", { name: /Ultra/ }));
  },
};

export const RichCatalogFast: Story = {
  ...RichModelCatalog,
  args: {
    ...RichModelCatalog.args,
    initialServiceTier: "fast",
  },
};

export const RichCatalogNarrow: Story = {
  ...RichModelCatalog,
  args: {
    ...RichModelCatalog.args,
    surfaceWidth: "narrow",
  },
};

export const ModelPickerLoading: Story = {
  args: {
    modelCatalog: "loading",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The composer stays stable while runtime model options are unavailable and does not invent a selector default.",
      },
    },
  },
};

export const NewChatStatusStrip: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    threadState: "newChat",
  },
};

export const ExpandedModelSubmenu: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    initialServiceTier: "fast",
    modelCatalog: "expanded",
  },
};

export const LimitedModelSupport: Story = {
  args: {
    selectedModel: "gpt-5.5-high-only",
    selectedModelDisplayName: "GPT-5.5 High Only",
    selectedModelReasoningSupport: "highOnly",
  },
};

export const PlanModeActive: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    selectedCollaborationMode: "plan",
  },
};

export const PlanKeywordSuggestion: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt:
      "Plan the migration from local fallback settings to thread-owned next-turn settings.",
    selectedCollaborationMode: "default",
  },
};

export const ExistingThreadSettingsReflected: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    selectedCollaborationMode: "plan",
    selectedModel: "gpt-5.3-codex",
    selectedModelDisplayName: "GPT-5.3 Codex",
    selectedModelReasoningSupport: "default",
  },
};

export const NewThreadDraftPlanMode: Story = {
  args: {
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    draftPrompt: "",
    threadState: "newChat",
    selectedCollaborationMode: "plan",
  },
};

export const AddContextPlugins: Story = {
  args: {
    addContextState: "plugins",
  },
  play: async ({ canvasElement }) => {
    const trigger = getByRole(canvasElement, "button", { name: "Add files and more" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => {
      const menu = canvasElement.querySelector("[data-add-context-menu='true']");
      if (!menu) throw new Error("Add-context suggestions did not open");
      return menu;
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Editor-owned composer suggestion surface with direct actions and atomic plugin mentions.",
      },
    },
  },
};

export const AddContextSearch: Story = {
  args: {
    addContextState: "plugins",
    draftPrompt: "@bro",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Typed at-mention query state remains in the focused editor and collapses providers into one globally ranked result list.",
      },
    },
  },
};

export const SkillAndAppMentions: Story = {
  args: {
    addContextState: "plugins",
    draftPrompt: "$",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Typed dollar suggestions share editor-owned keyboard state and combine enabled skills with accessible apps.",
      },
    },
  },
};

export const InlineSlashCommandMenu: Story = {
  args: {
    draftPrompt: "/",
    modelCatalog: "expanded",
    addContextState: "plugins",
  },
};

export const InlineSlashCommandMenuFiltered: Story = {
  args: {
    draftPrompt: "/mo",
    modelCatalog: "expanded",
  },
};

export const InlineGoalCommandEntry: Story = {
  args: {
    draftPrompt: "/goal",
    modelCatalog: "expanded",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Goal command entry point. Select the Goal row to inspect the active goal-mode footer chip and goal placeholder.",
      },
    },
  },
};

export const GoalReplacementConfirmationEntry: Story = {
  args: {
    draftPrompt: "/goal Replace the saved goal with the current composer objective.",
    savedGoalState: "active",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Existing saved goal plus a replacement draft. Press the submit button to inspect the compact replacement confirmation dialog.",
      },
    },
  },
};

export const NewThreadGoalDraft: Story = {
  args: {
    threadState: "newChat",
    draftPrompt: "/goal Keep refining the migration until tests pass.",
    modelCatalog: "expanded",
  },
  parameters: {
    docs: {
      description: {
        story:
          "New-thread Goal draft. Submitting prepares the objective and attachments for the selected local or worktree start target.",
      },
    },
  },
};

export const InlineSlashCommandMenuEmpty: Story = {
  args: {
    draftPrompt: "/zzzz",
  },
};

export const FullAccessPermissions: Story = {
  args: {
    permissionMode: "full-access",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Full access allows unrestricted file and network access, and can read or modify the entire Nodex Library without approval prompts for the exact Turn.",
      },
    },
  },
};

export const CustomPermissions: Story = {
  args: {
    permissionMode: "custom",
  },
};

export const NarrowLongModelLabel: Story = {
  args: {
    selectedModel: "gpt-5.5-codex-experimental-long-context",
    selectedModelDisplayName: "GPT-5.5 Codex Experimental Long Context",
    surfaceWidth: "narrow",
  },
};
