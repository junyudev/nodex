import { runWithCleanup } from "@/lib/run-with-cleanup";
import { agentRuntimeSubagentApprovalsQueryOptions } from "@/features/local-conversation/agent-runtime-subagent-overview";
import { composerDraftIntents } from "@/lib/composer-draft-intents";
import { ConnectedThreadStage, type ThreadStageActions } from "@/features/local-conversation";
import { ConversationRuntimeContext } from "@/features/local-conversation/conversation-runtime";
import { useAgentRuntimeConversationAdapter } from "@/features/local-conversation/agent-runtime-conversation-adapter";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { composeNativeThreadStageActions } from "@/features/local-conversation/native-thread-stage-actions";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";
import type { Project, ProjectSession, CodexComposerIntent } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { toast } from "@/components/ui/toast";
import type { FirstSubmissionIdentity } from "@/features/conversation-launch/session-first-submission-owner";
import type { AgentSubagentOverview } from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import {
  agentRuntimeOverviewSectionsToRefill,
  agentRuntimeOverviewWindow,
  appendAgentRuntimeOverviewPage,
  agentRuntimeOverviewTotalsUnknown,
  applyAgentRuntimeOverviewTask,
  reconcileAgentRuntimeOverview,
  type AgentRuntimeOverviewWindow,
  projectAgentRuntimeSubagentOverview,
  type AgentRuntimeTaskRecord,
} from "@/features/local-conversation/agent-runtime-subagent-overview";
import {
  agentRuntimeDelegatedTasks,
  isAgentRuntimeTaskStopping,
  requestAgentRuntimeTaskStop,
} from "@/features/local-conversation/agent-runtime-delegated-tasks";
import { useAgentRuntimeConnectionState } from "@/lib/agent-runtime-session-activity";
import type { CodexSubagentOverviewRow } from "../../../shared/types";
import {
  SubagentsPanelDetailHeader,
  SubagentsPanelOverviewContent,
} from "@/features/local-conversation/view/subagents-panel/subagents-panel";
import { projectSubagentOverviewRowToOpenPayload } from "./workbench-subagent-status";
import type { ThreadOpenSubagentPayload } from "@/features/local-conversation/thread-stage-types";
import {
  readAgentRuntimeEffort,
  readAgentRuntimeServiceTier,
} from "../../../shared/agent-runtime-provider";

/** A child keeps its product Session and reads only its own bounded engine history. */
export function AgentRuntimeChildPanel(input: {
  readonly session: WorkbenchSessionRenderProjection;
  readonly threadId: string;
  readonly title: string;
  readonly project: Project | null;
  readonly canInteract: boolean;
  readonly onBackToSubagents?: () => void;
  readonly composerEnterBehavior: ComposerEnterBehavior;
  readonly queueingEnabled: boolean;
  readonly onRefresh: (projectId: string) => Promise<unknown>;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  readonly hostActions: Partial<ThreadStageActions>;
  readonly turnDiffHoverPreviewDisabled: boolean;
}) {
  const instances = useAgentInstances();
  const agent = useAgentRuntimeConversationAdapter({
    sessionId: input.session.id,
    sessionTitle: input.title,
    sessionUnread: input.session.unread,
    workspaceRoot: projectWorkspaceRootOrNull(input.project),
    executionRef: input.session.executionRef,
    threadId: input.threadId,
    projectId: input.session.projectId,
    modelProjectId: input.session.projectId,
    instances: instances.instances,
    onRefresh: (projectId) => (projectId === null ? Promise.resolve() : input.onRefresh(projectId)),
    onOpenThread: input.onOpenThread,
    ensureDraft: async () => {
      throw new Error("A subagent uses its existing Session");
    },
  });
  const actions = composeNativeThreadStageActions(
    {
      onQueueingEnabledChange: input.hostActions.onQueueingEnabledChange ?? (() => {}),
      onNewThreadProjectChange: () => {},
      onRequestNewChatProjectCreate: () => {},
      onNewThreadStartInTargetChange: () => {},
      onNewThreadStartInEnvironmentChange: () => {},
      onRefreshNewThreadStartInEnvironments: async () => {},
      onOpenNewThreadLocalEnvironmentsSettings: () => {},
      onOpenThread: input.onOpenThread,
    },
    { ...input.hostActions, ...agent.actions },
  );
  const observedSelection = agent.state.conversation?.snapshot.projection.thread.modelSelection;
  return (
    <ConversationRuntimeContext value={agent.runtime}>
      <div className="flex h-full min-h-0 flex-col">
        {input.onBackToSubagents ? (
          <SubagentsPanelDetailHeader
            threadId={input.threadId}
            displayName={input.title}
            agent={
              observedSelection
                ? {
                    kind: agent.runtime.kind,
                    providerInstanceId: observedSelection.instanceId,
                    model: observedSelection.model,
                    effort: readAgentRuntimeEffort(observedSelection.options),
                  }
                : null
            }
            fast={readAgentRuntimeServiceTier(observedSelection?.options) === "fast"}
            onBack={input.onBackToSubagents}
          />
        ) : null}
        <div className="min-h-0 flex-1">
          <ConnectedThreadStage
            presentation="panel"
            provider={agent.provider}
            projectId={input.session.projectId}
            sessionId={input.session.id}
            composerChatKey={{
              kind: "session-thread",
              sessionId: input.session.id,
              threadId: input.threadId,
            }}
            composerScopeIdentity={`agent-runtime:${input.session.id}:${input.threadId}`}
            projectWorkspacePath={projectWorkspaceRootOrNull(input.project)}
            isNewThreadTab={false}
            newThreadTarget={null}
            newThreadProjectSelector={null}
            newThreadStartInSelector={null}
            threadStartProgress={null}
            activeThreadId={input.threadId}
            activeThreadSummary={agent.summary}
            backgroundAgentDetail={true}
            backgroundAgentCanInteract={input.canInteract}
            availableModels={agent.models}
            collaborationModes={agent.modes}
            selectedCollaborationMode={agent.selectedMode}
            selectedModel={agent.selectedModel}
            selectedReasoningEffort={agent.selectedEffort}
            reasoningEffortOptions={agent.reasoningEffortOptions}

            isQueueingEnabled={input.queueingEnabled}
            composerEnterBehavior={input.composerEnterBehavior}
            searchOpenTick={0}
            summaryPanelMounted={false}
            summaryPanelOpen={false}
            summaryPanelHideImmediately={false}
            turnDiffHoverPreviewDisabled={input.turnDiffHoverPreviewDisabled}
            actions={actions}
          />
        </div>
      </div>
    </ConversationRuntimeContext>
  );
}

/** A side chat is already bound to its captured context before its first message. */
export function AgentRuntimeSideChatPanel(input: {
  readonly session: ProjectSession;
  readonly parentThreadId: string;
  readonly title: string;
  readonly onTitleChange?: (title: string) => void;
  /** The opening message was sent or returned to the composer; it is never handled again. */
  readonly onInitialSubmissionSettled?: () => void;
  readonly project: Project | null;
  readonly initialPrompt: Pick<CodexComposerIntent, "prompt" | "promptInput"> | null;
  readonly initialSubmission?: FirstSubmissionIdentity & {
    readonly acceptedAt: number;
    readonly presentationTicket?: import("../../../shared/nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
  };
  readonly onRefresh: (projectId: string | null) => Promise<unknown>;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  readonly composerEnterBehavior: ComposerEnterBehavior;
  readonly hostActions: Partial<ThreadStageActions>;
  readonly turnDiffHoverPreviewDisabled: boolean;
}) {
  const instances = useAgentInstances();
  const sessionQuery = useQuery({
    ...projectSessionDetailQueryOptions(input.session.id),
    initialData: input.session,
  });
  const session = sessionQuery.data ?? input.session;
  const agent: ReturnType<typeof useAgentRuntimeConversationAdapter> =
    useAgentRuntimeConversationAdapter({
      sessionId: session.id,
      sessionTitle: input.title,
      onSideChatTitle: input.onTitleChange,
      sessionUnread: session.unread,
      workspaceRoot: projectWorkspaceRootOrNull(input.project),
      executionRef: session.executionRef,
      projectId: session.projectId,
      modelProjectId: session.projectId,
      instances: instances.instances,
      onRefresh: input.onRefresh,
      onOpenThread: input.onOpenThread,
      ensureDraft: async () => {
        throw new Error("A side chat uses its captured conversation");
      },
    });
  const summary = agent.summary;
  const startedInitialSubmission = useRef<string | null>(null);
  // The opening message is sent, never drafted, and handled once; one that cannot be sent
  // waits in the composer for a manual send.
  const settleInitialSubmission = useEffectEvent((sent: boolean) => {
    if (!sent && input.initialPrompt)
      composerDraftIntents.set(
        { kind: "session", sessionId: session.id },
        {
          prompt: input.initialPrompt.prompt,
          promptInput: input.initialPrompt.promptInput,
          attachmentMode: "replace",
          focusNonce: Date.now(),
        },
      );
    input.onInitialSubmissionSettled?.();
  });
  const submitInitialPrompt = useEffectEvent(async () => {
    await runWithCleanup(
      async () => {
        await agent.actions.onSendPrompt?.(input.initialPrompt?.prompt ?? "", {
          promptInput: input.initialPrompt?.promptInput,
          submissionIdentity: input.initialSubmission,
          presentationTicket: input.initialSubmission?.presentationTicket,
        });
        settleInitialSubmission(true);
      },
      {
        onError: (cause) => {
          settleInitialSubmission(false);
          toast.danger(cause instanceof Error ? cause.message : "The side chat could not start.", {
            id: `side-chat-submit:${session.id}`,
          });
        },
      },
    );
  });
  const catalog = agent.provider.modelCatalog;
  useEffect(() => {
    const identity = input.initialSubmission;
    if (!identity || !agent.summary) return;
    if (startedInitialSubmission.current === identity.launchId) return;
    const ready = agent.models.length > 0 && Boolean(agent.selectedModel);
    // Waiting is only correct while the catalog loads; afterwards the message waits for a manual send.
    if (!ready && catalog?.loading !== false) return;
    startedInitialSubmission.current = identity.launchId;
    if (ready) {
      void submitInitialPrompt();
      return;
    }
    settleInitialSubmission(false);
    toast.danger(
      catalog?.error ??
        "No Agent model is available, so the side chat was not sent. Choose a model to send it.",
      { id: `side-chat-submit:${session.id}` },
    );
  }, [
    input.initialSubmission,
    agent.summary,
    session.id,
    agent.models.length,
    agent.selectedModel,
    catalog?.loading,
    catalog?.error,
  ]);
  const actions = composeNativeThreadStageActions(
    {
      onQueueingEnabledChange: input.hostActions.onQueueingEnabledChange ?? (() => {}),
      onNewThreadProjectChange: () => {},
      onRequestNewChatProjectCreate: () => {},
      onNewThreadStartInTargetChange: () => {},
      onNewThreadStartInEnvironmentChange: () => {},
      onRefreshNewThreadStartInEnvironments: async () => {},
      onOpenNewThreadLocalEnvironmentsSettings: () => {},
      onOpenThread: input.onOpenThread,
    },
    { ...input.hostActions, ...agent.actions },
  );
  return (
    <ConversationRuntimeContext value={agent.runtime}>
      <ConnectedThreadStage
        presentation="panel"
        sideChatContext={{ parentThreadId: input.parentThreadId, tabTitle: input.title }}
        provider={agent.provider}
        projectId={session.projectId}
        composerScopeIdentity={`side-chat-session:${session.id}`}
        projectWorkspacePath={projectWorkspaceRootOrNull(input.project)}
        isNewThreadTab={false}
        newThreadTarget={null}
        sessionId={session.id}
        newThreadProjectSelector={null}
        newThreadStartInSelector={null}
        threadStartProgress={null}
        activeThreadId={summary?.threadId ?? null}
        activeThreadSummary={summary}
        availableModels={agent.models}
        collaborationModes={agent.modes}
        selectedCollaborationMode={agent.selectedMode}
        selectedModel={agent.selectedModel}
        selectedReasoningEffort={agent.selectedEffort}
        reasoningEffortOptions={agent.reasoningEffortOptions}
        isQueueingEnabled={false}
        composerEnterBehavior={input.composerEnterBehavior}
        searchOpenTick={0}
        summaryPanelMounted={false}
        summaryPanelOpen={false}
        summaryPanelHideImmediately={false}
        turnDiffHoverPreviewDisabled={input.turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </ConversationRuntimeContext>
  );
}

/**
 * The overview observes only task metadata, independently of transcript ownership. Task
 * events patch the loaded pages in place; a delivery gap or Runtime restart attaches again.
 */
export function AgentRuntimeSubagentsOverviewPanel(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly onSelect: (subagent: ThreadOpenSubagentPayload) => void;
}) {
  const [state, setState] = useState<{
    source: AgentSubagentOverview | null;
    error: string | null;
    /** Advances when a report leaves the section totals to a re-read. */
    recount: number;
  }>({ source: null, error: null, recount: 0 });
  const approvalThreads = useQuery(
    agentRuntimeSubagentApprovalsQueryOptions(input.sessionId, input.threadId, state.source),
  ).data;
  const [attachment, setAttachment] = useState(0);
  const isCurrentAttachment = useEffectEvent(
    (requestAttachment: number) => requestAttachment === attachment,
  );
  const loadingMore = useRef(new Set<"active" | "terminal">());
  const reports = useRef(0);
  const connection = useAgentRuntimeConnectionState();
  const readyGeneration = connection.status === "ready" ? connection.generation : null;
  const stopping = useSyncExternalStore(
    agentRuntimeDelegatedTasks.subscribe,
    agentRuntimeDelegatedTasks.readStopping,
  );
  const retryFailedAttachment = useEffectEvent(() => {
    if (state.error === null) return;
    setState((current) => ({ ...current, error: null }));
    setAttachment((current) => current + 1);
  });
  // A replacement Runtime process has no memory of earlier subscriptions; attach again.
  const attachedGeneration = useRef<string | null>(null);
  useEffect(() => {
    if (readyGeneration === null) return;
    const previous = attachedGeneration.current;
    attachedGeneration.current = readyGeneration;
    if (previous !== null && previous !== readyGeneration) setAttachment((current) => current + 1);
    // The same process answered again; what failed while it could not gets another try.
    else retryFailedAttachment();
  }, [readyGeneration]);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    // Events that race the initial read are applied after it, newest report winning.
    let pending: AgentRuntimeTaskRecord[] | null = [];
    const fail = (cause: unknown) => {
      if (active)
        setState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
    };
    void agentRuntimeRuntime
      .subscribe(
        { sessionId: input.sessionId, threadId: input.threadId, eventTypes: ["subagent.updated"] },
        (notification) => {
          if (!active || !isCurrentAttachment(attachment)) return;
          if (notification.type === "reset-required") {
            active = false;
            release?.();
            release = undefined;
            setAttachment((current) => current + 1);
            return;
          }
          if (notification.event.event.type !== "subagent.updated") return;
          reports.current += 1;
          const task = notification.event.event.payload;
          if (pending) pending.push(task);
          else
            setState((current) =>
              current.source
                ? {
                    ...current,
                    source: applyAgentRuntimeOverviewTask(current.source, task),
                    recount:
                      current.recount +
                      Number(agentRuntimeOverviewTotalsUnknown(current.source, task)),
                  }
                : current,
            );
        },
      )
      .then(async (unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        release = unsubscribe;
        const read = await agentRuntimeRuntime.overview({
          sessionId: input.sessionId,
          threadId: input.threadId,
        });
        if (!active) return;
        let source = read;
        let recount = false;
        for (const task of pending ?? []) {
          recount = recount || agentRuntimeOverviewTotalsUnknown(source, task);
          source = applyAgentRuntimeOverviewTask(source, task);
        }
        pending = null;
        setState((current) => ({
          source,
          error: null,
          recount: current.recount + Number(recount),
        }));
      })
      .catch(fail);
    return () => {
      active = false;
      release?.();
    };
  }, [input.sessionId, input.threadId, attachment]);
  // Bursts of reports share one re-read; its totals replace the patched ones.
  useEffect(() => {
    if (state.recount === 0) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const reportsBeforeRead = reports.current;
      void agentRuntimeRuntime
        .overview({ sessionId: input.sessionId, threadId: input.threadId })
        .then((read) => {
          if (!active) return;
          // A report that landed during the read may be missing from it, so that read isn't final.
          const superseded = Number(reports.current !== reportsBeforeRead);
          setState((current) =>
            current.source
              ? {
                  ...current,
                  source: reconcileAgentRuntimeOverview(current.source, read),
                  recount: current.recount + superseded,
                }
              : current,
          );
        })
        .catch(() => {});
    }, 100);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [input.sessionId, input.threadId, state.recount]);
  useEffect(() => {
    for (const task of state.source?.terminal.items ?? [])
      agentRuntimeDelegatedTasks.settle(input.sessionId, task.id);
  }, [input.sessionId, state.source]);
  const loadMore = async (section: "active" | "done") => {
    const key = section === "active" ? "active" : "terminal";
    const cursor = state.source?.[key].nextCursor;
    if (!cursor || loadingMore.current.has(key)) return;
    loadingMore.current.add(key);
    await runWithCleanup(
      async () => {
        const page = await agentRuntimeRuntime.overview({
          sessionId: input.sessionId,
          threadId: input.threadId,
          ...(key === "active" ? { activeCursor: cursor } : { terminalCursor: cursor }),
        });
        setState((current) =>
          current.source
            ? {
                ...current,
                source: appendAgentRuntimeOverviewPage(current.source, page, key),
                error: null,
              }
            : current,
        );
      },
      {
        onError: (cause) => {
          setState((current) => ({
            ...current,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
        },
        cleanup: () => {
          loadingMore.current.delete(key);
        },
      },
    );
  };
  const shownWindow = useRef<AgentRuntimeOverviewWindow>({ active: 0, terminal: 0 });
  const refill = useEffectEvent((source: AgentSubagentOverview | null) => {
    if (!source) {
      shownWindow.current = { active: 0, terminal: 0 };
      return;
    }
    for (const section of agentRuntimeOverviewSectionsToRefill(source, shownWindow.current))
      void loadMore(section === "active" ? "active" : "done");
    shownWindow.current = agentRuntimeOverviewWindow(shownWindow.current, source);
  });
  useEffect(() => refill(state.source), [state.source]);
  const error = state.error ? (
    <div
      role="alert"
      className="flex items-center gap-2 px-5 pt-4 text-sm text-token-text-secondary"
    >
      <span className="min-w-0 flex-1">{state.error}</span>
      <button
        type="button"
        className="shrink-0 cursor-interaction rounded-md px-1 text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => {
          setState((current) => ({ ...current, error: null }));
          setAttachment((current) => current + 1);
        }}
      >
        Retry
      </button>
    </div>
  ) : null;
  if (!state.source)
    return (
      error ?? (
        <div role="status" className="p-4 text-sm text-token-text-tertiary">
          Loading subagents…
        </div>
      )
    );
  const source = state.source;
  const taskForRow = (row: CodexSubagentOverviewRow) =>
    source.active.items.find((task) => (task.childThreadId ?? task.id) === row.threadId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error}
      <div className="min-h-0 flex-1">
        <SubagentsPanelOverviewContent
          rootThreadId={input.threadId}
          overview={projectAgentRuntimeSubagentOverview(input.threadId, source, approvalThreads)}
          onSelect={(row) => input.onSelect(projectSubagentOverviewRowToOpenPayload(row))}
          isStopping={(row) => {
            const task = taskForRow(row);
            return (
              task !== undefined && isAgentRuntimeTaskStopping(stopping, input.sessionId, task.id)
            );
          }}
          onStop={(row) => {
            const task = taskForRow(row);
            if (!task) return;
            void requestAgentRuntimeTaskStop(
              input.sessionId,
              {
                taskId: task.id,
                parentThreadId: task.threadId,
                ownerRunId: task.runId,
                childThreadId: task.childThreadId,
              },
              agentRuntimeRuntime,
            ).catch((cause: unknown) =>
              setState((current) => ({
                ...current,
                error: cause instanceof Error ? cause.message : String(cause),
              })),
            );
          }}
          onLoadMore={(section) => void loadMore(section)}
        />
      </div>
    </div>
  );
}
