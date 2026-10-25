import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  agentRuntimeModelOptionMemoryAtom,
  rememberAgentModelOptions,
  rememberedAgentModelOptions,
  withAgentRuntimeComposerChoice,
  type AgentRuntimeComposerChoice,
} from "./agent-runtime-composer-choices";
import { usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
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
import type {
  AgentRuntimeOperations,
  AgentWire,
  ModelSelection,
} from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeMessage,
  AgentRuntimeSessionTarget,
} from "../../../shared/agent-runtime-api";
import {
  agentRuntimeModelSelection,
  agentRuntimeModelSelectionsEqual,
  agentRuntimeProviderId,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
} from "../../../shared/agent-runtime-provider";
import {
  agentRuntimeAgentSwitchRefusal,
  agentRuntimePendingSelection,
  agentRuntimeSelectionRefusal,
} from "../../../shared/agent-runtime-agent-switch";
import { agentRuntimeForkSource } from "../../../shared/agent-runtime-fork-merge";
import { useCodexThreadSettings } from "../../lib/use-codex-thread-settings";
import { CodexReasoningEffortSchema } from "../../../shared/schemas/codex";
import { useCodexServiceTierSettings } from "../../lib/use-codex-service-tier-settings";
import { retainAgentAppContext } from "../../../shared/agent-prompt";
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
import {
  defaultAgentRuntimeModelSelection,
  isAgentRuntimeProviderAvailable,
  requireAgentRuntimeModelSelection,
} from "../../lib/agent-runtime-model-selection";
import {
  agentRuntimePromptImages,
  agentRuntimeImageInputSupport,
  agentRuntimeImageInputUnavailableReason,
  prepareAgentRuntimeMessage,
} from "../../lib/agent-runtime-prompt";
import { workspaceSessionCommands } from "../../lib/workspace-catalog-commands";
import {
  acquireAgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwnerSnapshot,
} from "./agent-runtime-conversation-owner";
import type { ConversationContentSource, ConversationRuntime } from "./conversation-runtime";
import type { ThreadStageActions, ConversationProviderPresentation } from "./thread-stage-types";
import type { AgentModelPickerEntry } from "../../components/shared/agent-runtime/agent-model-picker";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import {
  setLocalConversationComposerIntent,
  setLocalConversationThreadPresented,
} from "./local-conversation-store";
import { copyAgentRuntimeConversationMarkdown } from "./agent-runtime-markdown-export";
import {
  agentRuntimeAgentLabels,
  agentRuntimeDelegatedTasks,
  createAgentRuntimeDelegatedTaskPort,
  stopAgentRuntimeBackgroundTasks,
} from "./agent-runtime-delegated-tasks";
import { agentRuntimeBackgroundStatus } from "./agent-runtime-composer-status";
import { useOpenCodeModelSetup } from "../opencode-setup/use-opencode-setup";
import { useAcpComposerSetup } from "../acp-agents/use-acp-composer-setup";
import {
  acpImportedHistoryEmptyState,
  acpPendingImportedHistory,
} from "../acp-agents/acp-agent-model";
import { useAgentSettingsNavigation } from "@/lib/agent-settings-navigation";
import type { AgentRuntimeRun } from "./agent-runtime-transcript-projection";
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
    history: (id) => {
      if (!matches(id)) return null;
      const source = owner!.contentSource();
      if (!source) return null;
      return {
        loadBoundary: (boundary) =>
          source.isCurrent() ? owner!.loadHistoryBoundary(boundary) : Promise.resolve("stale"),
      };
    },
    attachment: (id) => {
      if (!matches(id)) return { status: "idle" };
      const state = owner!.getSnapshot();
      if (state.connection === "failed")
        return { status: "failed", message: state.error ?? "Could not open conversation" };
      return state.connection === "ready" ? { status: "attached" } : { status: "attaching" };
    },
    connection: () => projectAgentRuntimeConnection(agentRuntimeActivityStore.readConnection()),
    role: (id) => (matches(id) ? "follower" : null),
    agentLabels: agentRuntimeAgentLabels,
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
    loadHistory: async (id) => {
      if (matches(id)) await owner!.resume();
    },
    resume: async () => {
      await owner?.resume();
    },
    markRead: async (id) => {
      if (!target || !matches(id)) return;
      const thread = owner!.getSnapshot().conversation?.snapshot.projection.thread;
      // Delegated children share the Session, but viewing one does not read its root chat.
      if (!thread || thread.lineage.rootThreadId !== id) return;
      await workspaceSessionCommands.markUnread(target.sessionId, { unread: false });
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

/** The configured Agent behind a Runtime provider instance; Codex needs no configuration. */
export function agentRuntimeBinding(
  instanceId: string,
  instances: readonly { readonly binding: AgentBackendBinding }[],
): AgentBackendBinding | undefined {
  return instanceId === "codex"
    ? { kind: "codex" }
    : instances.find((entry) => agentRuntimeProviderId(entry.binding) === instanceId)?.binding;
}

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
    inputModalities: [...(model.capabilities?.inputModalities ?? [])],
    isDefault: model.isDefault ?? false,
  };
}

// Actions are reconstructed on render; one observed source admits one continuation at a time.
const failureContinuations = new WeakMap<ConversationContentSource, Promise<void>>();

function latestRuntimeRun(runs: readonly AgentRuntimeRun[]): AgentRuntimeRun | undefined {
  return runs.reduce<AgentRuntimeRun | undefined>(
    (previous, run) =>
      run.status !== "queued" && (!previous || run.ordinal > previous.ordinal) ? run : previous,
    undefined,
  );
}

/** Shared editor controls address the exact Session/Thread/Run observed by the read owner. */
export function createAgentRuntimeStageActions(input: {
  readonly target: () => AgentRuntimeSessionTarget | null;
  readonly owner: () =>
    | (Pick<
        AgentRuntimeConversationOwner,
        | "getSnapshot"
        | "nextQueuePage"
        | "previousQueuePage"
        | "queueBoundary"
        | "readQueuedInput"
        | "readSentMessage"
      > &
        Partial<Pick<AgentRuntimeConversationOwner, "contentSource" | "whenObserved">>)
    | null;
  readonly transport?: AgentRuntimeRendererTransport;
  readonly prepare: (
    text: string,
    promptInput?: CodexPromptInput,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
    modelSelection?: NonNullable<AgentRuntimeMessage["modelSelection"]>,
  ) => Promise<Pick<AgentRuntimeMessage, "text" | "context">>;
  readonly capturePresentation?: (
    target: CodexTurnPresentationTarget,
    submitted?: WorkbenchSubmitPresentation,
  ) => Promise<CodexTurnPresentationTicket | undefined>;
  readonly readPresentation?: () => WorkbenchSubmitPresentation;
  readonly openFork?: (
    result: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult,
  ) => Promise<void>;
  /** The Agent and model the person chose for the chat's next message, when it changes them. */
  readonly nextSelection?: () => AgentRuntimeMessage["modelSelection"] | null;
  readonly manageProvider?: (instanceId: string) => void;
}): Partial<ThreadStageActions> {
  const transport = input.transport ?? agentRuntimeRuntime;
  // A choice travels with the message that uses it; the Runtime applies it to that message's Run.
  const chosenSelection = () => {
    const modelSelection = input.nextSelection?.();
    return modelSelection ? { modelSelection } : {};
  };
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
    admission?: { readonly assertCurrent: () => void; readonly messageId: string },
  ) => {
    const target = requireTarget();
    const messageId = admission?.messageId ?? createUuidV7();
    const presentationTicket = target.threadId
      ? await input.capturePresentation?.({ kind: "thread", threadId: target.threadId }, submitted)
      : undefined;
    const prepared = await input.prepare(text, promptInput, appMessage);
    admission?.assertCurrent();
    const owner = input.owner();
    const accepted = await transport.message({
      ...target,
      presentationTicket,
      message: {
        messageId,
        ...prepared,
        images: agentRuntimePromptImages(promptInput, appMessage),
        ...(promptInput?.agentConfigs !== undefined
          ? { agentConfigs: promptInput.agentConfigs }
          : {}),
        ...chosenSelection(),
      },
      ...(intent ? { intent } : {}),
    });
    // The Composer clears when this resolves; the sent message is on screen by then.
    await owner?.whenObserved?.(accepted.sequence);
  };
  const continueAfterFailure = async (turnId: string): Promise<void> => {
    const target = { ...requireTarget() };
    const owner = input.owner();
    const source = owner?.contentSource?.();
    if (!owner || !source) throw new Error("Open the conversation before continuing");
    const existing = failureContinuations.get(source);
    if (existing) return existing;
    const continueCurrent = async () => {
      const assertCurrent = () => {
        const current = requireTarget();
        if (
          current.sessionId !== target.sessionId ||
          current.threadId !== target.threadId ||
          input.owner() !== owner ||
          !source.isCurrent()
        )
          throw new Error("Conversation source changed");
        const snapshot = owner.getSnapshot();
        const runs = snapshot.conversation?.snapshot.projection.runs ?? [];
        const latest = latestRuntimeRun(runs);
        if (
          latest?.id !== turnId ||
          latest.status !== "failed" ||
          runs.some((run) =>
            ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
          ) ||
          (snapshot.view?.requests.length ?? 0) > 0
        )
          throw new Error("This turn can no longer be continued");
      };
      assertCurrent();
      await dispatch(
        "Continue from where you left off.",
        undefined,
        undefined,
        undefined,
        undefined,
        { assertCurrent, messageId: `continue:${turnId}` },
      );
    };
    const pending = continueCurrent().finally(() => {
      failureContinuations.delete(source);
    });
    failureContinuations.set(source, pending);
    return pending;
  };
  const manageFailedProvider = input.manageProvider
    ? (turnId: string) => {
        requireTarget();
        const owner = input.owner();
        if (!owner?.contentSource?.()?.isCurrent()) throw new Error("Conversation source changed");
        const runs = owner.getSnapshot().conversation?.snapshot.projection.runs ?? [];
        const latest = latestRuntimeRun(runs);
        if (latest?.id !== turnId || latest.status !== "failed")
          throw new Error("This turn is no longer the latest failure");
        input.manageProvider!(latest.modelSelection.instanceId);
      }
    : undefined;
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
    const accepted = await transport.queueMessage({
      ...target,
      presentationTicket,
      message: {
        messageId,
        ...prepared,
        images: agentRuntimePromptImages(promptInput, appMessage),
        ...(promptInput?.agentConfigs !== undefined
          ? { agentConfigs: promptInput.agentConfigs }
          : {}),
        ...chosenSelection(),
      },
    });
    await owner?.whenObserved?.(accepted.sequence);
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
    const original = await transport.readRunMessage({ ...target, runId });
    if (original?.id !== queued.clientUserMessageId)
      throw new Error("This queued message is no longer pending");
    const selection = await readQueuedSelection(threadId, runId);
    const presentationTicket = await input.capturePresentation?.({ kind: "thread", threadId });
    await transport.queue({
      ...target,
      requestId: createUuidV7(),
      action: "edit",
      presentationTicket,
      runId,
      message: {
        messageId: queued.clientUserMessageId,
        ...retainAgentAppContext(
          await input.prepare(prompt, promptInput, undefined, selection),
          original,
        ),
        images: agentRuntimePromptImages(promptInput),
        ...(promptInput?.agentConfigs !== undefined
          ? { agentConfigs: promptInput.agentConfigs }
          : {}),
      },
    });
  };
  const readQueuedSelection = async (threadId: string, runId: string) => {
    const conversation = await transport.control({ ...exactTarget(threadId), runId });
    const run = conversation.snapshot.projection.runs.find((entry) => entry.id === runId);
    if (!run || run.status !== "queued")
      throw new Error("This queued message is no longer pending");
    return run.modelSelection;
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
    onContinueAfterFailure: continueAfterFailure,
    onManageFailedProvider: manageFailedProvider,
    onEditUserTurn: async (request) => {
      const target = exactTarget(request.threadId);
      const owner = input.owner();
      if (!owner) throw new Error("Open the conversation before editing this message");
      const original = await owner.readSentMessage(request.turnId);
      const promptInput: CodexPromptInput = { text: request.message, images: original.images };
      const presentationTicket = await input.capturePresentation?.({
        kind: "thread",
        threadId: request.threadId,
      });
      // Compile before rewinding: a message the Agent cannot accept must not discard any history.
      const prepared = retainAgentAppContext(
        await input.prepare(request.message, promptInput),
        original.message,
      );
      await transport.rollback({ ...target, requestId: createUuidV7(), runId: request.turnId });
      const accepted = await transport.message({
        ...target,
        presentationTicket,
        message: {
          messageId: createUuidV7(),
          ...prepared,
          images: agentRuntimePromptImages(promptInput),
          ...chosenSelection(),
        },
      });
      await owner.whenObserved?.(accepted.sequence);
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
      const modelSelection = await readQueuedSelection(request.threadId, request.followUpId);
      setLocalConversationComposerIntent(request.threadId, {
        prompt: queuedInput.text,
        promptInput: { ...request.promptInput, ...queuedInput },
        queuedFollowUpEdit: {
          followUpId: request.followUpId,
          ledgerRevision: request.ledgerRevision ?? 0,
          modelSelection,
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
  readonly sessionUnread: boolean;
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
  // A forced read makes providers check again; a plain read returns their current state.
  const [catalogRequest, setCatalogRequest] = useState({ revision: 0, refresh: false });
  const refreshCatalog = () =>
    setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: true }));
  const reloadCatalog = () =>
    setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: false }));
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
      .catalog({ refresh: catalogRequest.refresh })
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
  }, [catalogRequest, input.instances]);
  const bindingFor = (instanceId: string) => agentRuntimeBinding(instanceId, input.instances);
  const openAgentSettings = useAgentSettingsNavigation();
  useEffect(() => {
    agentRuntimeDelegatedTasks.publishLabels(
      new Map(
        catalogState.providers.flatMap((provider) => {
          const binding = agentRuntimeBinding(provider.instanceId, input.instances);
          if (!binding) return [];
          return [
            [
              provider.instanceId,
              {
                label: agentRuntimeProviderLabel(provider, input.instances),
                kind: binding.kind,
                models: new Map(provider.models.map((model) => [model.slug, model.name])),
              },
            ],
          ];
        }),
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
  // Choices persist beside the Composer's prompt draft, across windows and restart.
  const choices = usePersistedAtomValue(agentRuntimeComposerChoicesAtom).value;
  const setChoices = useSetPersistedAtom(agentRuntimeComposerChoicesAtom);
  const writeChoice = (key: string, patch: Partial<AgentRuntimeComposerChoice>) =>
    setChoices((current) => withAgentRuntimeComposerChoice(current, key, patch));
  const modelOptionMemory = usePersistedAtomValue(agentRuntimeModelOptionMemoryAtom).value;
  const setModelOptionMemory = useSetPersistedAtom(agentRuntimeModelOptionMemoryAtom);
  const draftKey = agentRuntimeChoiceKey.draft(input.sessionId, input.modelProjectId);
  const draft = choices[draftKey] ?? {};
  const draftMode = draft.interactionMode ?? "default";
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
  const projection = state.conversation?.snapshot.projection;
  const nativeSessions = projection?.providerSessions;
  // A native session can negotiate capabilities that its initial catalog did not know.
  // Session lifecycle events invalidate that read without forcing a new provider probe.
  useEffect(() => {
    if (nativeSessions?.length) reloadCatalog();
  }, [nativeSessions]);
  const observed = projection?.thread;
  const entriesFor = (
    providers: readonly AgentRuntimeProvider[],
  ): readonly AgentModelPickerEntry[] =>
    providers.flatMap((provider) => {
      const binding = bindingFor(provider.instanceId);
      if (!binding || !isAgentRuntimeProviderAvailable(provider)) return [];
      return provider.models.map((model) => ({
        binding,
        label: agentRuntimeProviderLabel(provider, input.instances),
        model: projectAgentRuntimeModel(provider, model),
        selection: { binding, model: model.slug },
      }));
    });
  const draftSelectionFor = (providers: readonly AgentRuntimeProvider[]): AgentModelSelection => {
    if (draft.selection) return draft.selection;
    const selected = defaultAgentRuntimeModelSelection(
      providers.filter((entry) => bindingFor(entry.instanceId) !== undefined),
      { ...savedCodexSettings, serviceTier: savedServiceTier.serviceTier },
    );
    const binding = selected ? bindingFor(selected.instanceId) : undefined;
    return selected && binding
      ? { binding, model: selected.model, options: selected.options }
      : { binding: { kind: "codex" }, model: "" };
  };
  /** The default Agent's model, read alone first; the whole catalog only when it has none. */
  const resolveDefaultSelection = async () => {
    const whole = catalogLoad.current;
    const preferred = draftSelectionFor(
      await agentRuntimeRuntime
        .catalog({ instanceIds: ["codex"] })
        .catch((): readonly AgentRuntimeProvider[] => []),
    );
    if (agentRuntimeModelSelection(preferred.binding, preferred.model, preferred.options))
      return preferred;
    if (!whole) throw new Error("Choose a configured Agent and model");
    return draftSelectionFor(await whole);
  };
  const modelOf = (candidate: AgentModelSelection) =>
    agentRuntimeModelSelection(candidate.binding, candidate.model, candidate.options);
  const providerOf = (candidate: AgentModelSelection) =>
    catalogState.providers.find(
      (entry) => entry.instanceId === agentRuntimeProviderId(candidate.binding),
    );
  // A started chat's choice for its next message; the chat keeps its own until a message uses it.
  const choiceKey = targetThreadId ? agentRuntimeChoiceKey.chat(targetThreadId) : null;
  const choice = choiceKey ? choices[choiceKey]?.selection : undefined;
  const observedSelection: AgentModelSelection | undefined = observed
    ? {
        binding: bindingFor(observed.modelSelection.instanceId) ?? { kind: "codex" },
        model: observed.modelSelection.model,
        options: observed.modelSelection.options,
      }
    : undefined;
  const nextSelection = observed
    ? agentRuntimePendingSelection(
        observed.modelSelection,
        (choice && modelOf(choice)) ?? undefined,
      )
    : null;
  // A choice the chat has since applied is spent, so a later change elsewhere is not undone. Once
  // the chat is open, the unstarted draft it launched from has nothing left to choose.
  const spentChoice = Boolean(choiceKey && choice && observed && !nextSelection);
  const spentDraft = Boolean(observed && choices[draftKey]);
  useEffect(() => {
    if (!spentChoice && !spentDraft) return;
    void setChoices((current) => {
      const unspent =
        spentChoice && choiceKey
          ? withAgentRuntimeComposerChoice(current, choiceKey, { selection: undefined })
          : current;
      return spentDraft
        ? withAgentRuntimeComposerChoice(unspent, draftKey, {
            selection: undefined,
            interactionMode: undefined,
          })
        : unspent;
    });
  }, [spentChoice, spentDraft, choiceKey, draftKey, setChoices]);
  const selection =
    (nextSelection ? choice : undefined) ??
    observedSelection ??
    draftSelectionFor(catalogState.providers);
  const provider = providerOf(selection);
  const openSettingsFor = (binding: AgentBackendBinding) =>
    binding.kind === "acp" && binding.instanceConfigId
      ? openAgentSettings?.("acp", binding.instanceConfigId)
      : openAgentSettings?.(binding.kind);
  const acpSetup = useAcpComposerSetup({
    providers: catalogState.providers,
    instances: input.instances,
    selected: selection.binding,
    openSettings: (instanceId) => openAgentSettings?.("acp", instanceId),
  });
  const agentSwitchRefusal = projection ? agentRuntimeAgentSwitchRefusal(projection) : null;
  const refusalFor = (candidate: Pick<AgentWire<ModelSelection>, "instanceId" | "model">) =>
    observed
      ? agentRuntimeSelectionRefusal({
          current: observed.modelSelection,
          next: candidate,
          agentSwitchRefusal,
          providers: catalogState.providers,
        })
      : null;
  const entries = entriesFor(catalogState.providers).map((entry) => {
    const candidate = modelOf(entry.selection);
    const unavailableReason = candidate ? refusalFor(candidate) : null;
    return unavailableReason ? { ...entry, unavailableReason } : entry;
  });
  // Editing rewinds the Run the chat's own Agent ran; the edited message may then change Agent.
  const canRollback =
    (observedSelection ? providerOf(observedSelection) : provider)?.supportsConversationRollback ===
    true;
  useEffect(() => {
    owner?.setCapabilities({ supportsUserTurnEdits: canRollback });
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
    requested: AgentModelSelection,
    explicitIntent?: ClaudeModelSelection,
  ) => {
    const chosenModel = catalogState.providers
      .find((entry) => entry.instanceId === agentRuntimeProviderId(requested.binding))
      ?.models.find((model) => model.slug === requested.model);
    const sameProvider =
      agentRuntimeProviderId(selection.binding) === agentRuntimeProviderId(requested.binding);
    // Another Agent's model starts from the options last chosen for it, otherwise its defaults.
    const chosen =
      sameProvider || requested.options !== undefined
        ? requested
        : { ...requested, options: rememberedAgentModelOptions(modelOptionMemory, requested) };
    const nextIntent =
      explicitIntent ??
      (selection.binding.kind === "claude" &&
      chosen.binding.kind === "claude" &&
      agentRuntimeProviderId(selection.binding) === agentRuntimeProviderId(chosen.binding) &&
      chosen.model !== selection.model
        ? { ...claudeIntent, model: chosen.model }
        : readRuntimeClaudeSelection(chosen));
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
    const modelSelection = modelOf(fitted);
    if (!modelSelection || !chosenModel) throw new Error("Choose an available model");
    const refusal = refusalFor(modelSelection);
    if (refusal) throw new Error(refusal);
    if (chosen.binding.kind === "claude")
      nativeIntelligenceIntentOwner.write(intentKey, nextIntent);
    if (fitted.binding.kind === "codex") rememberCodexChoice(fitted);
    await Promise.all([
      setModelOptionMemory((current) => rememberAgentModelOptions(current, fitted)),
      writeChoice(choiceKey ?? draftKey, {
        selection:
          observed && agentRuntimeModelSelectionsEqual(observed.modelSelection, modelSelection)
            ? undefined
            : fitted,
      }),
    ]);
  };
  const prepareFor =
    (candidate: AgentModelSelection, knownProvider?: AgentRuntimeProvider) =>
    async (
      text: string,
      promptInput?: CodexPromptInput,
      untrustedAppMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
    ) => {
      let provider = knownProvider ?? providerOf(candidate);
      // A first send can outrun the render that receives its catalog. Read its chosen Agent
      // so document preferences and visual input are checked before any history mutation.
      if (!provider) {
        const instanceId = agentRuntimeProviderId(candidate.binding);
        const providers = instanceId
          ? await agentRuntimeRuntime.catalog({ instanceIds: [instanceId] })
          : [];
        provider = providers.find((entry) => entry.instanceId === instanceId);
      }
      const model = provider?.models.find((entry) => entry.slug === candidate.model);
      return prepareAgentRuntimeMessage(
        {
          model,
          provider,
          modelSelection: modelOf(candidate) ?? undefined,
          kind: candidate.binding.kind,
          text,
          promptInput,
          untrustedAppMessage,
        },
        (file) => readPastedTextAttachment({ file }),
      );
    };
  const prepare: Parameters<typeof createAgentRuntimeStageActions>[0]["prepare"] = (
    text,
    promptInput,
    appMessage,
    queuedSelection,
  ) => {
    const candidate = queuedSelection
      ? {
          binding: bindingFor(queuedSelection.instanceId),
          model: queuedSelection.model,
          options: queuedSelection.options,
        }
      : selection;
    if (!candidate.binding) throw new Error("The queued message's Agent is unavailable");
    return prepareFor({ ...candidate, binding: candidate.binding })(text, promptInput, appMessage);
  };
  const latestRun = latestRuntimeRun(projection?.runs ?? []);
  const failedProvider =
    latestRun?.status === "failed" ? bindingFor(latestRun.modelSelection.instanceId) : undefined;
  const manageProvider =
    openAgentSettings && failedProvider && failedProvider.kind !== "codex"
      ? (instanceId: string) => {
          const binding = bindingFor(instanceId);
          if (!binding || binding.kind === "codex")
            throw new Error("This Agent's settings are unavailable");
          openSettingsFor(binding);
        }
      : undefined;
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
      nextSelection: () => nextSelection,
      manageProvider,
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
      // The message shows at once. A draft still waiting for the catalog takes its default Agent's
      // model once that Agent is checked, without waiting for every other Agent's check.
      const pendingSelection = modelOf(selection) ? null : resolveDefaultSelection();
      // Its failure is reported where the launch awaits it.
      pendingSelection?.catch(() => {});
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
        const launchSelection = pendingSelection ? await pendingSelection : selection;
        const modelSelection = modelOf(launchSelection);
        if (!modelSelection) throw new Error("Choose a configured Agent and model");
        const launchProviders = catalogState.loading
          ? await agentRuntimeRuntime.catalog({ instanceIds: [modelSelection.instanceId] })
          : catalogState.providers;
        const resolved = requireAgentRuntimeModelSelection(launchProviders, modelSelection);
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
        const prepared = await prepareFor(launchSelection, resolved.provider)(
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
            ...(request.promptInput?.agentConfigs !== undefined
              ? { agentConfigs: request.promptInput.agentConfigs }
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
    ...(target && observed && agentRuntimeForkSource(observed)
      ? {
          onMergeForkBack: async () => {
            const merged = await agentRuntimeRuntime.mergeBack({
              ...target,
              requestId: createUuidV7(),
            });
            await input.onRefresh(merged.projectId);
            await input.onOpenThread(merged.threadId, { runtimeSessionId: merged.sessionId });
            toast.success("The fork's work joins your next message in this chat.");
          },
        }
      : {}),
    onCollaborationModeChange: async (interactionMode) => {
      if (!target) {
        await writeChoice(draftKey, { interactionMode });
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
  // Core owns the root chat's title and unread state independently of execution history.
  const view = state.view;
  const sessionTitle = input.sessionTitle;
  const rootThreadId = input.executionRef?.threadId ?? createdTarget?.threadId ?? null;
  const sessionUnread = targetThreadId === rootThreadId && input.sessionUnread === true;
  const sessionView = useMemo(
    () =>
      view
        ? {
            ...view,
            ...(sessionTitle ? { threadName: sessionTitle } : {}),
            hasUnreadTurn: sessionUnread,
          }
        : null,
    [view, sessionTitle, sessionUnread],
  );
  // Mount the keyed transcript reader before the first query completes; unknown execution is notLoaded.
  const summary: CodexThreadSummary | null =
    sessionView ??
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
          hasUnreadTurn: sessionUnread,
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
  const chosenServiceTier = readAgentRuntimeServiceTier(selection.options);
  const selectedServiceTier =
    chosenServiceTier !== undefined
      ? chosenServiceTier
      : (readAgentRuntimeServiceTier(
          serviceTierDescriptor?.type === "select" && serviceTierDescriptor.currentValue
            ? [{ id: "serviceTier", value: serviceTierDescriptor.currentValue }]
            : undefined,
        ) ?? null);
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
  // An imported native conversation stays empty until its Agent restores it on the next message.
  const pendingImport = acpPendingImportedHistory(projection);
  const presentation: ConversationProviderPresentation = {
    resolveRuntimeAttachment: async (reference) => {
      if (!target) throw new Error("Open the conversation before reading its attachment");
      const result = await agentRuntimeRuntime.attachment({ ...target, ...reference });
      if (!result) throw new Error("Image unavailable");
      return "dataUrl" in result ? result.dataUrl : result.path;
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
    emptyHistory: pendingImport
      ? acpImportedHistoryEmptyState(provider?.displayName ?? "the Agent", pendingImport)
      : null,
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
      reload: reloadCatalog,
      configOptions,
      changeConfig,
      runtimeOptions: [],
      chooseRuntime: () => {},
      manage: () => openSettingsFor(selection.binding),
      setups: [...(openCodeSetup.setup ? [openCodeSetup.setup] : []), ...acpSetup.setups],
    },
    commands:
      provider?.slashCommands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        inputHint: command.input?.hint ?? null,
      })) ?? [],
    controls: {
      steer: true,

      images: agentRuntimeImageInputSupport(currentModel) === "supported",
      skills: true,
      subagents: true,
      goals: false,
    },
    imageInputUnavailableReason: agentRuntimeImageInputUnavailableReason(currentModel),
    imageInputForSelection: (modelSelection) => {
      const model = catalogState.providers
        .find((entry) => entry.instanceId === modelSelection.instanceId)
        ?.models.find((entry) => entry.slug === modelSelection.model);
      return {
        supported: agentRuntimeImageInputSupport(model) === "supported",
        unavailableReason: agentRuntimeImageInputUnavailableReason(model),
      };
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
      : acpSetup.status
        ? acpSetup.status
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
