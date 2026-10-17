import { agentRuntimeDraftOwner } from "./agent-runtime-draft-owner";
import { toast } from "@/components/ui/toast";
import { nativeIntelligenceIntentOwner } from "../../lib/native-intelligence-intent-owner";
import { isClaudeEffortLevel, type ClaudeModelSelection } from "../../../shared/claude-models";
import {
  applyRuntimeClaudeIntent,
  readRuntimeClaudeSelection,
  resolveRuntimeClaudeIntent,
  runtimeClaudeModelOption,
} from "./agent-runtime-model-intent";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeMessage,
  AgentRuntimeSessionTarget,
} from "../../../shared/agent-runtime-api";
import {
  agentRuntimeModelSelection,
  agentRuntimeProviderId,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
} from "../../../shared/agent-runtime-provider";
import { useCodexThreadSettings } from "../../lib/use-codex-thread-settings";
import { CodexReasoningEffortSchema } from "../../../shared/schemas/codex";
import { useCodexServiceTierSettings } from "../../lib/use-codex-service-tier-settings";
import { prepareAgentMessage } from "../../../shared/agent-prompt";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type {
  CodexCollaborationModePreset,
  CodexThreadSummary,
  CodexPromptInput,
  CodexConnectionState,
} from "../../../shared/types";
import { readPastedTextAttachment } from "../../lib/api";
import {
  agentRuntimeRuntime,
  type AgentRuntimeRendererTransport,
} from "../../lib/agent-runtime-runtime";
import { agentRuntimePromptImages } from "../../lib/agent-runtime-prompt";
import { workspaceSessionCommands } from "../../lib/workspace-catalog-commands";
import {
  acquireAgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwnerSnapshot,
} from "./agent-runtime-conversation-owner";
import type { ConversationRuntime } from "./conversation-runtime";
import type { ThreadStageActions, ConversationProviderPresentation } from "./thread-stage-types";
import type { AgentModelPickerEntry } from "../../components/shared/agent-runtime/agent-model-picker";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import {
  setLocalConversationComposerIntent,
  setLocalConversationThreadPresented,
} from "./local-conversation-store";
import { copyAgentRuntimeConversationMarkdown } from "./agent-runtime-markdown-export";
import {
  agentRuntimeDelegatedTasks,
  createAgentRuntimeDelegatedTaskPort,
  stopAgentRuntimeBackgroundTasks,
} from "./agent-runtime-delegated-tasks";
import { agentRuntimeBackgroundStatus } from "./agent-runtime-composer-status";
import { useOpenCodeModelSetup } from "../opencode-setup/use-opencode-setup";
import {
  agentRuntimeActivityStore,
  useAgentRuntimeConnectionState,
  useAgentRuntimeSessionActivity,
} from "../../lib/agent-runtime-session-activity";
import { useWorkbenchWindowOwner } from "../../lib/use-workbench-window-state";
import {
  captureCodexTurnPresentation,
  readCodexSubmissionPresentation,
} from "../../lib/codex-turn-presentation";
import type {
  CodexTurnPresentationTarget,
  CodexTurnPresentationTicket,
} from "../../../shared/nodex-app-tools/turn-presentation";
import type { WorkbenchSubmitPresentation } from "../../../shared/nodex-app-tools/workbench";

export type AgentRuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];
const emptyState: AgentRuntimeConversationOwnerSnapshot = {
  conversation: null,
  view: null,
  connection: "connecting",
  error: null,
  historyLoading: false,
};
const emptySubscribe = () => () => {};
const emptyRead = () => emptyState;
const connected = { status: "connected", retries: 0 } as const;
const starting = { status: "starting", retries: 0 } as const;
const connectionViews = new WeakMap<AgentRuntimeConnectionState, CodexConnectionState>();

/**
 * The latest Run failed while its workspace was being prepared: it records a preparation
 * strategy and never started. Returns its id so the user can retry or work locally.
 */
export function failedWorkspacePreparation(
  runs: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly startedAt?: string | null;
    readonly workspacePreparation?: unknown;
  }[],
): string | null {
  const latest = runs.reduce<(typeof runs)[number] | null>(
    (best, run) => (best === null || run.ordinal > best.ordinal ? run : best),
    null,
  );
  return latest?.status === "failed" && latest.workspacePreparation && !latest.startedAt
    ? latest.id
    : null;
}

/** One supervised execution process serves every Runtime chat; an idle process starts on use. */
export function projectAgentRuntimeConnection(
  state: AgentRuntimeConnectionState,
): CodexConnectionState {
  if (state.status === "idle" || state.status === "ready") return connected;
  if (state.status === "starting") return starting;
  const cached = connectionViews.get(state);
  if (cached) return cached;
  const view: CodexConnectionState =
    state.status === "restarting"
      ? { status: "disconnected", retries: state.attempt, message: "Agent execution is restarting" }
      : { status: "error", retries: 0, message: state.message };
  connectionViews.set(state, view);
  return view;
}
const emptyChildren = [] as const;
const runtimePorts = new WeakMap<
  AgentRuntimeConversationOwner,
  Map<AgentBackendBinding["kind"], ConversationRuntime>
>();

/** A product view over the engine read owner. Session identity remains the command boundary. */
export function createAgentRuntimeConversationRuntime(
  kind: AgentBackendBinding["kind"],
  target: AgentRuntimeSessionTarget | null,
  owner: AgentRuntimeConversationOwner | null,
): ConversationRuntime {
  const ports = owner
    ? (runtimePorts.get(owner) ?? new Map<AgentBackendBinding["kind"], ConversationRuntime>())
    : null;
  const previous = ports?.get(kind);
  if (previous) return previous;
  const matches = (id: string | null) => owner !== null && id === owner.threadId;
  const runtime: ConversationRuntime = {
    kind,
    hostId: "local",
    sessionId: target?.sessionId,
    read: (id) => (matches(id) ? owner!.getSnapshot().view : null),
    subscribe: (_id, listener) => {
      const releaseOwner = owner?.subscribe(listener) ?? (() => {});
      const releaseConnection = agentRuntimeActivityStore.subscribeConnection(listener);
      return () => {
        releaseOwner();
        releaseConnection();
      };
    },
    subscribeChildObservations: (_id, listener) => owner?.subscribe(listener) ?? (() => {}),
    transcriptReadOwner: (id) => (matches(id) ? owner!.readOwner : null),
    contentSource: (id) => (matches(id) ? owner!.contentSource() : null),
    attachment: (id) => {
      if (!matches(id)) return { status: "idle" };
      const state = owner!.getSnapshot();
      if (state.connection === "failed")
        return { status: "failed", message: state.error ?? "Could not open conversation" };
      return state.connection === "ready" ? { status: "attached" } : { status: "attaching" };
    },
    connection: () => projectAgentRuntimeConnection(agentRuntimeActivityStore.readConnection()),
    role: (id) => (matches(id) ? "follower" : null),
    ...(target
      ? {
          delegatedTasks: createAgentRuntimeDelegatedTaskPort(
            target.sessionId,
            agentRuntimeRuntime,
          ),
        }
      : {}),
    ...(target && owner
      ? {
          asyncQuestions: {
            runtime: owner.asyncQuestions,
            // Each question's request receives its answers; the Agent decides how they arrive.
            deliver: async (turnId, replies) => {
              const requests = owner.asyncQuestionAnswers(replies);
              if (requests.length === 0) return null;
              for (const request of requests)
                await agentRuntimeRuntime.respond({
                  ...target,
                  threadId: owner.threadId,
                  ...request,
                });
              return { turnId };
            },
          },
        }
      : {}),
    primaryRequest: (id) => (matches(id) ? (owner!.getSnapshot().view?.requests[0] ?? null) : null),
    children: (id) => (matches(id) ? owner!.children() : emptyChildren),
    retain: () => owner?.retain() ?? (() => {}),
    readItemDetail: async (id, itemId) => {
      if (matches(id)) await owner!.readItem(itemId);
    },
    resume: async () => {
      await owner?.resume();
    },
    markRead: async () => {
      if (target) await workspaceSessionCommands.markUnread(target.sessionId, { unread: false });
    },
    // Main's unread and notification policy reads the same presentation registry as native chats.
    setPresented: async (id, surfaceId, presented) => {
      if (matches(id)) await setLocalConversationThreadPresented(id, surfaceId, presented, "local");
    },
  };
  if (owner && ports) {
    ports.set(kind, runtime);
    runtimePorts.set(owner, ports);
  }
  return runtime;
}

/**
 * A new Codex chat starts from the user's saved model, effort and speed when the catalog
 * offers them, then from the catalog default.
 */
export function seedAgentRuntimeCodexSelection(
  provider: AgentRuntimeProvider | undefined,
  saved: {
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly serviceTier?: string | null;
  },
): AgentModelSelection | null {
  if (!provider || !isAgentRuntimeProviderAvailable(provider)) return null;
  const model =
    provider.models.find((entry) => entry.slug === saved.model) ??
    provider.models.find((entry) => entry.isDefault) ??
    provider.models[0];
  if (!model) return null;
  const options = applyAgentRuntimeOptionIntent(
    model.capabilities?.optionDescriptors ?? [],
    undefined,
    {
      ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
      ...(saved.serviceTier !== undefined ? { serviceTier: saved.serviceTier } : {}),
    },
  );
  return {
    binding: { kind: "codex" },
    model: model.slug,
    ...(options.length > 0 ? { options } : {}),
  };
}

export const isAgentRuntimeProviderAvailable = (provider: AgentRuntimeProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled";

/** The configured Agent name the user chose, then the provider's own name. */
export function agentRuntimeProviderLabel(
  provider: Pick<AgentRuntimeProvider, "instanceId" | "displayName">,
  instances: readonly { readonly binding: AgentBackendBinding; readonly label: string }[],
): string {
  return (
    instances.find((entry) => agentRuntimeProviderId(entry.binding) === provider.instanceId)
      ?.label ??
    provider.displayName ??
    (provider.instanceId === "codex" ? "Codex" : "Agent")
  );
}

export function projectAgentRuntimeModel(
  provider: AgentRuntimeProvider,
  model: AgentRuntimeProvider["models"][number],
): AgentModelPickerEntry["model"] {
  const effort = model.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && /effort|reasoning/i.test(option.id),
  );
  const choices = effort?.type === "select" ? effort.options : [];
  return {
    id: model.slug,
    model: model.slug,
    displayName: model.name,
    description: model.name,
    hidden: false,
    supportedReasoningEfforts: choices.map((option) => ({
      reasoningEffort: option.id,
      description: option.description ?? option.label,
    })),
    defaultReasoningEffort:
      effort?.type === "select"
        ? (effort.currentValue ?? choices.find((option) => option.isDefault)?.id ?? "default")
        : "default",
    inputModalities: ["text", "image"],
    isDefault: model.isDefault ?? false,
  };
}

/** Shared editor controls address the exact Session/Thread/Run observed by the read owner. */
export function createAgentRuntimeStageActions(input: {
  readonly target: () => AgentRuntimeSessionTarget | null;
  readonly owner: () =>
    | (Pick<
        AgentRuntimeConversationOwner,
        "getSnapshot" | "nextQueuePage" | "previousQueuePage" | "queueBoundary" | "readQueuedInput"
      > &
        Partial<Pick<AgentRuntimeConversationOwner, "contentSource">>)
    | null;
  readonly transport?: AgentRuntimeRendererTransport;
  readonly prepare: (
    text: string,
    promptInput?: CodexPromptInput,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
  ) => Promise<Pick<AgentRuntimeMessage, "text" | "context">>;
  readonly capturePresentation?: (
    target: CodexTurnPresentationTarget,
    submitted?: WorkbenchSubmitPresentation,
  ) => Promise<CodexTurnPresentationTicket | undefined>;
  readonly readPresentation?: () => WorkbenchSubmitPresentation;
  readonly openFork?: (
    result: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult,
  ) => Promise<void>;
}): Partial<ThreadStageActions> {
  const transport = input.transport ?? agentRuntimeRuntime;
  const requireTarget = () => {
    const target = input.target();
    if (!target) throw new Error("Open a conversation before sending a message");
    return target;
  };
  const dispatch = async (
    text: string,
    promptInput?: CodexPromptInput,
    intent?: "steer",
    submitted?: WorkbenchSubmitPresentation,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
  ) => {
    const target = requireTarget();
    const messageId = createUuidV7();
    const presentationTicket = target.threadId
      ? await input.capturePresentation?.({ kind: "thread", threadId: target.threadId }, submitted)
      : undefined;
    const prepared = await input.prepare(text, promptInput, appMessage);
    await transport.message({
      ...target,
      presentationTicket,
      message: {
        messageId,
        ...prepared,
        images: agentRuntimePromptImages(promptInput, appMessage),
        ...(promptInput ? { agentConfigs: promptInput.agentConfigs ?? [] } : {}),
      },
      ...(intent ? { intent } : {}),
    });
  };
  const respond = async (
    requestId: string | number,
    response: Pick<Parameters<AgentRuntimeRendererTransport["respond"]>[0], "decision" | "answers">,
  ) => {
    const target = requireTarget();
    const request = input
      .owner()
      ?.getSnapshot()
      .view?.requests.find((entry) => String(entry.requestId) === String(requestId));
    if (!request) throw new Error("This request is no longer pending");
    await transport.respond({
      ...target,
      requestId: String(requestId),
      runId: request.turnId,
      ...response,
    });
  };
  const exactTarget = (threadId: string) => {
    const target = requireTarget();
    if (target.threadId !== undefined && target.threadId !== threadId)
      throw new Error("Conversation identity changed");
    return target;
  };
  const queuedMessage = async (
    threadId: string,
    prompt: string,
    promptInput?: CodexPromptInput,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
  ) => {
    const target = exactTarget(threadId);
    const owner = input.owner();
    const lease = owner?.contentSource?.();
    const assertCurrent = () => {
      const current = exactTarget(threadId);
      if (
        current.sessionId !== target.sessionId ||
        input.owner() !== owner ||
        (lease && !lease.isCurrent())
      )
        throw new Error("Conversation source changed");
    };
    const messageId = createUuidV7();
    const presentationTicket = await input.capturePresentation?.({ kind: "thread", threadId });
    const prepared = await input.prepare(prompt, promptInput, appMessage);
    assertCurrent();
    await transport.queueMessage({
      ...target,
      presentationTicket,
      message: {
        messageId,
        ...prepared,
        images: agentRuntimePromptImages(promptInput, appMessage),
        ...(promptInput ? { agentConfigs: promptInput.agentConfigs ?? [] } : {}),
      },
    });
  };
  const editQueuedMessage = async (
    threadId: string,
    runId: string,
    prompt: string,
    promptInput?: CodexPromptInput,
  ) => {
    const target = exactTarget(threadId);
    const queued = input
      .owner()
      ?.getSnapshot()
      .view?.queuedFollowUps?.entries.find((entry) => entry.followUpId === runId);
    if (!queued) throw new Error("This queued message is no longer pending");
    const presentationTicket = await input.capturePresentation?.({ kind: "thread", threadId });
    await transport.queue({
      ...target,
      requestId: createUuidV7(),
      action: "edit",
      presentationTicket,
      runId,
      message: {
        messageId: queued.clientUserMessageId,
        ...(await input.prepare(prompt, promptInput)),
        images: agentRuntimePromptImages(promptInput),
        ...(promptInput ? { agentConfigs: promptInput.agentConfigs ?? [] } : {}),
      },
    });
  };
  return {
    onCopyConversationMarkdown: async () => {
      const view = input.owner()?.getSnapshot().view;
      await copyAgentRuntimeConversationMarkdown(
        requireTarget(),
        view?.threadName ?? "Nodex conversation",
        view?.cwd ?? null,
        transport,
      );
    },
    onNextQueuedFollowUpPage: async () => {
      await input.owner()?.nextQueuePage();
    },
    onPreviousQueuedFollowUpPage: async () => {
      await input.owner()?.previousQueuePage();
    },
    onCompactThread: async (threadId) => {
      const target = requireTarget();
      if (target.threadId !== undefined && target.threadId !== threadId)
        throw new Error("Conversation identity changed");
      await transport.compact({ ...target, requestId: createUuidV7() });
    },
    onSendPrompt: (text, options) =>
      dispatch(
        text,
        options?.promptInput,
        undefined,
        options?.submittedPresentation,
        options?.untrustedAppMessage,
      ),
    onEditLastUserTurn: async (request) => {
      const target = exactTarget(request.threadId);
      await transport.rollback({ ...target, requestId: createUuidV7(), runId: request.turnId });
      await dispatch(request.message);
    },
    onEnqueueQueuedFollowUp: (threadId, prompt, options) =>
      queuedMessage(threadId, prompt, options?.promptInput, options?.untrustedAppMessage),
    onSendCapturedFollowUp: (threadId, prompt, options) =>
      queuedMessage(threadId, prompt, options?.promptInput, options?.untrustedAppMessage),
    onRemoveQueuedFollowUp: async (threadId, runId) => {
      await transport.queue({
        ...exactTarget(threadId),
        requestId: createUuidV7(),
        action: "cancel",
        runId,
      });
    },
    onReorderQueuedFollowUps: async (threadId, orderedRunIds) => {
      await transport.queue({
        ...exactTarget(threadId),
        requestId: createUuidV7(),
        action: "reorder",
        orderedRunIds,
        beforeRunId: input.owner()?.queueBoundary() ?? null,
      });
    },
    onResumeQueuedFollowUps: async (threadId) => {
      await transport.queue({
        ...exactTarget(threadId),
        requestId: createUuidV7(),
        action: "resume",
      });
    },
    onReplaceQueuedFollowUp: async (threadId, runId, _revision, prompt, options) => {
      await editQueuedMessage(threadId, runId, prompt, options?.promptInput);
      return true;
    },
    onEditQueuedFollowUp: async (request) => {
      exactTarget(request.threadId);
      const queued = input
        .owner()
        ?.getSnapshot()
        .view?.queuedFollowUps?.entries.find((entry) => entry.followUpId === request.followUpId);
      if (!queued) throw new Error("This queued message is no longer pending");
      const owner = input.owner();
      if (!owner) throw new Error("Open the conversation before editing this message");
      const queuedInput = await owner.readQueuedInput(request.followUpId);
      setLocalConversationComposerIntent(request.threadId, {
        prompt: queuedInput.text,
        promptInput: { ...request.promptInput, ...queuedInput },
        queuedFollowUpEdit: {
          followUpId: request.followUpId,
          ledgerRevision: request.ledgerRevision ?? 0,
        },
        focusNonce: Date.now(),
      });
    },
    onSendQueuedFollowUpNow: async (threadId, runId) => {
      const target = exactTarget(threadId);
      const activeRun = input
        .owner()
        ?.getSnapshot()
        .conversation?.snapshot.projection.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
      // An idle chat sends exactly this message now; the queue continues behind it.
      if (!activeRun) {
        await transport.queue({ ...target, requestId: createUuidV7(), action: "resume", runId });
        return;
      }
      await transport.queue({
        ...target,
        requestId: createUuidV7(),
        action: "steer",
        runId,
        targetRunId: activeRun.id,
      });
    },
    ...(input.openFork
      ? {
          onForkFromTurn: async (request: {
            threadId: string;
            turnId: string;
            message: string;
          }) => {
            const source = exactTarget(request.threadId);
            const submittedPresentation = input.readPresentation?.();
            const result = await transport.fork({
              source,
              sessionId: createUuidV7(),
              requestId: createUuidV7(),
              acceptedAt: Date.now(),
              environment: "same-directory",
              sourceRunId: request.turnId,
            });
            if (request.message.trim()) {
              const presentationTicket = await input.capturePresentation?.(
                { kind: "thread", threadId: result.threadId },
                submittedPresentation,
              );
              await transport.message({
                sessionId: result.sessionId,
                threadId: result.threadId,
                presentationTicket,
                message: { messageId: createUuidV7(), text: request.message },
              });
            }
            await input.openFork!(result);
          },
        }
      : {}),
    onSteerPrompt: ({ prompt, promptInput }) => dispatch(prompt, promptInput, "steer"),
    onInterruptTurn: async (runId) => {
      const target = requireTarget();
      const runs = input.owner()?.getSnapshot().conversation?.snapshot.projection.runs ?? [];
      const run = runs
        .filter((value) => ["preparing", "starting", "running", "waiting"].includes(value.status))
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      const selected = runId ?? run?.id;
      if (selected) await transport.stop({ ...target, runId: selected });
    },
    onRespondUserInput: (id, answers) =>
      respond(id, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, values]) => [key, values.join("\n")]),
        ),
      }),
  };
}

export function useAgentRuntimeConversationAdapter(input: {
  readonly sessionId: string;
  readonly sessionTitle?: string;
  readonly workspaceRoot?: string | null;
  readonly executionRef?: { readonly runtimeId: string; readonly threadId: string } | null;
  /** A child uses its root Session binding and a distinct engine Thread. */
  readonly threadId?: string;
  readonly projectId: string | null;
  readonly modelProjectId: string | null;
  readonly instances: readonly {
    readonly binding: AgentBackendBinding;
    readonly label: string;
    readonly enabled: boolean;
    readonly usesHostExecutable?: boolean;
  }[];
  readonly onRefresh: (projectId: string | null) => Promise<unknown>;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  readonly onLaunched?: (
    result: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult,
  ) => Promise<void>;
  readonly ensureDraft: (projectId: string | null) => Promise<{ readonly id: string }>;
  readonly materializeDraft?: import("./thread-stage-types").SessionThreadCommands["onMaterializeProjectDraft"];
  readonly commitDraft?: import("./thread-stage-types").SessionThreadCommands["onCommitMaterializedProjectDraft"];
}) {
  const workbenchOwner = useWorkbenchWindowOwner();
  const [catalogState, setCatalogState] = useState<{
    providers: readonly AgentRuntimeProvider[];
    loading: boolean;
    error: string | null;
  }>({ providers: [], loading: true, error: null });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const refreshCatalog = () => setCatalogRevision((value) => value + 1);
  // A newly usable host OpenCode reloads the catalog; the chosen model is never replaced.
  const openCodeSetup = useOpenCodeModelSetup({
    instances: input.instances,
    onReady: refreshCatalog,
  });
  // A first message sent while the catalog is still loading waits for it to choose a model.
  const catalogLoad = useRef<Promise<readonly AgentRuntimeProvider[]> | null>(null);
  useEffect(() => {
    let active = true;
    const load = agentRuntimeRuntime
      .catalog({ refresh: catalogRevision > 0 })
      .then((providers) =>
        providers.filter(
          (provider) =>
            provider.instanceId === "codex" ||
            input.instances.some(
              (instance) => agentRuntimeProviderId(instance.binding) === provider.instanceId,
            ),
        ),
      );
    catalogLoad.current = load;
    void load
      .then((providers) => {
        if (active) setCatalogState({ providers, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (active)
          setCatalogState({
            providers: [],
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      active = false;
    };
  }, [catalogRevision, input.instances]);
  useEffect(() => {
    agentRuntimeDelegatedTasks.publishLabels(
      new Map(
        catalogState.providers.map((provider) => [
          provider.instanceId,
          {
            label: agentRuntimeProviderLabel(provider, input.instances),
            models: new Map(provider.models.map((model) => [model.slug, model.name])),
          },
        ]),
      ),
    );
  }, [catalogState.providers, input.instances]);
  const { settings: savedCodexSettings, updateSettings: updateSavedCodexSettings } =
    useCodexThreadSettings();
  const { serviceTierSettings: savedServiceTier, setServiceTier: saveServiceTier } =
    useCodexServiceTierSettings();
  // A Codex choice becomes the starting model, effort and speed of later new chats.
  const rememberCodexChoice = (choice: AgentModelSelection) => {
    const effort = CodexReasoningEffortSchema.safeParse(
      choice.options?.find((option) => option.id === "reasoningEffort")?.value,
    );
    updateSavedCodexSettings({
      model: choice.model,
      ...(effort.success ? { reasoningEffort: effort.data } : {}),
    });
    const tier = readAgentRuntimeServiceTier(choice.options);
    if (tier !== undefined) saveServiceTier(tier, "composer_menu");
  };
  const draftKey = JSON.stringify([input.sessionId, input.modelProjectId]);
  const draft = useSyncExternalStore(
    (listener) => agentRuntimeDraftOwner.subscribe(draftKey, listener),
    () => agentRuntimeDraftOwner.read(draftKey),
  );
  const draftMode = draft.interactionMode;
  const [createdTarget, setCreatedTarget] = useState<
    (AgentRuntimeSessionTarget & { threadId: string }) | null
  >(null);
  const target = input.executionRef
    ? { sessionId: input.sessionId, threadId: input.threadId ?? input.executionRef.threadId }
    : createdTarget?.sessionId === input.sessionId
      ? createdTarget
      : null;
  const targetSessionId = target?.sessionId ?? null;
  const targetThreadId = target?.threadId ?? null;
  const acquired = useMemo(
    () =>
      targetSessionId && targetThreadId
        ? acquireAgentRuntimeConversationOwner({
            sessionId: targetSessionId,
            threadId: targetThreadId,
          })
        : null,
    [targetSessionId, targetThreadId],
  );
  const owner = acquired?.owner ?? null;
  const state = useSyncExternalStore(
    owner?.subscribe ?? emptySubscribe,
    owner?.getSnapshot ?? emptyRead,
  );
  useEffect(() => acquired?.retain(), [acquired]);
  // A replacement execution process re-reads what failed while it was unavailable.
  const runtimeConnection = useAgentRuntimeConnectionState();
  const previousConnection = useRef(runtimeConnection.status);
  useEffect(() => {
    const recovered =
      runtimeConnection.status === "ready" && previousConnection.current !== "ready";
    previousConnection.current = runtimeConnection.status;
    if (!recovered) return;
    if (owner?.getSnapshot().connection === "failed") void owner.resume();
    if (catalogState.error) refreshCatalog();
  }, [runtimeConnection.status, owner, catalogState.error]);
  const observed = state.conversation?.snapshot.projection.thread;
  const entriesFor = (
    providers: readonly AgentRuntimeProvider[],
  ): readonly AgentModelPickerEntry[] =>
    providers.flatMap((provider) => {
      const binding =
        provider.instanceId === "codex"
          ? { kind: "codex" as const }
          : input.instances.find(
              (entry) => agentRuntimeProviderId(entry.binding) === provider.instanceId,
            )?.binding;
      if (!binding || !isAgentRuntimeProviderAvailable(provider)) return [];
      return provider.models.map((model) => ({
        binding,
        label: agentRuntimeProviderLabel(provider, input.instances),
        model: projectAgentRuntimeModel(provider, model),
        selection: { binding, model: model.slug },
      }));
    });
  const draftSelectionFor = (providers: readonly AgentRuntimeProvider[]) =>
    draft.selection ??
    seedAgentRuntimeCodexSelection(
      providers.find((entry) => entry.instanceId === "codex"),
      { ...savedCodexSettings, serviceTier: savedServiceTier.serviceTier },
    ) ??
    entriesFor(providers)[0]?.selection ?? { binding: { kind: "codex" as const }, model: "" };
  const entries = entriesFor(catalogState.providers);
  const observedBinding = observed
    ? observed.modelSelection.instanceId === "codex"
      ? { kind: "codex" as const }
      : input.instances.find(
          (entry) => agentRuntimeProviderId(entry.binding) === observed.modelSelection.instanceId,
        )?.binding
    : undefined;
  const selection = observed
    ? {
        binding: observedBinding ?? { kind: "codex" as const },
        model: observed.modelSelection.model,
        options: observed.modelSelection.options,
      }
    : draftSelectionFor(catalogState.providers);
  const provider = catalogState.providers.find(
    (entry) => entry.instanceId === agentRuntimeProviderId(selection.binding),
  );
  const canRollback = provider?.supportsConversationRollback === true;
  useEffect(() => {
    owner?.setCapabilities({ canEditLastUserTurn: canRollback });
  }, [owner, canRollback]);
  const intentKey =
    targetThreadId ??
    JSON.stringify(["draft", draftKey, agentRuntimeProviderId(selection.binding)]);
  const storedIntent = useSyncExternalStore(
    (listener) => nativeIntelligenceIntentOwner.subscribe(intentKey, listener),
    () => nativeIntelligenceIntentOwner.read(intentKey),
  );
  const currentModel = provider?.models.find((model) => model.slug === selection.model);
  const claudeIntent = resolveRuntimeClaudeIntent(selection, storedIntent, currentModel);
  const chooseModel = async (
    chosen: AgentModelSelection,
    explicitIntent?: ClaudeModelSelection,
  ) => {
    const chosenModel = catalogState.providers
      .find((entry) => entry.instanceId === agentRuntimeProviderId(chosen.binding))
      ?.models.find((model) => model.slug === chosen.model);
    const nextIntent =
      explicitIntent ??
      (selection.binding.kind === "claude" &&
      chosen.binding.kind === "claude" &&
      agentRuntimeProviderId(selection.binding) === agentRuntimeProviderId(chosen.binding) &&
      chosen.model !== selection.model
        ? { ...claudeIntent, model: chosen.model }
        : readRuntimeClaudeSelection(chosen));
    const sameProvider =
      agentRuntimeProviderId(selection.binding) === agentRuntimeProviderId(chosen.binding);
    const fitted =
      chosen.binding.kind === "claude"
        ? applyRuntimeClaudeIntent(chosen, nextIntent, chosenModel)
        : {
            ...chosen,
            options: applyAgentRuntimeOptionIntent(
              chosenModel?.capabilities?.optionDescriptors ?? [],
              chosen.options ?? (sameProvider ? selection.options : undefined),
              {},
            ),
          };
    const modelSelection = agentRuntimeModelSelection(fitted.binding, fitted.model, fitted.options);
    if (!modelSelection || !chosenModel) throw new Error("Choose an available model");
    if (target && observed && modelSelection.instanceId !== observed.modelSelection.instanceId)
      throw new Error("Start a new conversation to change Agent");
    if (chosen.binding.kind === "claude")
      nativeIntelligenceIntentOwner.write(intentKey, nextIntent);
    if (fitted.binding.kind === "codex") rememberCodexChoice(fitted);
    if (!target) {
      agentRuntimeDraftOwner.write(draftKey, { selection: fitted });
      return;
    }
    await agentRuntimeRuntime.setModel({ ...target, requestId: createUuidV7(), modelSelection });
  };
  const prepareFor =
    (kind: AgentBackendBinding["kind"]) =>
    (
      text: string,
      promptInput?: CodexPromptInput,
      untrustedAppMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
    ) =>
      prepareAgentMessage(text, promptInput, (file) => readPastedTextAttachment({ file }), {
        images: true,
        agentConfigs: true,
        nativeSkills: kind === "claude",
        untrustedAppMessage,
      });
  const prepare = prepareFor(selection.binding.kind);
  const actions: Partial<ThreadStageActions> = {
    onCaptureSubmissionPresentation: () => readCodexSubmissionPresentation(workbenchOwner),
    ...createAgentRuntimeStageActions({
      target: () => target,
      owner: () => owner,
      prepare,
      readPresentation: () => readCodexSubmissionPresentation(workbenchOwner),
      capturePresentation: (target, submitted) =>
        captureCodexTurnPresentation(workbenchOwner, target, submitted),
      openFork: async (result) => {
        await input.onRefresh(result.projectId);
        await input.onOpenThread(result.threadId, { runtimeSessionId: result.sessionId });
      },
    }),
    onOpenThread: (threadId, context) =>
      input.onOpenThread(threadId, {
        ...context,
        runtimeSessionId: context?.runtimeSessionId ?? input.sessionId,
      }),
    onStartThreadForSession: async (request) => {
      const submittedPresentation =
        request.submittedPresentation ?? readCodexSubmissionPresentation(workbenchOwner);
      if (request.runInTarget === "cloud") throw new Error("Choose a local workspace");
      const modelOf = (candidate: typeof selection) =>
        agentRuntimeModelSelection(candidate.binding, candidate.model, candidate.options);
      // The message shows at once; a draft still waiting for the catalog takes its model from it.
      const pendingCatalog = modelOf(selection) ? null : catalogLoad.current;
      if (!modelOf(selection) && !pendingCatalog)
        throw new Error("Choose a configured Agent and model");
      const submission = sessionFirstSubmissionOwner.begin({
        backend: selection.binding.kind,
        originProjectId: request.projectId,
        originSessionId: request.sessionId,
        prompt: request.prompt,
        promptInput: request.promptInput,
        identity: request.submissionIdentity,
      });
      const sessionId =
        request.projectDraftId && request.projectId && input.materializeDraft
          ? (
              await input.materializeDraft({
                projectId: request.projectId,
                draftId: request.projectDraftId,
              })
            ).id
          : request.projectId === input.projectId
            ? request.sessionId
            : (await input.ensureDraft(request.projectId)).id;
      if (request.projectDraftId && !input.materializeDraft)
        throw new Error("Project draft materialization is unavailable");
      sessionFirstSubmissionOwner.update(submission.launchId, {
        targetSessionId: sessionId,
        targetProjectId: request.projectId,
        phase: "startingThread",
      });
      let launched: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult;
      try {
        const launchSelection = pendingCatalog
          ? draftSelectionFor(await pendingCatalog)
          : selection;
        const modelSelection = modelOf(launchSelection);
        if (!modelSelection) throw new Error("Choose a configured Agent and model");
        if (launchSelection.binding.kind !== selection.binding.kind)
          sessionFirstSubmissionOwner.update(submission.launchId, {
            backend: launchSelection.binding.kind,
          });
        const presentationTicket =
          request.presentationTicket ??
          (await captureCodexTurnPresentation(
            workbenchOwner,
            { kind: "session", sessionId, launchId: submission.launchId },
            submittedPresentation,
          ));
        const prepared = await prepareFor(launchSelection.binding.kind)(
          request.prompt,
          request.promptInput,
        );
        const result = await agentRuntimeRuntime.launch({
          sessionId,
          projectId: request.projectId,
          launchId: submission.launchId,
          acceptedAt: Math.floor(submission.acceptedAt),
          presentationTicket,
          title: request.prompt.slice(0, 120) || "New chat",
          modelSelection,
          interactionMode: draftMode,
          runInTarget: request.runInTarget === "newWorktree" ? "newWorktree" : "localProject",
          runInEnvironmentPath: request.runInEnvironmentPath,
          worktreeStartingState: request.worktreeStartingState,
          message: {
            messageId: submission.clientUserMessageId,
            ...prepared,
            images: agentRuntimePromptImages(request.promptInput),
            ...(request.promptInput
              ? { agentConfigs: request.promptInput.agentConfigs ?? [] }
              : {}),
          },
        });
        if (request.projectDraftId && request.projectId)
          input.commitDraft?.({
            projectId: request.projectId,
            draftId: request.projectDraftId,
            sessionId: result.sessionId,
          });
        setCreatedTarget({ sessionId: result.sessionId, threadId: result.threadId });
        sessionFirstSubmissionOwner.update(submission.launchId, {
          threadId: result.threadId,
          phase: "startingTurn",
        });
        launched = result;
      } catch (cause) {
        sessionFirstSubmissionOwner.fail(submission.launchId, {
          stage: "startingThread",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
      // The chat exists from here. Failing to show it must not restore the draft and invite a
      // second send of the same message.
      try {
        await input.onRefresh(request.projectId);
        if (input.onLaunched) await input.onLaunched(launched);
        else await input.onOpenThread(launched.threadId, { runtimeSessionId: launched.sessionId });
      } catch (cause) {
        toast.danger(
          `The chat started, but it could not be opened: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { id: `agent-runtime-launch-open:${launched.sessionId}` },
        );
      }
    },
    onModelChange: (model) => chooseModel({ ...selection, model }),
    onReasoningEffortChange: (effort) =>
      selection.binding.kind === "claude" && isClaudeEffortLevel(effort)
        ? chooseModel(selection, { ...claudeIntent, effort, thinking: true })
        : chooseModel({
            ...selection,
            options: applyAgentRuntimeOptionIntent(modelOptions, selection.options, {
              reasoningEffort: effort,
            }),
          }),
    // Model, effort and speed land in one selection change so none overwrites another.
    onIntelligenceSelectionChange: async (candidate) => {
      const model = candidate.model || selection.model;
      if (selection.binding.kind === "claude") {
        const effortChanged = candidate.reasoningEffort !== resolvedEffort;
        await chooseModel(
          { ...selection, model },
          effortChanged && isClaudeEffortLevel(candidate.reasoningEffort)
            ? { ...claudeIntent, model, effort: candidate.reasoningEffort, thinking: true }
            : undefined,
        );
        return;
      }
      await chooseModel({
        ...selection,
        model,
        options: applyAgentRuntimeOptionIntent(
          provider?.models.find((entry) => entry.slug === model)?.capabilities?.optionDescriptors ??
            [],
          selection.options,
          {
            reasoningEffort: candidate.reasoningEffort,
            ...(selection.binding.kind === "codex" ? { serviceTier: candidate.serviceTier } : {}),
          },
        ),
      });
    },
    onCollaborationModeChange: async (interactionMode) => {
      if (!target) {
        agentRuntimeDraftOwner.write(draftKey, { interactionMode });
        return;
      }
      await agentRuntimeRuntime.setModes({ ...target, requestId: createUuidV7(), interactionMode });
    },
    onUnarchiveThread: async () => {
      if (target) await workspaceSessionCommands.unarchive(target.sessionId);
      await input.onRefresh(input.projectId);
    },
  };
  const kind = selection.binding.kind;
  const runtime = createAgentRuntimeConversationRuntime(
    kind,
    targetSessionId
      ? { sessionId: targetSessionId, ...(targetThreadId ? { threadId: targetThreadId } : {}) }
      : null,
    owner,
  );
  // Core names the chat; the engine Thread keeps the prompt it started from as its own title.
  const view = state.view;
  const sessionTitle = input.sessionTitle;
  const titledView = useMemo(
    () => (view && sessionTitle ? { ...view, threadName: sessionTitle } : view),
    [view, sessionTitle],
  );
  // Mount the keyed transcript reader before the first query completes; unknown execution is notLoaded.
  const summary: CodexThreadSummary | null =
    titledView ??
    (targetThreadId
      ? {
          threadId: targetThreadId,
          projectId: input.projectId,
          executionHostId: "local",
          source: null,
          threadName: input.sessionTitle ?? "Chat",
          threadPreview: "",
          cwd: input.workspaceRoot ?? null,
          statusType: "notLoaded",
          statusActiveFlags: [],
          archived: false,
          createdAt: 0,
          updatedAt: 0,
          linkedAt: "",
        }
      : null);
  const models = provider?.models.map((model) => projectAgentRuntimeModel(provider, model)) ?? [];
  const selectedModel = selection.model;
  const selectedEffort = selection.options?.find((option) =>
    /effort|reasoning/i.test(option.id),
  )?.value;
  const resolvedEffort =
    typeof selectedEffort === "string"
      ? selectedEffort
      : (models.find((model) => model.id === selectedModel)?.defaultReasoningEffort ?? "default");
  const modelOptions =
    provider?.models.find((model) => model.slug === selectedModel)?.capabilities
      ?.optionDescriptors ?? [];
  const serviceTierDescriptor = modelOptions.find((option) => option.id === "serviceTier");
  const selectedServiceTier =
    readAgentRuntimeServiceTier(selection.options) ??
    readAgentRuntimeServiceTier(
      serviceTierDescriptor?.type === "select" && serviceTierDescriptor.currentValue
        ? [{ id: "serviceTier", value: serviceTierDescriptor.currentValue }]
        : undefined,
    ) ??
    null;
  const configOptions: import("../../../shared/agent-conversation").AgentSessionConfigOption[] =
    modelOptions.map((option) => {
      const chosen = selection.options?.find((value) => value.id === option.id)?.value;
      const common = {
        id: option.id,
        name: option.label,
        description: option.description ?? null,
        category: /effort|reasoning/i.test(option.id) ? "thought_level" : null,
      };
      if (option.type === "boolean")
        return {
          ...common,
          type: "boolean",
          currentValue: typeof chosen === "boolean" ? chosen : (option.currentValue ?? false),
        };
      return {
        ...common,
        type: "select",
        currentValue:
          typeof chosen === "string"
            ? chosen
            : (option.currentValue ??
              option.options.find((value) => value.isDefault)?.id ??
              option.options[0]?.id ??
              ""),
        options: option.options.map((value) => ({
          value: value.id,
          name: value.label,
          description: value.description ?? null,
        })),
      };
    });
  const changeConfig = async (id: string, value: string | boolean) => {
    const option = modelOptions.find((candidate) => candidate.id === id);
    if (
      !option ||
      (option.type === "boolean"
        ? typeof value !== "boolean"
        : !option.options.some((candidate) => candidate.id === value))
    )
      throw new Error("Choose an available model option");
    await chooseModel({
      ...selection,
      options: [
        ...(selection.options ?? []).filter((candidate) => candidate.id !== id),
        { id, value },
      ],
    });
  };
  // Background status belongs to the Session's root; an opened child shows its own Runs.
  const activity = useAgentRuntimeSessionActivity(
    input.executionRef &&
      (input.threadId === undefined || input.threadId === input.executionRef.threadId)
      ? input.sessionId
      : null,
  );
  const backgroundMessage = agentRuntimeBackgroundStatus(activity);
  const preparationFailure = target
    ? failedWorkspacePreparation(state.conversation?.snapshot.projection.runs ?? [])
    : null;
  const retryPreparation = async (runId: string, workLocally: boolean) => {
    if (!target) return;
    await agentRuntimeRuntime.retryPreparation({
      ...target,
      requestId: createUuidV7(),
      runId,
      workLocally,
    });
  };
  const presentation: ConversationProviderPresentation = {
    resolveRuntimeAttachment: async (reference) => {
      if (!target) throw new Error("Open the conversation before reading its attachment");
      const result = await agentRuntimeRuntime.attachment({ ...target, ...reference });
      if (!result) throw new Error("Image unavailable");
      return result.path;
    },
    nativeIntelligence:
      selection.binding.kind === "claude"
        ? {
            selected: {
              fast: readRuntimeClaudeSelection(selection).fast ?? false,
              thinking: readRuntimeClaudeSelection(selection).thinking,
              context: readRuntimeClaudeSelection(selection).context,
              contextInherited: readRuntimeClaudeSelection(selection).context === undefined,
            },
            capabilities: currentModel ? runtimeClaudeModelOption(currentModel) : {},
            change: async (patch) => {
              const next = { ...claudeIntent };
              for (const key of ["fast", "thinking", "context"] as const)
                if (patch[key] === null) delete next[key];
              await chooseModel(selection, {
                ...next,
                ...(patch.effort ? { effort: patch.effort } : {}),
                ...(typeof patch.fast === "boolean" ? { fast: patch.fast } : {}),
                ...(typeof patch.thinking === "boolean" ? { thinking: patch.thinking } : {}),
                ...(typeof patch.context === "string" ? { context: patch.context } : {}),
              });
            },
          }
        : undefined,
    kind: selection.binding.kind,
    ...(selection.binding.kind === "codex" ? { serviceTier: selectedServiceTier } : {}),
    label: provider?.displayName ?? (selection.binding.kind === "codex" ? "Codex" : "Agent"),
    selection: agentRuntimeProviderId(selection.binding) ?? "",
    options: [],
    select: () => {},
    modelCatalog: {
      entries,
      selected: selection,
      loading: catalogState.loading,
      error: catalogState.error,
      choose: chooseModel,
      refresh: () => {
        refreshCatalog();
        openCodeSetup.refresh();
      },
      configOptions,
      changeConfig,
      runtimeOptions: [],
      chooseRuntime: () => {},
      manage: () => {},
      setup: openCodeSetup.setup,
    },
    commands:
      provider?.slashCommands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        inputHint: command.input?.hint ?? null,
      })) ?? [],
    controls: {
      steer: true,

      images: true,
      skills: true,
      subagents: true,
      goals: false,
    },
    skills:
      provider?.skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          name: skill.name,
          displayName: skill.displayName ?? skill.name,
          description: skill.description ?? "",
          iconUrl: null,
          brandColor: null,
          path: skill.path,
          scope: "user" as const,
        })) ?? [],
    refreshSkills: async () => {
      refreshCatalog();
    },
    history: {
      hasOlder: Boolean(state.view?.turnPagination?.olderCursor),
      loading: state.historyLoading,
      loadOlder: async () => {
        await owner?.loadOlder();
      },
    },
    // Only a blocking provider state is a composer error; warnings such as an unchecked status or
    // a model that needs a newer CLI belong to provider settings.
    error:
      state.error ??
      catalogState.error ??
      (provider?.status === "error" ? (provider.message ?? null) : null),
    status: preparationFailure
      ? {
          message: "The worktree could not be prepared.",
          tone: "danger",
          actions: [
            {
              label: "Retry",
              pendingLabel: "Retrying…",
              run: () => retryPreparation(preparationFailure, false),
            },
            {
              label: "Work locally",
              pendingLabel: "Starting…",
              run: () => retryPreparation(preparationFailure, true),
            },
          ],
        }
      : backgroundMessage
        ? {
            message: backgroundMessage,
            ...(activity && activity.activeTaskCount > 0
              ? {
                  actions: [
                    {
                      label: "Stop",
                      pendingLabel: "Stopping…",
                      run: () =>
                        stopAgentRuntimeBackgroundTasks(
                          activity.sessionId,
                          activity.threadId,
                          agentRuntimeRuntime,
                        ),
                    },
                  ],
                }
              : {}),
          }
        : null,
  };
  return {
    runtime,
    owner,
    state,
    summary,
    actions,
    provider: presentation,
    models,
    selectedModel,
    selectedEffort: resolvedEffort,
    reasoningEffortOptions: modelOptions.flatMap((option) =>
      option.type === "select" && /effort|reasoning/i.test(option.id)
        ? option.options.map((choice) => ({
            reasoningEffort: choice.id,
            description: choice.description ?? choice.label,
          }))
        : [],
    ),
    selectedMode: observed?.interactionMode ?? draftMode,
    modes: [
      { name: "Code", mode: "default", model: null },
      { name: "Plan", mode: "plan", model: null },
    ] as CodexCollaborationModePreset[],
  };
}
