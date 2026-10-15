import { ConnectedThreadStage, type ThreadStageActions } from "@/features/local-conversation";
import { ConversationRuntimeContext } from "@/features/local-conversation/conversation-runtime";
import { useAgentRuntimeConversationAdapter } from "@/features/local-conversation/agent-runtime-conversation-adapter";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { composeNativeThreadStageActions } from "@/features/local-conversation/native-thread-stage-actions";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";
import type { Project, ProjectSession, CodexComposerIntent } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import {
  readCurrentProjectSessionDetail,
  seedProjectSessionDetail,
} from "@/lib/project-session-query-cache";
import { toast } from "@/components/ui/toast";
import type { FirstSubmissionIdentity } from "@/features/conversation-launch/session-first-submission-owner";
import type { AgentSubagentOverview } from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import {
  appendAgentRuntimeOverviewPage,
  projectAgentRuntimeSubagentOverview,
} from "@/features/local-conversation/agent-runtime-subagent-overview";
import { SubagentsPanelOverviewContent } from "@/features/local-conversation/view/subagents-panel/subagents-panel";
import { projectSubagentOverviewRowToOpenPayload } from "./workbench-subagent-status";
import type { ThreadOpenSubagentPayload } from "@/features/local-conversation/thread-stage-types";
import { createUuidV7 } from "../../../shared/uuid-v7";

/** A child keeps its product Session and reads only its own bounded engine history. */
export function AgentRuntimeChildPanel(input: {
  readonly session: WorkbenchSessionRenderProjection;
  readonly threadId: string;
  readonly title: string;
  readonly project: Project | null;
  readonly canInteract: boolean;
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
  return (
    <ConversationRuntimeContext value={agent.runtime}>
      <ConnectedThreadStage
        presentation="panel"
        provider={agent.provider}
        projectId={input.session.projectId}
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
        summaryPanelContentShift={0}
        turnDiffHoverPreviewDisabled={input.turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </ConversationRuntimeContext>
  );
}

/** Side chat drafts have their own Core Session and use ordinary launch defaults. */
export function AgentRuntimeSideChatPanel(input: {
  readonly session: ProjectSession;
  readonly parentThreadId: string;
  readonly title: string;
  readonly project: Project | null;
  readonly draft: CodexComposerIntent | null;
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
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    ...projectSessionDetailQueryOptions(input.session.id),
    initialData: input.session,
  });
  const session = sessionQuery.data ?? input.session;
  const [draft, setDraft] = useState(input.draft);
  const agent: ReturnType<typeof useAgentRuntimeConversationAdapter> =
    useAgentRuntimeConversationAdapter({
      sessionId: session.id,
      sessionTitle: input.title,
      workspaceRoot: projectWorkspaceRootOrNull(input.project),
      executionRef: session.executionRef,
      projectId: session.projectId,
      modelProjectId: session.projectId,
      instances: instances.instances,
      onRefresh: input.onRefresh,
      onOpenThread: input.onOpenThread,
      onLaunched: async (result) => {
        const current = await readCurrentProjectSessionDetail(result.sessionId);
        if (current?.executionRef?.threadId !== result.threadId)
          throw new Error("The side chat execution binding changed");
        seedProjectSessionDetail(queryClient, current);
        setDraft(null);
      },
      ensureDraft: async () => session,
    });
  const summary = agent.summary;
  const startedInitialSubmission = useRef<string | null>(null);
  const submitInitialPrompt = useEffectEvent(async () => {
    try {
      await agent.actions.onStartThreadForSession?.({
        projectId: session.projectId,
        sessionId: session.id,
        prompt: input.draft?.prompt ?? "",
        promptInput: input.draft?.promptInput,
        submissionIdentity: input.initialSubmission,
        presentationTicket: input.initialSubmission?.presentationTicket,
        runInTarget: "localProject",
      });
    } catch (cause) {
      toast.danger(cause instanceof Error ? cause.message : "The side chat could not start.", {
        id: `side-chat-submit:${session.id}`,
      });
    }
  });
  useEffect(() => {
    const identity = input.initialSubmission;
    if (!identity || session.executionRef || !agent.models.length || !agent.selectedModel) return;
    if (startedInitialSubmission.current === identity.launchId) return;
    startedInitialSubmission.current = identity.launchId;
    void submitInitialPrompt();
  }, [input.initialSubmission, session.executionRef, agent.models.length, agent.selectedModel]);
  const actions = composeNativeThreadStageActions(
    {
      onQueueingEnabledChange: input.hostActions.onQueueingEnabledChange ?? (() => {}),
      onNewThreadProjectChange: () => {},
      onRequestNewChatProjectCreate: () => {},
      onNewThreadStartInTargetChange: () => {},
      onNewThreadStartInEnvironmentChange: () => {},
      onRefreshNewThreadStartInEnvironments: async () => {},
      onOpenNewThreadLocalEnvironmentsSettings: () => {},
      onConsumeNewThreadComposerIntent: () => setDraft(null),
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
        isNewThreadTab={!summary}
        newThreadTarget={
          summary
            ? null
            : {
                projectId: session.projectId,
                projectName: input.project?.name ?? "No project",
                sessionId: session.id,
                threadTitle: input.title,
                runInTarget: "localProject",
              }
        }
        newThreadComposerIntent={summary ? null : draft}
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
        summaryPanelContentShift={0}
        turnDiffHoverPreviewDisabled={input.turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </ConversationRuntimeContext>
  );
}

/** The overview observes only task metadata, independently of transcript ownership. */
export function AgentRuntimeSubagentsOverviewPanel(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly onSelect: (subagent: ThreadOpenSubagentPayload) => void;
}) {
  const [state, setState] = useState<{
    source: AgentSubagentOverview | null;
    error: string | null;
  }>({ source: null, error: null });
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    let loading = false;
    let pending = false;
    const refresh = async () => {
      pending = true;
      if (loading) return;
      loading = true;
      try {
        while (pending) {
          if (!active) return;
          pending = false;
          const source = await agentRuntimeRuntime.overview({
            sessionId: input.sessionId,
            threadId: input.threadId,
          });
          if (active) setState({ source, error: null });
        }
      } catch (cause) {
        if (active)
          setState({ source: null, error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        loading = false;
      }
    };
    void agentRuntimeRuntime
      .subscribe(
        { sessionId: input.sessionId, threadId: input.threadId, eventTypes: ["subagent.updated"] },
        () => void refresh(),
      )
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        release = unsubscribe;
        return refresh();
      })
      .catch((cause: unknown) => {
        if (active)
          setState({ source: null, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      active = false;
      release?.();
    };
  }, [input.sessionId, input.threadId]);
  const loadMore = async (section: "active" | "done") => {
    const key = section === "active" ? "active" : "terminal";
    const source = state.source;
    const cursor = source?.[key].nextCursor;
    if (!source || !cursor) return;
    try {
      const next = await agentRuntimeRuntime.overview({
        sessionId: input.sessionId,
        threadId: input.threadId,
        ...(key === "active" ? { activeCursor: cursor } : { terminalCursor: cursor }),
      });
      setState((current) =>
        current.source === source
          ? { source: appendAgentRuntimeOverviewPage(source, next, key), error: null }
          : current,
      );
    } catch (cause) {
      setState((current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  };
  if (state.error)
    return (
      <div role="alert" className="p-4 text-sm text-token-text-secondary">
        {state.error}
      </div>
    );
  if (!state.source)
    return (
      <div role="status" className="p-4 text-sm text-token-text-tertiary">
        Loading subagents…
      </div>
    );
  return (
    <SubagentsPanelOverviewContent
      rootThreadId={input.threadId}
      overview={projectAgentRuntimeSubagentOverview(input.threadId, state.source)}
      onSelect={(row) => input.onSelect(projectSubagentOverviewRowToOpenPayload(row))}
      stoppingTaskId={stoppingTaskId}
      onStop={(row) => {
        const task = state.source?.active.items.find(
          (task) =>
            task.id === row.threadId &&
            task.origin === "provider_native" &&
            task.childThreadId === null,
        );
        if (!task?.runId) return;
        setStoppingTaskId(task.id);
        void agentRuntimeRuntime
          .stopTask({
            sessionId: input.sessionId,
            threadId: input.threadId,
            requestId: createUuidV7(),
            runId: task.runId,
            taskId: task.id,
          })
          .catch((cause: unknown) =>
            setState((current) => ({
              ...current,
              error: cause instanceof Error ? cause.message : String(cause),
            })),
          )
          .finally(() => setStoppingTaskId(null));
      }}
      onLoadMore={(section) => void loadMore(section)}
    />
  );
}
