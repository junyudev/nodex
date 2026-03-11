import { useForm, useStore } from "@tanstack/react-form";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { columnStyles } from "@/components/kanban/column";
import { handleFormSubmit, resolveFormErrorMessage } from "@/lib/forms";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
} from "@/lib/codex-thread-settings";
import { resolveContextWindowIndicatorState } from "@/lib/codex-context-window";
import { invoke, subscribeGitBranchChanges } from "@/lib/api";
import {
  shouldSubmitThreadPromptFromKeyDown,
  type ThreadPromptSubmitShortcut,
} from "@/lib/thread-panel-prompt-submit-shortcut";
import { cn } from "../../../lib/utils";
import type {
  Card,
  CardRunInTarget,
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  CodexConnectionState,
  CodexItemView,
  CodexModelOption,
  CodexPermissionMode,
  CodexPlanImplementationRequest,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexThreadStartProgressPhase,
  CodexThreadDetail,
  CodexUserInputRequest,
} from "../../../lib/types";
import {
  resolveStageThreadsComposerActionState,
  type StageThreadsBusyAction,
} from "../stage-threads-composer-action";
import { CardIcon } from "../card-icon";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
  type BranchSelectorState,
} from "./branch-selector-state";
import { BranchSelectorPopover } from "./branch-selector-popover";
import { resolvePromptTextareaSize } from "./prompt-textarea-size";
import { shouldShowPendingResponseRow } from "./pending-response-state";
import { shouldRenderThreadItem } from "./reasoning-visibility";
import {
  shouldAutoScrollThread,
  shouldShowThreadCatchUpControl,
} from "./thread-auto-scroll";
import { ThreadItemRenderer } from "./thread-item-renderer";
import { coalesceExplorationItems } from "./exploration-item-coalescer";
import {
  AuthPopover,
  ConnectionBadge,
  renderConnectionAccountTooltipContent,
} from "./stage-threads-auth-controls";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "./stage-threads-account-tooltip-refresh";
import { CardInfoHoverCard } from "./stage-threads-card-info-hover-card";
import { resolveThreadCardResult } from "./thread-card-fetch";
import {
  ContextWindowIndicator,
  resolvePromptTextareaMaxHeightPx,
} from "./stage-threads-context-window";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  DownArrowIcon,
  LocalStatusIcon,
  MicIcon,
  PlusIcon,
  ReasoningEffortIcon,
  SpinnerIcon,
  StopIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import {
  ApprovalRequestView,
  PlanImplementationComposerView,
  UserInputComposerView,
} from "./stage-threads-request-cards";
import { PermissionModeDropdown } from "./stage-threads-permission-mode-dropdown";
import { ToolbarDropdownMenu } from "./stage-threads-toolbar-dropdown-menu";
import { StageThreadsCollaborationModeDropdown } from "./stage-threads-collaboration-mode-dropdown";

const PROGRESS_PHASES = [
  { key: "creatingWorktree", label: "Worktree" },
  { key: "runningSetup", label: "Setup" },
  { key: "startingThread", label: "Thread" },
] as const;

const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";

function resolvePhaseIndex(phase: CodexThreadStartProgressPhase): number {
  if (phase === "creatingWorktree") return 0;
  if (phase === "runningSetup") return 1;
  if (phase === "startingThread" || phase === "ready") return 2;
  return -1; // failed
}

function isAssistantTranscriptMessage(item: CodexItemView): boolean {
  return item.normalizedKind === "assistantMessage";
}

function ThreadStartProgressPanel({
  progress,
  outputText,
  setupProgressLogRef,
}: {
  progress: { phase: CodexThreadStartProgressPhase; message: string };
  outputText: string;
  setupProgressLogRef: RefObject<HTMLDivElement | null>;
}) {
  const activePhaseIndex = resolvePhaseIndex(progress.phase);
  const isFailed = progress.phase === "failed";

  return (
    <div className="w-full max-w-140 px-4">
      <div className="mb-3 flex items-center gap-2">
        {!isFailed && <SpinnerIcon className="size-3.5 shrink-0 text-(--foreground-tertiary)" />}
        <span className="text-sm font-medium text-(--foreground-secondary)">
          {progress.message || "Preparing worktree…"}
        </span>
      </div>

      <div className="mb-3 flex items-center gap-1">
        {PROGRESS_PHASES.map((phase, index) => {
          const isComplete = activePhaseIndex > index;
          const isActive = activePhaseIndex === index && !isFailed;
          return (
            <div key={phase.key} className="flex items-center gap-1">
              {index > 0 && (
                <div
                  className={cn(
                    "mx-1 h-px w-4",
                    isComplete ? "bg-(--accent-blue)" : "bg-(--border)",
                  )}
                />
              )}
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[10px] font-medium transition-colors duration-200",
                    isComplete && "bg-(--accent-blue) text-white",
                    isActive && "bg-(--accent-blue)/20 text-(--accent-blue) ring-1 ring-(--accent-blue)/40",
                    !isComplete && !isActive && "bg-(--background-tertiary) text-(--foreground-tertiary)",
                    isFailed && index === activePhaseIndex && "bg-(--destructive)/15 text-(--destructive) ring-1 ring-(--destructive)/30",
                  )}
                >
                  {isComplete ? <CheckmarkIcon className="size-2.5" /> : index + 1}
                </div>
                <span
                  className={cn(
                    "text-xs",
                    isComplete && "text-(--foreground-secondary)",
                    isActive && "font-medium text-(--foreground-secondary)",
                    !isComplete && !isActive && "text-(--foreground-tertiary)",
                    isFailed && index === activePhaseIndex && "font-medium text-(--destructive)",
                  )}
                >
                  {phase.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border-[0.5px] border-(--border) bg-(--background-secondary)">
        <div
          ref={setupProgressLogRef}
          className="scrollbar-token max-h-80 min-h-28 overflow-auto p-3"
        >
          <pre className="font-mono text-xs/relaxed wrap-break-word whitespace-pre-wrap text-(--foreground-tertiary)">
            {outputText || "Preparing…\n"}
          </pre>
        </div>
      </div>
    </div>
  );
}

interface StageThreadsProps {
  projectId: string;
  projectWorkspacePath?: string | null;
  isNewThreadTab: boolean;
  newThreadTarget: {
    projectId: string;
    projectName: string;
    cardId: string;
    cardTitle: string;
    columnId: string;
    runInTarget?: CardRunInTarget;
  } | null;
  activeThreadCardColumnId: string | null;
  threadStartProgress: {
    phase: CodexThreadStartProgressPhase;
    message: string;
    outputText: string;
    updatedAt: number;
  } | null;
  thread: CodexThreadDetail | null;
  connection: CodexConnectionState;
  account: CodexAccountSnapshot | null;
  availableModels: CodexModelOption[];
  collaborationModes: CodexCollaborationModePreset[];
  selectedCollaborationMode: CodexCollaborationModeKind;
  selectedModel: string;
  selectedReasoningEffort: CodexReasoningEffort;
  reasoningEffortOptions: CodexReasoningEffortOption[];
  permissionMode: CodexPermissionMode;
  hideThinkingWhenDone: boolean;
  promptSubmitShortcut: ThreadPromptSubmitShortcut;
  approvalQueue: CodexApprovalRequest[];
  userInputQueue: CodexUserInputRequest[];
  planImplementationQueue: CodexPlanImplementationRequest[];
  onCollaborationModeChange: (mode: CodexCollaborationModeKind) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void;
  onPermissionModeChange: (mode: CodexPermissionMode) => void;
  onRefreshAccount: () => Promise<unknown>;
  onStartChatGptLogin: () => Promise<{ type: "apiKey" } | { type: "chatgpt"; loginId: string; authUrl: string }>;
  onStartApiKeyLogin: (apiKey: string) => Promise<{ type: "apiKey" } | { type: "chatgpt"; loginId: string; authUrl: string }>;
  onCancelLogin: (loginId: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onStartThreadForCard: (input: {
    projectId: string;
    cardId: string;
    prompt: string;
  }) => Promise<void>;
  onSendPrompt: (prompt: string, opts?: { collaborationMode?: CodexCollaborationModeKind }) => Promise<void>;
  onSteerPrompt: (turnId: string, prompt: string) => Promise<void>;
  onInterruptTurn: (turnId?: string) => Promise<void>;
  onRespondApproval: (requestId: string, decision: CodexApprovalDecision) => Promise<void>;
  onRespondUserInput: (requestId: string, answers: Record<string, string[]>) => Promise<void>;
  onResolvePlanImplementationRequest: (threadId: string, turnId: string) => void;
  onOpenCard: (cardId: string) => void;
}

export function StageThreads({
  projectId,
  projectWorkspacePath,
  isNewThreadTab,
  newThreadTarget,
  activeThreadCardColumnId,
  threadStartProgress,
  thread,
  connection,
  account,
  availableModels,
  collaborationModes,
  selectedCollaborationMode,
  selectedModel,
  selectedReasoningEffort,
  reasoningEffortOptions,
  permissionMode,
  hideThinkingWhenDone,
  promptSubmitShortcut,
  approvalQueue,
  userInputQueue,
  planImplementationQueue,
  onCollaborationModeChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onRefreshAccount,
  onStartChatGptLogin,
  onStartApiKeyLogin,
  onCancelLogin,
  onLogout,
  onStartThreadForCard,
  onSendPrompt,
  onSteerPrompt,
  onInterruptTurn,
  onRespondApproval,
  onRespondUserInput,
  onResolvePlanImplementationRequest,
  onOpenCard,
}: StageThreadsProps) {
  const [branchState, setBranchState] = useState<BranchSelectorState>(EMPTY_BRANCH_SELECTOR_STATE);
  const [isBranchBusy, setIsBranchBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<StageThreadsBusyAction>(null);
  const [customPermissionDescription, setCustomPermissionDescription] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [openCardData, setOpenCardData] = useState<Card | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const setupProgressLogRef = useRef<HTMLDivElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const accountRefreshInFlightRef = useRef(false);
  const promptForm = useForm({
    defaultValues: {
      prompt: "",
    },
    onSubmit: async ({ value, formApi }) => {
      const nextPrompt = value.prompt.trim();
      if (!nextPrompt) return;
      const target = newThreadTarget;

      if (thread && isThreadRunning && !activeTurn) {
        setErrorMessage("Codex is already running. Stop the active turn before sending another prompt.");
        return;
      }

      if (!thread && !isNewThreadTab) {
        return;
      }

      setBusyAction("send");
      setErrorMessage(null);

      try {
        if (!thread) {
          if (!target) return;
          await onStartThreadForCard({
            projectId: target.projectId,
            cardId: target.cardId,
            prompt: nextPrompt,
          });
        } else if (activeTurn) {
          await onSteerPrompt(activeTurn.turnId, nextPrompt);
        } else {
          await onSendPrompt(nextPrompt);
        }
        formApi.reset();
      } catch (error) {
        setErrorMessage(resolveFormErrorMessage(error) ?? "Could not send prompt");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const prompt = useStore(promptForm.store, (state) => state.values.prompt);
  const branchCwd = useMemo(
    () => resolveBranchSelectorCwd(thread?.cwd, projectWorkspacePath),
    [projectWorkspacePath, thread?.cwd],
  );
  const branchCwdRef = useRef<string | null>(branchCwd);
  const branchMutationRequestIdRef = useRef(0);

  branchCwdRef.current = branchCwd;

  const modelMenuItems = useMemo(
    () =>
      availableModels
        .filter((model) => !model.hidden)
        .map((model) => ({
          value: model.id,
          label: formatCodexModelLabel(model.id, availableModels),
          description: model.description,
        })),
    [availableModels],
  );

  const reasoningMenuItems = useMemo(
    () =>
      reasoningEffortOptions.map((option) => ({
        value: option.reasoningEffort,
        label: formatCodexReasoningEffortLabel(option.reasoningEffort),
        description: option.description,
      })),
    [reasoningEffortOptions],
  );

  const activeTurn = useMemo(() => {
    if (!thread) return null;
    const inProgressTurns = thread.turns.filter((turn) => turn.status === "inProgress");
    return inProgressTurns[inProgressTurns.length - 1] ?? null;
  }, [thread]);

  useEffect(() => {
    const cardId = thread?.cardId;
    if (!cardId) {
      setOpenCardData(null);
      return;
    }

    let cancelled = false;
    setOpenCardData(null);

    void invoke("card:get", projectId, cardId, activeThreadCardColumnId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        const card = resolveThreadCardResult(result);
        if (!card) return;
        setOpenCardData(card);
      })
      .catch(() => {
        if (cancelled) return;
        setOpenCardData(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadCardColumnId, projectId, thread?.cardId]);

  const isThreadRunning = Boolean(thread && (thread.statusType === "active" || activeTurn !== null));

  const interruptTargetTurnId = useMemo(() => activeTurn?.turnId ?? null, [activeTurn]);

  const latestTurnId = useMemo(() => {
    if (!thread?.turns.length) return null;
    return thread.turns[thread.turns.length - 1]?.turnId ?? null;
  }, [thread]);

  const contextWindowIndicatorState = useMemo(() => resolveContextWindowIndicatorState(thread), [thread]);

  const activeApprovals = useMemo(
    () => approvalQueue.filter((request) => !thread || request.threadId === thread.threadId),
    [approvalQueue, thread],
  );

  const activeUserInputs = useMemo(
    () => userInputQueue.filter((request) => !thread || request.threadId === thread.threadId),
    [thread, userInputQueue],
  );
  const activeUserInputRequest = activeUserInputs[0] ?? null;
  const activePlanImplementationRequest = useMemo(
    () => {
      if (!thread) return null;
      return planImplementationQueue.find((request) => request.threadId === thread.threadId) ?? null;
    },
    [planImplementationQueue, thread],
  );

  const orderedItems = useMemo(() => {
    if (!thread) return [];
    const sortedItems = [...thread.items].sort((a, b) => a.createdAt - b.createdAt);
    const visibleItems = sortedItems.filter((item) =>
      shouldRenderThreadItem(item, hideThinkingWhenDone, activeTurn?.turnId ?? null),
    );
    return coalesceExplorationItems(visibleItems, {
      activeTurnId: activeTurn?.turnId ?? null,
    });
  }, [activeTurn?.turnId, hideThinkingWhenDone, thread]);

  const latestItemUpdatedAt = useMemo(() => {
    if (orderedItems.length === 0) return 0;
    return orderedItems.reduce((maxUpdatedAt, item) => Math.max(maxUpdatedAt, item.updatedAt), 0);
  }, [orderedItems]);
  const showWaitingForResponseRow = useMemo(
    () => shouldShowPendingResponseRow(orderedItems, activeTurn?.turnId ?? null, isThreadRunning),
    [activeTurn?.turnId, isThreadRunning, orderedItems],
  );

  const latestAssistantMessageItemId = useMemo(() => {
    for (let index = orderedItems.length - 1; index >= 0; index -= 1) {
      const item = orderedItems[index];
      if (isAssistantTranscriptMessage(item)) {
        return item.itemId;
      }
    }
    return null;
  }, [orderedItems]);

  const handleRespondPlanImplementation = useCallback(async (
    response:
      | { type: "dismiss" }
      | { type: "implement" }
      | { type: "followUp"; prompt: string },
  ) => {
    if (!activePlanImplementationRequest || !thread) return;

    onResolvePlanImplementationRequest(activePlanImplementationRequest.threadId, activePlanImplementationRequest.turnId);
    if (response.type === "dismiss") return;

    if (response.type === "implement") {
      onCollaborationModeChange("default");
      await onSendPrompt(
        `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}\n${activePlanImplementationRequest.planContent}`,
        { collaborationMode: "default" },
      );
      return;
    }

    await onSendPrompt(response.prompt);
  }, [
    activePlanImplementationRequest,
    onCollaborationModeChange,
    onResolvePlanImplementationRequest,
    onSendPrompt,
    thread,
  ]);

  const handleRefreshBranchState = useCallback(async () => {
    const requestedCwd = branchCwdRef.current;
    if (!requestedCwd) {
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
      return;
    }

    try {
      const result = await invoke("git:branch:state", requestedCwd);
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(parseBranchSelectorState(result));
    } catch {
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void invoke("codex:permission:custom-description:get", projectId)
      .then((result) => {
        if (cancelled) return;
        setCustomPermissionDescription(typeof result === "string" ? result : null);
      })
      .catch(() => {
        if (cancelled) return;
        setCustomPermissionDescription(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    branchMutationRequestIdRef.current += 1;
    setIsBranchBusy(false);

    const requestedCwd = branchCwd;
    if (!requestedCwd) {
      if (!cancelled) {
        setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
      }
      return () => {
        cancelled = true;
      };
    }

    void invoke("git:branch:state", requestedCwd)
      .then((result) => {
        if (cancelled) return;
        if (branchCwdRef.current !== requestedCwd) return;
        setBranchState(parseBranchSelectorState(result));
      })
      .catch(() => {
        if (cancelled) return;
        if (branchCwdRef.current !== requestedCwd) return;
        setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
      });

    return () => {
      cancelled = true;
    };
  }, [branchCwd]);

  useEffect(() => {
    if (!branchCwd) {
      void invoke("git:branch:watch:stop").catch(() => { });
      return;
    }

    void invoke("git:branch:watch:start", branchCwd).catch(() => { });

    const unsubscribe = subscribeGitBranchChanges((event) => {
      if (event.cwd !== branchCwdRef.current) return;
      void handleRefreshBranchState();
    });

    const handleWindowFocus = () => {
      void handleRefreshBranchState();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void handleRefreshBranchState();
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void invoke("git:branch:watch:stop").catch(() => { });
    };
  }, [branchCwd, handleRefreshBranchState]);

  useEffect(() => {
    setIsFollowingLatest(true);
  }, [thread?.threadId]);

  const updateFollowModeFromScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const shouldFollow = shouldAutoScrollThread({
      position: element,
    });

    setIsFollowingLatest((previousValue) => {
      if (previousValue === shouldFollow) return previousValue;
      return shouldFollow;
    });
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !thread || !isFollowingLatest) return;

    requestAnimationFrame(() => {
      const currentElement = scrollRef.current;
      if (!currentElement) return;
      currentElement.scrollTop = currentElement.scrollHeight;
    });
  }, [activeApprovals.length, activeUserInputs.length, isFollowingLatest, latestItemUpdatedAt, orderedItems.length, thread]);

  const resizePromptTextarea = useCallback(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";

    const { heightPx, hasOverflow } = resolvePromptTextareaSize({
      scrollHeight: textarea.scrollHeight,
      maxHeightPx: resolvePromptTextareaMaxHeightPx(),
    });

    if (heightPx <= 0) {
      textarea.style.height = "";
      textarea.style.overflowY = "hidden";
      return;
    }

    textarea.style.height = `${heightPx}px`;
    textarea.style.overflowY = hasOverflow ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizePromptTextarea();
  }, [prompt, resizePromptTextarea]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      resizePromptTextarea();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [resizePromptTextarea]);

  const handleInterrupt = useCallback(async () => {
    if (!thread || !isThreadRunning) return;

    setBusyAction("interrupt");
    setErrorMessage(null);

    try {
      await onInterruptTurn(interruptTargetTurnId ?? undefined);
    } catch (error) {
      setErrorMessage(resolveFormErrorMessage(error) ?? "Could not stop Codex");
    } finally {
      setBusyAction(null);
    }
  }, [interruptTargetTurnId, isThreadRunning, onInterruptTurn, thread]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!shouldSubmitThreadPromptFromKeyDown({
        shortcut: promptSubmitShortcut,
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
      })) {
        return;
      }
      event.preventDefault();
      void promptForm.handleSubmit();
    },
    [promptForm, promptSubmitShortcut],
  );

  const handleComposerActionClick = useCallback(() => {
    if (isThreadRunning) {
      void handleInterrupt();
      return;
    }

    void promptForm.handleSubmit();
  }, [handleInterrupt, isThreadRunning, promptForm]);

  const handleChatGptLogin = useCallback(async () => {
    setBusyAction("login");
    setErrorMessage(null);

    try {
      const result = await onStartChatGptLogin();
      if (result.type === "chatgpt" && result.authUrl) {
        window.open(result.authUrl, "_blank");
      }
    } catch (error) {
      setErrorMessage(resolveFormErrorMessage(error) ?? "Login failed");
    } finally {
      setBusyAction(null);
    }
  }, [onStartChatGptLogin]);

  const handleApiKeyLogin = useCallback(async (key: string) => {
    setBusyAction("login");
    setErrorMessage(null);

    try {
      await onStartApiKeyLogin(key);
    } catch (error) {
      setErrorMessage(resolveFormErrorMessage(error) ?? "Login failed");
    } finally {
      setBusyAction(null);
    }
  }, [onStartApiKeyLogin]);

  const handleLogout = useCallback(async () => {
    setBusyAction("logout");

    try {
      await onLogout();
    } catch (error) {
      setErrorMessage(resolveFormErrorMessage(error) ?? "Logout failed");
    } finally {
      setBusyAction(null);
    }
  }, [onLogout]);

  const handleCheckoutBranch = useCallback(async (branch: string) => {
    const requestedCwd = branchCwd;
    if (!requestedCwd) return false;
    const requestId = branchMutationRequestIdRef.current + 1;
    branchMutationRequestIdRef.current = requestId;
    const isCurrentRequest = () => isBranchSelectorMutationCurrent({
      activeRequestId: branchMutationRequestIdRef.current,
      requestId,
      activeCwd: branchCwdRef.current,
      requestedCwd,
    });

    setIsBranchBusy(true);
    setErrorMessage(null);

    try {
      const result = await invoke("git:branch:checkout", {
        cwd: requestedCwd,
        branch,
      });
      if (!isCurrentRequest()) {
        return false;
      }
      setBranchState(parseBranchSelectorState(result));
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        setErrorMessage(error instanceof Error ? error.message : "Could not switch branches");
      }
      return false;
    } finally {
      if (isCurrentRequest()) {
        setIsBranchBusy(false);
      }
    }
  }, [branchCwd]);

  const handleCreateBranch = useCallback(async (branch: string) => {
    const requestedCwd = branchCwd;
    if (!requestedCwd) return false;
    const requestId = branchMutationRequestIdRef.current + 1;
    branchMutationRequestIdRef.current = requestId;
    const isCurrentRequest = () => isBranchSelectorMutationCurrent({
      activeRequestId: branchMutationRequestIdRef.current,
      requestId,
      activeCwd: branchCwdRef.current,
      requestedCwd,
    });

    setIsBranchBusy(true);
    setErrorMessage(null);

    try {
      const result = await invoke("git:branch:create", {
        cwd: requestedCwd,
        branch,
      });
      if (!isCurrentRequest()) {
        return false;
      }
      setBranchState(parseBranchSelectorState(result));
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        setErrorMessage(error instanceof Error ? error.message : "Could not create branch");
      }
      return false;
    } finally {
      if (isCurrentRequest()) {
        setIsBranchBusy(false);
      }
    }
  }, [branchCwd]);

  const isCloudNewThreadTarget = Boolean(
    isNewThreadTab && newThreadTarget?.runInTarget === "cloud",
  );

  const composerActionState = resolveStageThreadsComposerActionState({
    canSendPrompt: (thread !== null || (isNewThreadTab && newThreadTarget !== null)) && !isCloudNewThreadTarget,
    isThreadRunning,
    busyAction,
    prompt,
  });
  const isSendPending = busyAction === "send" && composerActionState.action === "send";
  const composerActionLabel = isSendPending ? "Sending prompt" : composerActionState.label;
  const hasPromptDraft = prompt.trim().length > 0;
  const canRunPrimaryAction = Boolean(
    hasPromptDraft
    && (thread || (isNewThreadTab && newThreadTarget))
    && !isCloudNewThreadTarget,
  );

  const openCardTarget = thread
    ? {
      cardId: thread.cardId,
      title: openCardData?.title ?? (thread.threadName?.trim() || thread.threadPreview || thread.cardId),
      columnId: activeThreadCardColumnId,
    }
    : isNewThreadTab && newThreadTarget
      ? { cardId: newThreadTarget.cardId, title: newThreadTarget.cardTitle, columnId: newThreadTarget.columnId }
      : null;

  const openCardTone = openCardTarget?.columnId ? columnStyles[openCardTarget.columnId] : null;
  const showCatchUpControl = shouldShowThreadCatchUpControl({
    hasThread: thread !== null,
    hasItems: orderedItems.length > 0,
    isFollowingLatest,
  });
  const showThreadStartProgressPanel = Boolean(
    isNewThreadTab && !thread && newThreadTarget && threadStartProgress,
  );
  const setupProgressOutput = threadStartProgress?.outputText ?? "";
  const connectionTooltipContent = account?.account
    ? renderConnectionAccountTooltipContent(account.account, account.rateLimits, {
      onSignOut: () => void handleLogout(),
      isSigningOutDisabled: busyAction !== null,
    })
    : null;
  const handleConnectionTooltipOpenChange = useCallback((isOpen: boolean) => {
    if (
      !shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen,
        hasAccount: Boolean(account?.account),
        refreshInFlight: accountRefreshInFlightRef.current,
      })
    ) {
      return;
    }

    accountRefreshInFlightRef.current = true;
    void onRefreshAccount()
      .catch(() => {
        // Keep the current snapshot if the hover refresh fails.
      })
      .finally(() => {
        accountRefreshInFlightRef.current = false;
      });
  }, [account?.account, onRefreshAccount]);

  const handleCatchUp = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    setIsFollowingLatest(true);
    element.scrollTop = element.scrollHeight;
  }, []);

  const conversationClassName =
    "relative flex flex-col gap-3 py-3 " +
    "browser:[--color-token-description-foreground:color-mix(in_srgb,var(--color-token-foreground)_90%,transparent)] " +
    "electron:[--color-token-description-foreground:color-mix(in_srgb,var(--color-token-foreground)_70%,transparent)]";

  useEffect(() => {
    if (!showThreadStartProgressPanel) return;
    const element = setupProgressLogRef.current;
    if (!element) return;
    requestAnimationFrame(() => {
      const current = setupProgressLogRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
    });
  }, [setupProgressOutput, showThreadStartProgressPanel, threadStartProgress?.updatedAt]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--background)">
      <div className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm/tight font-medium text-(--foreground)">
            {thread?.threadName || thread?.threadPreview || (isNewThreadTab ? "New thread" : "No thread")}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {openCardTarget && (
              <CardInfoHoverCard card={openCardData} columnId={openCardTarget.columnId}>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-5 max-w-40 items-center gap-1 rounded-full px-2 text-xs font-medium hover:opacity-80",
                    openCardTone
                      ? `${openCardTone.badgeBg} ${openCardTone.badgeText}`
                      : "bg-(--blue-bg) text-(--accent-blue)",
                  )}
                  onClick={() => onOpenCard(openCardTarget.cardId)}
                >
                  <CardIcon className="size-2.75 shrink-0" />
                  <span className="truncate">{openCardTarget.title}</span>
                </button>
              </CardInfoHoverCard>
            )}
            <AuthPopover
              account={account}
              busyAction={busyAction}
              onChatGptLogin={() => void handleChatGptLogin()}
              onApiKeyLogin={(key) => void handleApiKeyLogin(key)}
              onCancelLogin={(loginId) => void onCancelLogin(loginId)}
            />
            <ConnectionBadge
              connection={connection}
              tooltipContent={connectionTooltipContent}
              onTooltipOpenChange={handleConnectionTooltipOpenChange}
            />
          </div>
        </div>
      </div>

      <div ref={scrollRef} onScroll={updateFollowModeFromScroll} className="vertical-scroll-fade-mask-top scrollbar-token min-h-0 flex-1 overflow-y-auto pt-(--edge-fade-distance)">
        <div className="mx-auto flex min-h-full max-w-(--pane-content-max-width) flex-col px-2.5 md:px-panel">
          {!thread ? (
            <div className="flex flex-1 items-center justify-center">
              {isNewThreadTab ? (
                showThreadStartProgressPanel ? (
                  <ThreadStartProgressPanel
                    progress={threadStartProgress!}
                    outputText={setupProgressOutput}
                    setupProgressLogRef={setupProgressLogRef}
                  />
                ) : (
                  <div className="max-w-95 space-y-2 px-6 text-center">
                    <div className="text-base font-medium text-(--foreground-tertiary)">Start a new thread</div>
                    <div className="text-sm/normal text-(--foreground-tertiary) opacity-60">
                      {newThreadTarget
                        ? isCloudNewThreadTarget
                          ? "Cloud run target is mock-only right now. Change the card Run in property to Local project or New worktree."
                          : "Write the first prompt and send to create a new card-linked thread."
                        : "Select a card in the Cards stage, then press New in its Threads property."}
                    </div>
                  </div>
                )
              ) : (
                <div className="space-y-2 px-6 text-center">
                  <div className="text-base font-medium text-(--foreground-tertiary)">No thread selected</div>
                  <div className="text-sm/normal text-(--foreground-tertiary) opacity-60">
                    Select a thread from the sidebar to view the conversation.
                  </div>
                </div>
              )}
            </div>
          ) : orderedItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              {isThreadRunning ? (
                <div className="flex items-center gap-2.5 text-(--foreground-tertiary)">
                  <SpinnerIcon className="size-4" />
                  <span className="text-sm font-medium">Waiting for response…</span>
                </div>
              ) : (
                <div className="space-y-1 px-6 text-center">
                  <div className="text-base font-medium text-(--foreground-tertiary)">No messages yet</div>
                  <div className="text-sm text-(--foreground-tertiary) opacity-60">Send a prompt to begin.</div>
                </div>
              )}
            </div>
          ) : (
            <div className={conversationClassName}>
              {orderedItems.map((item) => (
                <ThreadItemRenderer
                  key={`${item.turnId}:${item.itemId}`}
                  item={item}
                  isLatestTurn={item.turnId === latestTurnId}
                  isStreamingTurn={item.turnId === activeTurn?.turnId}
                  showAssistantMessageActions={item.itemId === latestAssistantMessageItemId}
                  projectWorkspacePath={projectWorkspacePath ?? undefined}
                  threadCwd={thread?.cwd ?? undefined}
                />
              ))}

              {activeApprovals.map((request) => (
                <ApprovalRequestView key={request.requestId} request={request} onRespond={onRespondApproval} />
              ))}

              {isThreadRunning && (
                <div className="px-3 py-2">
                  {showWaitingForResponseRow ? (
                    <div className="flex items-center gap-2.5 text-(--foreground-tertiary)">
                      <SpinnerIcon className="size-4" />
                      <span className="text-sm font-medium">Waiting for response…</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="size-2 animate-pulse rounded-full bg-(--accent-blue) shadow-focus-glow" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="relative bg-(--background) pb-0">
        {showCatchUpControl && (
          <div className="pointer-events-none absolute inset-x-0 -top-14 z-10 flex justify-center">
            <button
              type="button"
              className="pointer-events-auto cursor-pointer flex size-8 items-center justify-center rounded-full border border-token-border bg-(--background) bg-clip-padding text-(--foreground-secondary) print:hidden"
              onClick={handleCatchUp}
              aria-label="Jump to latest messages"
              title="Jump to latest messages"
            >
              <DownArrowIcon className="size-5 text-(--foreground)" />
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-full h-4 bg-linear-to-t from-(--background) to-transparent" />

        <div className="mx-auto max-w-(--pane-content-max-width) px-2.5 md:px-panel">
          {activeUserInputRequest ? (
            <UserInputComposerView request={activeUserInputRequest} onRespond={onRespondUserInput} />
          ) : activePlanImplementationRequest ? (
            <PlanImplementationComposerView
              request={activePlanImplementationRequest}
              onRespond={handleRespondPlanImplementation}
            />
          ) : (
            <form
              className={cn(
                "relative overflow-hidden rounded-3xl border border-token-border shadow-card-md",
              )}
              onSubmit={(event) => handleFormSubmit(event, promptForm.handleSubmit)}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-0 rounded-3xl bg-token-input-background electron:rounded-3xl electron:bg-token-side-bar-background electron:dark:bg-token-dropdown-background/25"
              />

              <div className="relative z-10">
                <div className="px-2 py-1.5">
                  <div className="flex w-full flex-wrap items-center justify-start gap-1" />
                </div>

                <div className="mb-2 grow overflow-y-auto px-3">
                  <div className="h-auto max-h-[25dvh] min-h-[4dvh] overflow-y-auto text-sm text-(--foreground)">
                    <textarea
                      ref={promptTextareaRef}
                      value={prompt}
                      placeholder={
                        thread
                          ? "Ask for follow-up changes"
                          : isNewThreadTab
                            ? newThreadTarget
                              ? isCloudNewThreadTarget
                                ? "Cloud run target is currently mock-only"
                                : "Write the first prompt for this new thread..."
                              : "Select a card before starting a new thread"
                            : "Select a thread"
                      }
                      onChange={(event) => {
                        promptForm.setFieldValue("prompt", event.target.value);
                      }}
                      onKeyDown={handleKeyDown}
                      rows={1}
                      className="min-h-10 w-full resize-none border-0 bg-transparent p-0 text-sm/editor text-(--foreground) placeholder:text-(--foreground-tertiary) focus:outline-none"
                      disabled={(thread === null && (!isNewThreadTab || newThreadTarget === null || isCloudNewThreadTarget)) || busyAction !== null}
                    />
                  </div>
                </div>

                {errorMessage && <div className="px-3 pb-2 text-xs text-(--destructive)">{errorMessage}</div>}

                <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.25 px-2">
                  <div className="flex w-full min-w-0 flex-nowrap items-center justify-start gap-1.25">
                    <input multiple className="hidden" type="file" />
                    <button
                      type="button"
                      className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-tertiary) transition-colors duration-100 hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)"
                      aria-label="Add files and more"
                      title="Add files and more"
                    >
                      <PlusIcon className="size-4" />
                    </button>

                    <div className="flex min-w-0 items-center gap-1">
                      <StageThreadsCollaborationModeDropdown
                        collaborationModes={collaborationModes}
                        selectedMode={selectedCollaborationMode}
                        onSelect={onCollaborationModeChange}
                      />
                      <ToolbarDropdownMenu
                        label={formatCodexModelLabel(selectedModel, availableModels)}
                        title="Select model"
                        ariaLabel="Select Codex model"
                        className="min-w-0"
                        items={modelMenuItems}
                        selectedValue={selectedModel}
                        onSelect={onModelChange}
                        emptyLabel="No Codex models available"
                      />
                      <ToolbarDropdownMenu
                        label={formatCodexReasoningEffortLabel(selectedReasoningEffort)}
                        title="Select reasoning"
                        ariaLabel="Select reasoning effort"
                        items={reasoningMenuItems}
                        selectedValue={selectedReasoningEffort}
                        selectedItemDataAttribute="data-reasoning-selected"
                        onSelect={(value) => onReasoningEffortChange(value as CodexReasoningEffort)}
                        renderItemIcon={(value) => (
                          <ReasoningEffortIcon effort={value as CodexReasoningEffort} className="icon-2xs" />
                        )}
                      />
                    </div>
                  </div>

                  <div className="flex items-center" />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-tertiary) transition-colors duration-100 hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)"
                      aria-label="Dictate"
                      title="Dictate"
                    >
                      <MicIcon className="size-4" />
                    </button>

                    <button
                      type={composerActionState.action === "stop" ? "button" : "submit"}
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-full p-0.5 focus-visible:outline-2 focus-visible:outline-(--ring)",
                        "bg-(--foreground) text-(--background)",
                        (composerActionState.disabled || (composerActionState.action !== "stop" && !canRunPrimaryAction)) && !isSendPending && "opacity-50",
                        isSendPending && "cursor-wait",
                      )}
                      onClick={composerActionState.action === "stop" ? handleComposerActionClick : undefined}
                      disabled={composerActionState.action === "stop"
                        ? composerActionState.disabled
                        : composerActionState.disabled || !canRunPrimaryAction}
                      aria-label={composerActionLabel}
                      title={composerActionLabel}
                    >
                      {isSendPending ? (
                        <SpinnerIcon className="size-5" />
                      ) : composerActionState.action === "stop" ? (
                        <StopIcon className="size-4" />
                      ) : (
                        <UpArrowIcon className="size-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          )}

          <div className="flex flex-wrap items-center gap-2 overflow-visible px-2 py-1.5">
            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1">
              <div className="relative flex w-full items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-1.5 text-sm/4.5 text-(--foreground-tertiary) transition-colors duration-100 hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)"
                >
                  <LocalStatusIcon className="shrink-0" />
                  <span className="max-w-40 truncate text-sm">{projectId.split("/").pop() ?? "Local"}</span>
                  <ChevronDownIcon />
                </button>

                <PermissionModeDropdown
                  selectedMode={permissionMode}
                  customDescription={customPermissionDescription}
                  onSelect={onPermissionModeChange}
                />
              </div>
            </div>

            <div className="ml-auto flex items-center gap-3">
              <BranchSelectorPopover
                cwd={branchCwd}
                state={branchState}
                busy={isBranchBusy}
                onRefresh={handleRefreshBranchState}
                onCheckout={handleCheckoutBranch}
                onCreate={handleCreateBranch}
              />

              <ContextWindowIndicator state={contextWindowIndicatorState} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
