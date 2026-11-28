import { componentReadinessLabel } from "../app-components/provider-component-setup";
import { CODEX_AGENT_BACKEND_BINDING } from "../../../shared/agent-backend";
import { agentDefinition } from "../../../shared/agents/registry";
import { NEW_CHAT_TITLE } from "../../../shared/session-title";
import { formatComposerSkillDisplayName } from "../../../shared/composer-skill-display";
import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { agentRuntimeImageInputUnavailableMessage } from "../../../shared/agent-runtime-image-input";
import { useModelPolicy } from "../model-policy/model-policy";
import { subscribeProviderComponentReadiness } from "../app-components/use-app-components";
import { useComposerAgentSetup } from "../agent-readiness/use-composer-agent-setup";
import { agentReadinessView } from "@/lib/agent-readiness-view";
import {
  buildSettingsAnchorPath,
  buildSettingsPath,
} from "@/components/workbench/workbench-settings-routes";
import { agentModelKey } from "@/lib/agent-model-selection";
import { formatNodexMultiplier } from "@/lib/nodex-model-prices";
import {
  isModelOn,
  isProviderOn,
  policyProviderKey,
  spendsNodexCredit,
  modelPolicyFailure,
  setModelOn,
  projectModelPolicyCatalog,
} from "../../../shared/model-policy";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { isHostedChat, isLocalPath, separateHostedChatUploads } from "@/lib/hosted-chat";
import { useChatCapabilities } from "@/lib/use-chat-capabilities";
import { SPACE_ACTION_REASON_MESSAGES } from "../../../shared/space-connection";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../../shared/agent-runtime-settings";
import { resolveAgentRuntimeMode } from "@/lib/agent-runtime-mode";
import { agentRuntimeSettingsQueryOptions } from "@/lib/agent-runtime-settings";
import { hostedChatMemberActionsQueryOptions } from "@/lib/query-options";
import { planAgentApprovalDeclineOnSend } from "./agent-approval";
import { approvalsRefusedBySend } from "./agent-approval-runtime";
import {
  composerDraftIntents,
  requestComposerFocus,
  type ComposerChatKey,
} from "@/lib/composer-draft-intents";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { isNodexProviderId, NODEX_MODELS } from "../../../shared/nodex-models";
import { isManagedRuntimeInstanceId } from "../../../shared/managed-runtime-instances";
import { useNodexAccount } from "../nodex-account/use-nodex-account";
import { subscribeNodexAccountChanges } from "../../lib/nodex-account-runtime";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  agentRuntimeModelOptionMemoryAtom,
  agentRuntimeNewChatChoiceAtom,
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
  applyAgentRuntimeOptionIntent,
  fitAgentRuntimeServiceTier,
  isAgentRuntimeEffortOption,
  readAgentRuntimeEffort,
  readAgentRuntimeServiceTier,
} from "../../../shared/agent-runtime-provider";
import {
  agentRuntimeAgentSwitchRefusalMessage,
  AGENT_RUNTIME_AGENT_SWITCH_MESSAGES,
  agentRuntimePendingSelection,
  agentRuntimeSelectionRefusal,
} from "../../../shared/agent-runtime-agent-switch";
import { agentRuntimeForkSource } from "../../../shared/agent-runtime-fork-merge";
import { formatAgentModelName } from "../../lib/codex-thread-settings";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";
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
  agentRuntimeBinding,
  agentRuntimeProviderLabel,
  defaultAgentRuntimeModelSelection,
  isAgentRuntimeProviderAvailable,
  projectAgentRuntimeModel,
  requireAgentRuntimeModelSelection,
  resolveAgentRuntimeChatModel,
} from "../../lib/agent-runtime-model-selection";
import {
  agentRuntimePromptImages,
  agentRuntimeImageInputSupport,
  prepareAgentRuntimeMessage,
} from "../../lib/agent-runtime-prompt";
import { workspaceSessionCommands } from "../../lib/workspace-catalog-commands";
import {
  acquireAgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwnerSnapshot,
} from "./agent-runtime-conversation-owner";
import type { ConversationContentSource, ConversationRuntime } from "./conversation-runtime";
import type {
  ComposerNotice,
  ThreadStageActions,
  ConversationProviderPresentation,
} from "./thread-stage-types";
import type { AgentModelPickerEntry } from "../../components/shared/agent-runtime/agent-model-picker";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import { setLocalConversationThreadPresented } from "./local-conversation-store";
import { resolveComposerInventoryIconUrl } from "../../../shared/codex-composer-inventory-icon";
import { threadWorkspaceAvailabilityQuery } from "@/lib/managed-worktree-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { ThreadWorkspaceAvailability } from "../../../shared/types";
import { spaceQueryKey } from "@/lib/renderer-space";
import { subscribeComposerSkillInvalidation } from "@/lib/skill-inventory-adapter";
import { subscribeAgentCatalogRefresh } from "@/lib/agent-catalog-refresh";
import { agentTeammate } from "@/lib/agent-team";
import { useFirstRunEntry } from "@/features/first-run/first-run-state";
import { chatTipFacts } from "@/features/tips/tips-model";
import { useComposerTip } from "@/features/tips/use-composer-tip";
import { agentReadinessNotice, connectAgentNotice } from "./agent-readiness-notice";
import { useWindowsSandboxSetup } from "./use-windows-sandbox-setup";
import { resolveCodexRendererOs } from "@/lib/codex-window-runtime";
import { copyAgentRuntimeConversationMarkdown } from "./agent-runtime-markdown-export";
import {
  agentRuntimeDelegatedTasks,
  createAgentRuntimeDelegatedTaskPort,
} from "./agent-runtime-delegated-tasks";
import { useAgentRuntimeBackgroundTasks } from "./agent-runtime-background-tasks";
import {
  acpImportedHistoryEmptyState,
  acpPendingImportedHistory,
} from "../acp-agents/acp-agent-model";
import {
  agentModelsSettingsAnchor,
  NODEX_MODELS_ANCHOR,
  useAgentSettingsNavigation,
} from "@/lib/agent-settings-navigation";
import type { AgentRuntimeRun } from "./agent-runtime-transcript-projection";
import {
  agentRuntimeActivityStore,
  useAgentRuntimeConnectionState,
} from "../../lib/agent-runtime-session-activity";
import { useWorkbenchWindowOwner } from "../../lib/use-workbench-window-state";
import {
  captureCodexTurnPresentation,
  readCodexSubmissionPresentation,
} from "../../lib/codex-turn-presentation";
import type { CodexTurnPresentationTarget } from "../../../shared/nodex-app-tools/turn-presentation";
import type { CodexTurnPresentationTicket } from "../../../shared/schemas/agent-runtime-api";
import type { WorkbenchSubmitPresentation } from "../../../shared/nodex-app-tools/workbench";
import { projectMessageText } from "../../../shared/message-agent-input";
import { materializeWrittenImages } from "../../lib/prompt-file-images";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";

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
const connectedBusy = { status: "connected", retries: 0, busy: true } as const;
const starting = { status: "starting", retries: 0 } as const;
const connectionViews = new WeakMap<AgentRuntimeConnectionState, CodexConnectionState>();

/**
 * The latest Run failed while its workspace was being prepared: it records a preparation
 * strategy and never started. Returns its id so the user can retry or work locally.
 */
export function failedWorkspacePreparation(runs: readonly UnstartedRunEvidence[]): string | null {
  const latest = latestByOrdinal(runs);
  return latest?.status === "failed" && latest.workspacePreparation && !latest.startedAt
    ? latest.id
    : null;
}

interface UnstartedRunEvidence {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly workspacePreparation?: unknown;
}

function latestByOrdinal<T extends { readonly ordinal: number }>(runs: readonly T[]): T | null {
  return runs.reduce<T | null>(
    (best, run) => (best === null || run.ordinal > best.ordinal ? run : best),
    null,
  );
}

/**
 * The latest Run failed before it started and outside workspace preparation, such as when its
 * working directory had disappeared. Returns its id so the chat rechecks where it runs.
 */
export function unstartedRunFailure(runs: readonly UnstartedRunEvidence[]): string | null {
  const latest = latestByOrdinal(runs);
  return latest?.status === "failed" && !latest.startedAt && !latest.workspacePreparation
    ? latest.id
    : null;
}

export function shouldRetryWorkspaceMissingRun(
  failedRunId: string,
  availability: ThreadWorkspaceAvailability["state"] | undefined,
  attempted: ReadonlySet<string>,
): boolean {
  return availability === "available" && !attempted.has(failedRunId);
}

/** One supervised execution process serves every Runtime chat; an idle process starts on use. */
export function projectAgentRuntimeConnection(
  state: AgentRuntimeConnectionState,
): CodexConnectionState {
  if (state.status === "ready" && state.busy) return connectedBusy;
  if (state.status === "idle" || state.status === "ready" || state.status === "unresponsive")
    return connected;
  if (state.status === "starting") return starting;
  const cached = connectionViews.get(state);
  if (cached) return cached;
  const view: CodexConnectionState =
    state.status === "restarting"
      ? {
          status: "disconnected",
          retries: state.attempt,
          message: getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.agentRestarting",
            defaultMessage: "Agent execution is restarting",
          }),
        }
      : { status: "error", retries: 0, message: state.message };
  connectionViews.set(state, view);
  return view;
}
const emptyChildren = [] as const;
const runtimePorts = new WeakMap<AgentRuntimeConversationOwner, Map<string, ConversationRuntime>>();

/**
 * Which of a shared chat's Runs this reader may stop the work of, as Core answered for the Runs
 * it was asked about; any other Run, or a task naming none, stops only for those who manage it.
 */
export interface AgentRuntimeRunStops {
  readonly canManage: boolean;
  readonly runIds: readonly string[];
}

/** A product view over the engine read owner. Session identity remains the command boundary. */
export function createAgentRuntimeConversationRuntime(
  kind: AgentBackendBinding["driver"],
  target: AgentRuntimeSessionTarget | null,
  owner: AgentRuntimeConversationOwner | null,
  /** Absent for a chat on this computer, whose only Member stops all of its work. */
  stops?: AgentRuntimeRunStops,
): ConversationRuntime {
  const ports = owner ? (runtimePorts.get(owner) ?? new Map<string, ConversationRuntime>()) : null;
  const portKey = JSON.stringify([kind, stops ? [stops.canManage, stops.runIds] : null]);
  const previous = ports?.get(portKey);
  if (previous) return previous;
  const matches = (id: string | null) => owner !== null && id === owner.threadId;
  const runtime: ConversationRuntime = {
    kind,
    approvals: owner?.approvals,
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
        sourceIdentity: source.identity,
        loadBoundary: (boundary) =>
          source.isCurrent() ? owner!.loadHistoryBoundary(boundary) : Promise.resolve("stale"),
        installSearchItem: (item, signal) =>
          source.isCurrent()
            ? owner!.loadHistoryThroughSearchItem(item, signal)
            : Promise.resolve("stale"),
        promptRail: {
          installMessage: async (messageId, signal) =>
            source.isCurrent() ? owner!.loadHistoryThroughMessage(messageId, signal) : "stale",
          loadIndex: async () => (source.isCurrent() ? owner!.readPromptIndex() : null),
          install: async (runId) =>
            source.isCurrent() ? owner!.loadHistoryThroughRun(runId) : "stale",
        },
      };
    },
    attachment: (id) => {
      if (!matches(id)) return { status: "idle" };
      const state = owner!.getSnapshot();
      if (state.connection === "failed")
        return {
          status: "failed",
          message:
            state.error ??
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.openFailed",
              defaultMessage: "Could not open conversation",
            }),
        };
      return state.connection === "ready" ? { status: "attached" } : { status: "attaching" };
    },
    connection: () => projectAgentRuntimeConnection(agentRuntimeActivityStore.readConnection()),
    role: (id) => (matches(id) ? "follower" : null),
    // Each delegated task offers Stop only to whoever may stop the Run that started it.
    ...(target
      ? {
          delegatedTasks: createAgentRuntimeDelegatedTaskPort(
            target.sessionId,
            agentRuntimeRuntime,
            agentRuntimeDelegatedTasks,
            stops
              ? (ownerRunId) =>
                  stops.canManage || (ownerRunId !== null && stops.runIds.includes(ownerRunId))
              : undefined,
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
              for (const request of requests) {
                const requestReplies = replies.filter((reply) =>
                  owner
                    .asyncQuestionAnswers([reply])
                    .some((answer) => answer.requestId === request.requestId),
                );
                const submissionId = await owner.asyncQuestions.prepareSubmission(
                  owner.threadId,
                  requestReplies,
                );
                await agentRuntimeRuntime.respond({
                  ...target,
                  threadId: owner.threadId,
                  ...request,
                  submissionId,
                });
                owner.asyncQuestions.acknowledge(owner.threadId, requestReplies);
              }
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
      if (isHostedChat()) return;
      if (matches(id)) await setLocalConversationThreadPresented(id, surfaceId, presented, "local");
    },
  };
  if (owner && ports) {
    ports.set(portKey, runtime);
    runtimePorts.set(owner, ports);
  }
  return runtime;
}

function imageInput(model: Parameters<typeof agentRuntimeImageInputSupport>[0], intl: IntlShape) {
  const reason = agentRuntimeImageInputUnavailableMessage(model);
  return {
    supported: agentRuntimeImageInputSupport(model) === "supported",
    unavailableReason: reason ? intl.formatMessage(reason) : null,
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

/**
 * What a team Space's host does not do for a chat a Member reaches through it (see
 * RemoteHostIpc). A hosted chat offers none of these, so nothing fails after a click.
 */
/** A hosted chat with no Agent ready on its host: only the host's own setup can fix it. */
const hostedAgentUnavailableNotice = (intl: IntlShape): ComposerNotice => ({
  key: "agent:host",
  tone: "warning",
  title: intl.formatMessage({
    id: "conversation.agentRuntimeConversationAdapter.hostAgentUnavailable",
    defaultMessage: "No Agent on this Space's host can run this chat",
  }),
  detail: intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteAgent),
  actions: [],
});

const HOST_UNAVAILABLE_ACTIONS = [
  // A hosted chat runs on its host's Agents, whose settings are not this Device's.
  "onManageFailedProvider",
] as const satisfies readonly (keyof ThreadStageActions)[];
/** A chat's context belongs to whoever may manage it: its owner or a Space Owner. */
const MANAGE_ACTIONS = [
  "onCompactThread",
  "onClearContext",
  "onCompactAndRetry",
] as const satisfies readonly (keyof ThreadStageActions)[];
const without = (
  actions: Partial<ThreadStageActions>,
  names: readonly (keyof ThreadStageActions)[],
): Partial<ThreadStageActions> =>
  Object.fromEntries(
    Object.entries(actions).filter(([name]) => !(names as readonly string[]).includes(name)),
  );

/** Shared editor controls address the exact Session/Thread/Run observed by the read owner. */
export function createAgentRuntimeStageActions(input: {
  /** Child conversations share their root's product Session but have their own draft channel. */
  readonly composerChatKey?: ComposerChatKey;
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
        Partial<
          Pick<AgentRuntimeConversationOwner, "contentSource" | "whenObserved" | "approvals">
        >)
    | null;
  readonly transport?: AgentRuntimeRendererTransport;
  readonly prepare: (
    text: string,
    promptInput?: CodexPromptInput,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
    modelSelection?: NonNullable<AgentRuntimeMessage["modelSelection"]>,
  ) => Promise<Pick<AgentRuntimeMessage, "text" | "context" | "uploads" | "skillInvocations">>;
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
  /** A chat on a team Space's host: only operations its host admits are offered. */
  readonly hosted?: boolean;
  /**
   * Whether the reader may manage this chat, compacting and clearing its context: its owner or a
   * Space Owner, as Core decides. A chat on this computer belongs to its only Member, who may.
   */
  readonly manage?: boolean;
  /** The mode a hosted chat's next message asks for; a local chat applies its mode at once. */
  readonly nextInteractionMode?: () => AgentRuntimeMessage["interactionMode"] | null;
  readonly manageProvider?: (instanceId: string) => void;
  readonly onSideChatTitle?: (title: string) => void;
}): Partial<ThreadStageActions> {
  const transport = input.transport ?? agentRuntimeRuntime;
  // A choice travels with the message that uses it; the Runtime applies it to that message's Run.
  const chosenSelection = () => {
    const modelSelection = input.nextSelection?.();
    const interactionMode = input.nextInteractionMode?.();
    return {
      ...(modelSelection ? { modelSelection } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  };
  const requireTarget = () => {
    const target = input.target();
    if (!target)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.openToSend",
          defaultMessage: "Open a conversation before sending a message",
        }),
      );
    return target;
  };
  const dispatch = async (
    text: string,
    promptInput?: CodexPromptInput,
    intent?: "steer",
    submitted?: WorkbenchSubmitPresentation,
    appMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage,
    admission?: {
      readonly assertCurrent?: () => void;
      readonly messageId: string;
      readonly presentationTicket?: CodexTurnPresentationTicket;
    },
  ) => {
    const target = requireTarget();
    const approvalRuntime = input.owner()?.approvals;
    // Choose before Send releases the typing hold, so a held request is not refused unseen.
    const approvals = approvalRuntime ? approvalsRefusedBySend(approvalRuntime.getSnapshot()) : [];
    approvalRuntime?.interact({ type: "send" });
    const plan = planAgentApprovalDeclineOnSend(approvals, text);
    for (const response of plan.responses)
      await approvalRuntime!.respond(response.requestId, response.response);
    const hasSupplementalInput =
      Boolean(appMessage) ||
      Object.entries(promptInput ?? {}).some(
        ([key, value]) =>
          key !== "text" && (Array.isArray(value) ? value.length > 0 : value != null),
      );
    if (plan.responses.length && plan.steerMessage === null && !hasSupplementalInput) return;
    if (plan.responses.length) intent = plan.steer ? "steer" : undefined;
    const messageId = admission?.messageId ?? createUuidV7();
    const presentationTicket =
      admission?.presentationTicket ??
      (target.threadId
        ? await input.capturePresentation?.(
            { kind: "thread", threadId: target.threadId },
            submitted,
          )
        : undefined);
    const messageText = plan.responses.length ? (plan.steerMessage ?? "") : text;
    const prepared = await input.prepare(
      messageText,
      plan.responses.length && promptInput ? { ...promptInput, text: messageText } : promptInput,
      appMessage,
    );
    admission?.assertCurrent?.();
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
    if (accepted.sideChatTitle !== undefined) input.onSideChatTitle?.(accepted.sideChatTitle);
  };
  const continueAfterFailure = async (turnId: string, compact = false): Promise<void> => {
    const target = { ...requireTarget() };
    const owner = input.owner();
    const source = owner?.contentSource?.();
    if (!owner || !source)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.openToContinue",
          defaultMessage: "Open the conversation before continuing",
        }),
      );
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
          throw new Error(
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.sourceChanged",
              defaultMessage: "Conversation source changed",
            }),
          );
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
          throw new Error(
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.cannotContinueTurn",
              defaultMessage: "This turn can no longer be continued",
            }),
          );
      };
      assertCurrent();
      if (compact) {
        const accepted = await transport.compact({
          ...target,
          failedRunId: turnId,
          requestId: `context-recovery:${turnId}`,
        });
        await owner.whenObserved?.(accepted.sequence);
        return;
      }
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
        if (!owner?.contentSource?.()?.isCurrent())
          throw new Error(
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.sourceChanged",
              defaultMessage: "Conversation source changed",
            }),
          );
        const runs = owner.getSnapshot().conversation?.snapshot.projection.runs ?? [];
        const latest = latestRuntimeRun(runs);
        if (latest?.id !== turnId || latest.status !== "failed")
          throw new Error(
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.notLatestFailure",
              defaultMessage: "This turn is no longer the latest failure",
            }),
          );
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
    if (!request)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.requestAnswered",
          defaultMessage: "This request is no longer pending",
        }),
      );
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
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.identityChanged",
          defaultMessage: "Conversation identity changed",
        }),
      );
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
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.sourceChanged",
            defaultMessage: "Conversation source changed",
          }),
        );
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
    if (accepted.sideChatTitle !== undefined) input.onSideChatTitle?.(accepted.sideChatTitle);
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
    if (!queued)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.queuedMessageUnavailable",
          defaultMessage: "This queued message is no longer pending",
        }),
      );
    const original = await transport.readRunMessage({ ...target, runId });
    if (original?.id !== queued.clientUserMessageId)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.queuedMessageUnavailable",
          defaultMessage: "This queued message is no longer pending",
        }),
      );
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
        ...(await input.prepare(prompt, promptInput, undefined, selection).then((compiled) => ({
          ...compiled,
          ...retainAgentAppContext(compiled, original, false),
          skillInvocations: compiled.skillInvocations ?? [],
        }))),
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
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.queuedMessageUnavailable",
          defaultMessage: "This queued message is no longer pending",
        }),
      );
    return run.modelSelection;
  };
  const actions: Partial<ThreadStageActions> = {
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
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.identityChanged",
            defaultMessage: "Conversation identity changed",
          }),
        );
      await transport.compact({ ...target, requestId: createUuidV7() });
    },
    onClearContext: async () => {
      await transport.clearContext({ ...requireTarget(), requestId: createUuidV7() });
    },
    onSendPrompt: (text, options) =>
      dispatch(
        text,
        options?.promptInput,
        undefined,
        options?.submittedPresentation,
        options?.untrustedAppMessage,
        options?.submissionIdentity
          ? {
              messageId: options.submissionIdentity.clientUserMessageId,
              presentationTicket: options.presentationTicket,
            }
          : undefined,
      ),
    onContinueAfterFailure: continueAfterFailure,
    onCompactAndRetry: (turnId) => continueAfterFailure(turnId, true),
    onManageFailedProvider: manageFailedProvider,
    onEditUserTurn: async (request) => {
      const target = exactTarget(request.threadId);
      const owner = input.owner();
      if (!owner)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.openToEdit",
            defaultMessage: "Open the conversation before editing this message",
          }),
        );
      const original = await owner.readSentMessage(request.turnId, [...request.images]);
      // Images written into the edit follow the selected attachments.
      const written = projectMessageText(request.message, {
        precedingImageCount: original.images?.length ?? 0,
      });
      // Agent Runtime chats run on this computer.
      const promptInput = (await materializeWrittenImages(
        { ...written, images: [...(original.images ?? []), ...(written.images ?? [])] },
        DEFAULT_CODEX_HOST_ID,
      ))!;
      const presentationTicket = await input.capturePresentation?.({
        kind: "thread",
        threadId: request.threadId,
      });
      // Compile before rewinding: a message the Agent cannot accept must not discard any history.
      const compiled = await input.prepare(promptInput.text, promptInput);
      const prepared = { ...compiled, ...retainAgentAppContext(compiled, original.message) };
      const accepted = await transport.rewriteMessage({
        requestId: createUuidV7(),
        runId: request.turnId,
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
      const owner = input.owner();
      const accepted = await transport.queue({
        ...exactTarget(threadId),
        requestId: createUuidV7(),
        action: "resume",
      });
      await owner?.whenObserved?.(accepted.sequence);
      if (accepted.sideChatTitle !== undefined) input.onSideChatTitle?.(accepted.sideChatTitle);
    },
    onReplaceQueuedFollowUp: async (threadId, runId, _revision, prompt, options) => {
      await editQueuedMessage(threadId, runId, prompt, options?.promptInput);
      return true;
    },
    onEditQueuedFollowUp: async (request) => {
      const target = exactTarget(request.threadId);
      const queued = input
        .owner()
        ?.getSnapshot()
        .view?.queuedFollowUps?.entries.find((entry) => entry.followUpId === request.followUpId);
      if (!queued)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.queuedMessageUnavailable",
            defaultMessage: "This queued message is no longer pending",
          }),
        );
      const owner = input.owner();
      if (!owner)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.openToEdit",
            defaultMessage: "Open the conversation before editing this message",
          }),
        );
      const queuedInput = await owner.readQueuedInput(request.followUpId);
      const modelSelection = await readQueuedSelection(request.threadId, request.followUpId);
      composerDraftIntents.set(
        input.composerChatKey ?? { kind: "session", sessionId: target.sessionId },
        {
          prompt: queuedInput.text,
          attachmentMode: "replace",
          promptInput: { ...request.promptInput, ...queuedInput },
          queuedFollowUpEdit: {
            followUpId: request.followUpId,
            ledgerRevision: request.ledgerRevision ?? 0,
            modelSelection,
          },
          focusNonce: Date.now(),
        },
      );
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
        const owner = input.owner();
        const accepted = await transport.queue({
          ...target,
          requestId: createUuidV7(),
          action: "resume",
          runId,
        });
        await owner?.whenObserved?.(accepted.sequence);
        if (accepted.sideChatTitle !== undefined) input.onSideChatTitle?.(accepted.sideChatTitle);
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
    onRespondApproval: async (requestId, response) => {
      requireTarget();
      const approvals = input.owner()?.approvals;
      if (!approvals)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.noApproval",
            defaultMessage: "This conversation has no approval to answer",
          }),
        );
      await approvals.respond(requestId, response);
    },
    onRespondUserInput: (id, answers) =>
      respond(id, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, values]) => [key, values.join("\n")]),
        ),
      }),
  };
  if (!input.hosted) return actions;
  return without(actions, [
    ...HOST_UNAVAILABLE_ACTIONS,
    ...(input.manage === true ? [] : MANAGE_ACTIONS),
  ]);
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
  readonly onSideChatTitle?: (title: string) => void;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  readonly onLaunched?: (
    result: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult,
  ) => Promise<void>;
  readonly ensureDraft: (projectId: string | null) => Promise<{ readonly id: string }>;
  readonly materializeDraft?: import("./thread-stage-types").SessionThreadCommands["onMaterializeProjectDraft"];
  readonly commitDraft?: import("./thread-stage-types").SessionThreadCommands["onCommitMaterializedProjectDraft"];
}) {
  const intl = useIntl();
  const workbenchOwner = useWorkbenchWindowOwner();
  const queryClient = useQueryClient();
  const nodexAccount = useNodexAccount(true);
  const modelPolicyState = useModelPolicy();
  const hosted = isHostedChat();
  const [catalogState, setCatalogState] = useState<{
    providers: readonly AgentRuntimeProvider[];
    loading: boolean;
    error: string | null;
  }>({ providers: [], loading: true, error: null });
  // A forced read makes providers check again; a plain read returns their current state.
  const [catalogRequest, setCatalogRequest] = useState({ revision: 0, refresh: false });
  const refreshCatalog = () =>
    setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: true }));
  // Each "Check again" settles once the read it started has answered.
  const catalogWaiters = useRef<(() => void)[]>([]);
  const checkCatalogAgain = () =>
    new Promise<void>((resolve) => {
      catalogWaiters.current.push(resolve);
      refreshCatalog();
    });
  const reloadCatalog = () =>
    setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: false }));
  const agentSetup = useComposerAgentSetup({
    hosted,
    instances: input.instances,
    refreshCatalog,
    checkCatalogAgain,
  });
  useEffect(() => {
    if (hosted) return;
    return subscribeProviderComponentReadiness(() => {
      setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: false }));
    });
  }, [hosted]);
  // A first message sent while the catalog is still loading waits for it to choose a model.
  const catalogLoad = useRef<Promise<readonly AgentRuntimeProvider[]> | null>(null);
  useEffect(
    () =>
      subscribeNodexAccountChanges(() => {
        setCatalogRequest((value) => ({ ...value, revision: value.revision + 1 }));
      }),
    [],
  );
  useEffect(
    () =>
      subscribeAgentCatalogRefresh(() => {
        setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: false }));
      }),
    [],
  );
  useEffect(
    () =>
      subscribeComposerSkillInvalidation(() => {
        setCatalogRequest(({ revision }) => ({ revision: revision + 1, refresh: true }));
        void queryClient.invalidateQueries({
          queryKey: spaceQueryKey(["agent-runtime", "composer-skills"]),
        });
      }),
    [queryClient],
  );
  const { connectAgent } = useFirstRunEntry();
  useEffect(() => {
    let active = true;
    const load = agentRuntimeRuntime
      .catalog({ refresh: catalogRequest.refresh })
      .then((providers) =>
        projectModelPolicyCatalog(providers, modelPolicyState.settings).filter(
          (provider) =>
            isManagedRuntimeInstanceId(provider.instanceId) ||
            !agentDefinition(provider.driver).profileBased ||
            input.instances.some((instance) => instance.binding.instanceId === provider.instanceId),
        ),
      );
    catalogLoad.current = load;
    const waiters = catalogWaiters.current;
    void load
      .then(
        (providers) => ({ providers, loading: false, error: null }),
        (cause: unknown) => ({
          providers: [],
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .then((next) => {
        if (!active) return;
        setCatalogState(next);
        for (const resolve of waiters.splice(0)) resolve();
      });
    return () => {
      active = false;
    };
  }, [catalogRequest, input.instances, catalogLoad, catalogWaiters, modelPolicyState.settings]);
  const bindingFor = (instanceId: string) => {
    const provider = catalogState.providers.find((entry) => entry.instanceId === instanceId);
    if (provider) return agentRuntimeBinding(provider);
    if (instanceId === CODEX_AGENT_BACKEND_BINDING.instanceId) return CODEX_AGENT_BACKEND_BINDING;
    return input.instances.find((entry) => entry.binding.instanceId === instanceId)?.binding;
  };
  const openAgentSettings = useAgentSettingsNavigation();
  useEffect(() => {
    agentRuntimeDelegatedTasks.publishLabels(
      new Map(
        catalogState.providers.flatMap((provider) => {
          const binding = agentRuntimeBinding(provider);
          return [
            [
              provider.instanceId,
              {
                label: agentRuntimeProviderLabel(provider, input.instances),
                kind: binding.driver,
                models: new Map(
                  provider.models.map((model) => [model.slug, formatAgentModelName(model.name)]),
                ),
              },
            ],
          ];
        }),
      ),
    );
  }, [catalogState.providers, input.instances]);
  const { serviceTierSettings: savedServiceTier, setServiceTier: saveServiceTier } =
    useCodexServiceTierSettings();
  // Choices persist beside the Composer's prompt draft, across windows and restart.
  const choices = usePersistedAtomValue(agentRuntimeComposerChoicesAtom).value;
  const setChoices = useSetPersistedAtom(agentRuntimeComposerChoicesAtom);
  const writeChoice = (key: string, patch: Partial<AgentRuntimeComposerChoice>) =>
    setChoices((current) => withAgentRuntimeComposerChoice(current, key, patch));
  const modelOptionMemory = usePersistedAtomValue(agentRuntimeModelOptionMemoryAtom).value;
  const setModelOptionMemory = useSetPersistedAtom(agentRuntimeModelOptionMemoryAtom);
  const newChatChoice = usePersistedAtomValue(agentRuntimeNewChatChoiceAtom()).value;
  const setNewChatChoice = useSetPersistedAtom(agentRuntimeNewChatChoiceAtom());
  const draftKey = agentRuntimeChoiceKey.draft(input.sessionId, input.modelProjectId);
  const draft = choices[draftKey] ?? {};
  const draftMode = draft.interactionMode ?? "default";
  const runtimeSettings = useQuery(agentRuntimeSettingsQueryOptions());
  const defaultRuntimeMode =
    runtimeSettings.data?.defaultRuntimeMode ?? DEFAULT_AGENT_RUNTIME_SETTINGS.defaultRuntimeMode;
  const draftRuntimeMode = draft.runtimeMode ?? defaultRuntimeMode;
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
  // In a chat with several Members, Core says what the reader may manage or stop, and which
  // person messages are theirs to edit.
  const capabilities = useChatCapabilities(input.sessionId);
  const memberActions = useQuery(
    hostedChatMemberActionsQueryOptions(
      targetSessionId,
      isHostedChat() && state.conversation ? (owner?.rewindTargetIds() ?? []) : [],
    ),
  ).data;
  const memberEdits = useMemo(
    () =>
      memberActions
        ? new Map(memberActions.runs.map(({ run_id, edit }) => [run_id, edit] as const))
        : undefined,
    [memberActions],
  );
  useEffect(() => acquired?.retain({ view: true }), [acquired]);
  const runtimeConnection = useAgentRuntimeConnectionState();
  const [catalogConnection, setCatalogConnection] = useState(runtimeConnection.status);
  if (catalogConnection !== runtimeConnection.status) {
    setCatalogConnection(runtimeConnection.status);
    if (runtimeConnection.status === "ready" && catalogState.error) refreshCatalog();
  }
  const projection = state.conversation?.snapshot.projection;
  const nativeSessions = projection?.providerSessions;
  // A native session can negotiate capabilities that its initial catalog did not know.
  // Session lifecycle events invalidate that read without forcing a new provider probe.
  const [catalogSessions, setCatalogSessions] = useState<typeof nativeSessions>(undefined);
  if (catalogSessions !== nativeSessions) {
    setCatalogSessions(nativeSessions);
    if (nativeSessions?.length) reloadCatalog();
  }
  const observed = projection?.thread;
  const admissionRunId = projection?.runs.findLast((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  )?.id;
  /** A discounted Nodex model says so wherever it's chosen, the same way its price row does. */
  const withNodexRate = (label: string, provider: AgentRuntimeProvider, model: string) => {
    const rate = spendsNodexCredit(provider)
      ? nodexAccount.snapshot?.modelStatus?.pricing?.groups[0]?.models.find(
          ({ id }) => id === model,
        )?.multiplier
      : null;
    return rate && rate !== 1 ? `${label} ${formatNodexMultiplier(rate)}` : label;
  };
  const entriesFor = (
    providers: readonly AgentRuntimeProvider[],
  ): readonly AgentModelPickerEntry[] =>
    providers.flatMap((provider) => {
      const binding = agentRuntimeBinding(provider);
      const readiness = agentSetup.read(binding, provider);
      const onDemand = readiness?.problem.kind === "not-installed" && readiness.problem.onDemand;
      const componentBlocked =
        provider.installationSource?.kind === "component" && readiness?.blocksSend;
      const signedOutWithDirectSignIn =
        provider.installed &&
        readiness?.action?.kind === "sign-in" &&
        readiness.action.via === "browser";
      if (
        !isAgentRuntimeProviderAvailable(provider) &&
        !componentBlocked &&
        !onDemand &&
        !signedOutWithDirectSignIn
      )
        return [];
      const setup =
        componentBlocked && readiness
          ? agentReadinessView(
              agentRuntimeProviderLabel(provider, input.instances),
              readiness,
              intl,
            )
          : null;
      return provider.models.map((model) => ({
        binding,
        spendsCredit: spendsNodexCredit(provider),
        label: withNodexRate(
          agentRuntimeProviderLabel(provider, input.instances),
          provider,
          model.slug,
        ),
        model: projectAgentRuntimeModel(provider, model),
        selection: { binding, model: model.slug },
        ...(setup ? { unavailableReason: setup.title, unavailableLabel: setup.hint } : {}),
      }));
    });
  const draftSelectionFor = (providers: readonly AgentRuntimeProvider[]): AgentModelSelection => {
    if (draft.selection) return draft.selection;
    const selected = defaultAgentRuntimeModelSelection(providers, {
      remembered: newChatChoice,
      codexServiceTier: savedServiceTier.serviceTier,
      attended: true,
    });
    const provider = providers.find((entry) => entry.instanceId === selected?.instanceId);
    const binding = provider ? agentRuntimeBinding(provider) : undefined;
    return selected && binding
      ? { binding, model: selected.model, options: selected.options }
      : { binding: CODEX_AGENT_BACKEND_BINDING, model: "" };
  };
  /** The default Agent's model, read alone first; the whole catalog only when it has none. */
  const resolveDefaultSelection = async () => {
    const whole = catalogLoad.current;
    const preferred = draftSelectionFor(
      await agentRuntimeRuntime
        .catalog({
          instanceIds: [(newChatChoice && newChatChoice.binding.instanceId) ?? "codex"],
        })
        .catch((): readonly AgentRuntimeProvider[] => []),
    );
    if (agentRuntimeModelSelection(preferred.binding, preferred.model, preferred.options))
      return preferred;
    if (!whole)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.chooseConfiguredAgent",
          defaultMessage: "Choose a configured Agent and model",
        }),
      );
    return draftSelectionFor(await whole);
  };
  const modelOf = (candidate: AgentModelSelection) =>
    agentRuntimeModelSelection(candidate.binding, candidate.model, candidate.options);
  const providerOf = (candidate: AgentModelSelection) =>
    catalogState.providers.find((entry) => entry.instanceId === candidate.binding.instanceId);
  // A started chat's choice for its next message; the chat keeps its own until a message uses it.
  const choiceKey = targetThreadId ? agentRuntimeChoiceKey.chat(targetThreadId) : null;
  const choice = choiceKey ? choices[choiceKey]?.selection : undefined;
  const observedSelection: AgentModelSelection | undefined = observed
    ? {
        binding: bindingFor(observed.modelSelection.instanceId) ?? {
          driver: "unknown",
          instanceId: observed.modelSelection.instanceId,
        },
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
  // A hosted chat's host takes its mode only with a message, so the mode waits beside the draft
  // until the chat runs in it.
  const choiceMode = choiceKey ? choices[choiceKey]?.interactionMode : undefined;
  const nextMode = observed && choiceMode !== observed.interactionMode ? choiceMode : undefined;
  // A choice the chat has since applied is spent, so a later change elsewhere is not undone. Once
  // the chat is open, the unstarted draft it launched from has nothing left to choose.
  const spentChoice = Boolean(choiceKey && choice && observed && !nextSelection);
  const spentMode = Boolean(choiceKey && choiceMode && observed && !nextMode);
  const spentDraft = Boolean(observed && choices[draftKey]);
  useEffect(() => {
    if (!spentChoice && !spentMode && !spentDraft) return;
    void setChoices((current) => {
      const unspent =
        (spentChoice || spentMode) && choiceKey
          ? withAgentRuntimeComposerChoice(current, choiceKey, {
              ...(spentChoice ? { selection: undefined } : {}),
              ...(spentMode ? { interactionMode: undefined } : {}),
            })
          : current;
      return spentDraft
        ? withAgentRuntimeComposerChoice(unspent, draftKey, {
            selection: undefined,
            interactionMode: undefined,
            runtimeMode: undefined,
          })
        : unspent;
    });
  }, [spentChoice, spentMode, spentDraft, choiceKey, draftKey, setChoices]);
  // Only a loaded catalog can say the remembered choice is gone, so until then it shows as chosen.
  const provisionalChoice =
    !target && !draft.selection && (catalogState.loading || catalogState.error !== null)
      ? newChatChoice
      : null;
  const rawSelection =
    (nextSelection ? choice : undefined) ??
    observedSelection ??
    provisionalChoice ??
    draftSelectionFor(catalogState.providers);
  const provider = providerOf(rawSelection);
  const chatModel = resolveAgentRuntimeChatModel(
    rawSelection.binding.driver,
    rawSelection.model,
    provider,
  );
  const selection =
    chatModel === rawSelection.model ? rawSelection : { ...rawSelection, model: chatModel };
  const showInteractionMode = provider?.showInteractionModeToggle !== false;
  const openSettingsFor = agentSetup.openSettings;
  const windowsSandboxNotice = useWindowsSandboxSetup(
    !isHostedChat() &&
      selection.binding.driver === "codex" &&
      provider?.enabled &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      (observed?.runtimeMode ?? draftRuntimeMode) !== "full-access"
      ? provider.instanceId
      : null,
  );
  const agentSwitchMessage = projection ? agentRuntimeAgentSwitchRefusalMessage(projection) : null;
  const refusalFor = (candidate: Pick<AgentWire<ModelSelection>, "instanceId" | "model">) =>
    observed
      ? agentRuntimeSelectionRefusal({
          current: observed.modelSelection,
          next: candidate,
          agentSwitchRefusal: agentSwitchMessage?.defaultMessage ?? null,
          providers: catalogState.providers,
        })
      : null;
  const displayRefusalFor = (
    candidate: Pick<AgentWire<ModelSelection>, "instanceId" | "model">,
    formatter: IntlShape,
  ) => {
    if (!refusalFor(candidate)) return null;
    const message =
      observed?.modelSelection.instanceId === candidate.instanceId
        ? AGENT_RUNTIME_AGENT_SWITCH_MESSAGES.modelLocked
        : agentSwitchMessage;
    return message ? formatter.formatMessage(message) : null;
  };
  const allEntries = entriesFor(catalogState.providers).map((entry) => {
    const candidate = modelOf(entry.selection);
    const nodexUnavailable =
      entry.binding.instanceId &&
      isNodexProviderId(entry.binding.instanceId) &&
      !nodexAccount.snapshot?.modelStatus?.models.some(
        (model) => model.id === entry.model.id && model.available,
      );
    const unavailableReason =
      entry.unavailableReason ??
      (nodexUnavailable
        ? intl.formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.temporarilyUnavailable",
            defaultMessage: "Temporarily unavailable",
          })
        : candidate
          ? displayRefusalFor(candidate, intl)
          : null);
    return unavailableReason ? { ...entry, unavailableReason } : entry;
  });
  const policyForEntry = (entry: AgentModelPickerEntry) =>
    catalogState.providers.find((provider) => provider.instanceId === entry.binding.instanceId);
  const entryIsOn = (entry: AgentModelPickerEntry) => {
    const provider = policyForEntry(entry);
    return provider !== undefined && isModelOn(modelPolicyState.settings, provider, entry.model.id);
  };
  const isCurrentEntry = (entry: AgentModelPickerEntry) =>
    agentModelKey(entry.binding, entry.model.id) ===
    agentModelKey(selection.binding, selection.model);
  const offEntries = allEntries.filter((entry) => {
    const provider = policyForEntry(entry);
    return (
      provider !== undefined &&
      isProviderOn(modelPolicyState.settings, provider) &&
      !entryIsOn(entry) &&
      !isCurrentEntry(entry)
    );
  });
  const policyProvider = provider ?? selection.binding ?? undefined;
  const currentModelLabel =
    provider?.models.find((model) => model.slug === selection.model)?.name ??
    NODEX_MODELS.find((model) => model.id === selection.model)?.label ??
    selection.model;
  const currentModelSpendsCredit = policyProvider ? spendsNodexCredit(policyProvider) : false;
  const currentModelFailure = policyProvider
    ? modelPolicyFailure(
        modelPolicyState.settings,
        policyProvider,
        selection.model,
        "person",
        currentModelLabel,
      )
    : null;
  const currentModelOff = currentModelFailure?.code === "model_off" ? currentModelFailure : null;
  // A chat keeps showing its own choice, marked off, so nothing changes under it silently.
  const currentOffEntry = currentModelOff ? allEntries.find(isCurrentEntry) : undefined;
  const entries = [
    ...(currentOffEntry && currentModelOff
      ? [
          {
            ...currentOffEntry,
            unavailableLabel: intl.formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.off",
              defaultMessage: "Off",
            }),
            unavailableReason: currentModelOff.message,
          },
        ]
      : []),
    ...allEntries.filter(entryIsOn),
  ];
  const openModelSettings = (providerKey?: string) => {
    const provider =
      providerKey === undefined
        ? undefined
        : catalogState.providers.find((entry) => policyProviderKey(entry) === providerKey);
    const anchor =
      providerKey === NODEX_MODELS_ANCHOR
        ? NODEX_MODELS_ANCHOR
        : provider && agentModelsSettingsAnchor(provider);
    workbenchOwner.openRoute({
      kind: "settings",
      path: anchor ? buildSettingsAnchorPath("agent", anchor) : buildSettingsPath("agent"),
    });
  };
  // Editing rewinds the Run the chat's own Agent ran; the edited message may then change Agent.
  const canRollback =
    (observedSelection ? providerOf(observedSelection) : provider)?.supportsConversationRollback ===
    true;
  // A hosted chat's history belongs to its Space host, which forks it for any Member who reads it
  // and rewinds it only to a message its reader sent, until Core has said which those are.
  const skillInstance = selection.binding.instanceId;
  const skillCwd = observed?.executionLocation?.cwd ?? input.workspaceRoot ?? null;
  const localSkills = !hosted && selection.binding.driver !== "codex" && skillInstance !== null;
  const composerSkills = useQuery({
    queryKey: spaceQueryKey([
      "agent-runtime",
      "composer-skills",
      localSkills ? skillInstance : null,
      skillCwd,
    ]),
    queryFn: localSkills
      ? () => agentRuntimeRuntime.composerSkills({ instanceId: skillInstance, cwd: skillCwd })
      : skipToken,
    // A capability can appear or disappear while this composer stays open.
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
  });
  const skillInventory =
    (localSkills && !composerSkills.isError ? composerSkills.data : undefined) ??
    provider?.skills ??
    [];
  const desktopSkills = skillInventory.filter((skill) => skill.desktopTool);
  useEffect(() => {
    owner?.setCapabilities({
      supportsUserTurnEdits: canRollback && (!hosted || memberEdits !== undefined),
      supportsForks: true,
      ...(hosted ? { memberEdits } : {}),
    });
  }, [owner, canRollback, hosted, memberEdits]);
  const intentKey =
    targetThreadId ?? JSON.stringify(["draft", draftKey, selection.binding.instanceId]);
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
    const unavailable = entries.find(
      (entry) =>
        entry.binding.instanceId === requested.binding.instanceId &&
        entry.model.id === requested.model,
    )?.unavailableReason;
    if (unavailable) throw new Error(unavailable);
    const chosenProvider = providerOf(requested);
    const chosenModel = chosenProvider?.models.find((model) => model.slug === requested.model);
    const sameProvider = selection.binding.instanceId === requested.binding.instanceId;
    // Another Agent's model starts from the options last chosen for it, otherwise its defaults.
    const chosen =
      sameProvider || requested.options !== undefined
        ? requested
        : { ...requested, options: rememberedAgentModelOptions(modelOptionMemory, requested) };
    const nextIntent =
      explicitIntent ??
      (selection.binding.driver === "claudeAgent" &&
      chosen.binding.driver === "claudeAgent" &&
      selection.binding.instanceId === chosen.binding.instanceId &&
      chosen.model !== selection.model
        ? { ...claudeIntent, model: chosen.model }
        : readRuntimeClaudeSelection(chosen));
    const descriptors = chosenModel?.capabilities?.optionDescriptors ?? [];
    const options = chosen.options ?? (sameProvider ? selection.options : undefined);
    const chosenTier = options?.find((option) => option.id === "serviceTier")?.value;
    const tierIntent =
      chosen.binding.driver !== "codex"
        ? undefined
        : typeof chosenTier === "string"
          ? chosenTier
          : sameProvider && chosen.model !== selection.model
            ? selectedServiceTier
            : undefined;
    const fitted =
      chosen.binding.driver === "claudeAgent"
        ? applyRuntimeClaudeIntent(chosen, nextIntent, chosenModel)
        : {
            ...chosen,
            options: applyAgentRuntimeOptionIntent(descriptors, options, {
              serviceTier: tierIntent,
            }),
          };
    const modelSelection = modelOf(fitted);
    if (!modelSelection || !chosenModel)
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.chooseAvailableModel",
          defaultMessage: "Choose an available model",
        }),
      );
    const refusal = displayRefusalFor(modelSelection, getIntl());
    if (refusal) throw new Error(refusal);
    const readiness = agentSetup.read(chosen.binding, chosenProvider);
    const source = chosenProvider?.installationSource;
    if (
      readiness?.problem.kind === "not-installed" &&
      readiness.problem.onDemand &&
      source?.kind === "component"
    )
      await agentSetup.run(chosen.binding, { kind: "install", sourceId: source.id });
    if (chosen.binding.driver === "claudeAgent")
      nativeIntelligenceIntentOwner.write(intentKey, nextIntent);
    // An unstarted chat's choice is where later new chats start; a started chat's stays its own.
    if (
      !target &&
      sameProvider &&
      fitted.binding.instanceId === CODEX_AGENT_BACKEND_BINDING.instanceId
    ) {
      const tier = readAgentRuntimeServiceTier(fitted.options);
      const carriedTier = normalizeCodexServiceTier(
        fitAgentRuntimeServiceTier(descriptors, selectedServiceTier),
      );
      if (tier !== undefined && tier !== carriedTier) saveServiceTier(tier, "composer_menu");
    }
    await Promise.all([
      setModelOptionMemory((current) => rememberAgentModelOptions(current, fitted)),
      writeChoice(choiceKey ?? draftKey, {
        selection:
          observed && agentRuntimeModelSelectionsEqual(observed.modelSelection, modelSelection)
            ? undefined
            : fitted,
      }),
      ...(target ? [] : [setNewChatChoice(fitted)]),
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
      const checkSelectedModel =
        agentDefinition(candidate.binding.driver).setup?.models === "choose" &&
        provider?.checkPending;
      if (!provider || checkSelectedModel) {
        const instanceId = candidate.binding.instanceId;
        const providers = instanceId
          ? await agentRuntimeRuntime.catalog({
              instanceIds: [instanceId],
              ...(checkSelectedModel ? { refresh: true } : {}),
            })
          : [];
        provider = providers.find((entry) => entry.instanceId === instanceId);
      }
      const modelId = resolveAgentRuntimeChatModel(
        candidate.binding.driver,
        candidate.model,
        provider,
      );
      const readiness = agentSetup.read(candidate.binding, provider, modelId);
      if (readiness?.blocksSend) {
        const label = provider
          ? agentRuntimeProviderLabel(provider, input.instances)
          : agentDefinition(candidate.binding.driver).label;
        throw new Error(
          agentReadinessView(componentReadinessLabel(provider, label, getIntl()), readiness).title,
        );
      }
      const model = provider?.models.find((entry) => entry.slug === modelId);
      // A hosted chat's sandbox belongs to its Space host, not this computer.
      if (
        !hosted &&
        candidate.binding.driver === "codex" &&
        resolveCodexRendererOs() === "win32" &&
        (observed?.runtimeMode ?? draftRuntimeMode) !== "full-access" &&
        provider
      ) {
        const sandbox = await agentRuntimeRuntime.readWindowsSandbox({
          instanceId: provider.instanceId,
        });
        if (sandbox.status !== "ready")
          throw new Error(
            getIntl().formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.setUpWindows",
              defaultMessage: "Set up Codex for Windows before sending.",
            }),
          );
      }
      // The Space host reads this computer's files as uploads, never at their paths here.
      const { promptInput: portable, uploads } = hosted
        ? separateHostedChatUploads(promptInput)
        : {
            promptInput,
            uploads:
              candidate.binding.driver === "antigravity"
                ? [
                    ...(promptInput?.fileAttachments ?? []),
                    ...(promptInput?.addedFiles ?? []),
                  ].flatMap((file) => {
                    const path = file.fsPath || file.path;
                    return (!file.hostId || file.hostId === "local") &&
                      !file.startLine &&
                      isLocalPath(path)
                      ? [{ name: file.label, path }]
                      : [];
                  })
                : [],
          };
      const prepared = await prepareAgentRuntimeMessage(
        {
          model,
          provider,
          modelSelection: modelOf({ ...candidate, model: modelId }) ?? undefined,
          kind: candidate.binding.driver,
          desktopSkills:
            !hosted && candidate.binding.instanceId === skillInstance ? desktopSkills : undefined,
          cwd: skillCwd ?? undefined,
          text,
          promptInput: portable,
          untrustedAppMessage,
        },
        (file) => readPastedTextAttachment({ file }),
      );
      return uploads.length ? { ...prepared, uploads } : prepared;
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
    openAgentSettings && failedProvider && agentDefinition(failedProvider.driver).profileBased
      ? (instanceId: string) => {
          const binding = bindingFor(instanceId);
          if (!binding || !agentDefinition(binding.driver).profileBased)
            throw new Error("This Agent's settings are unavailable");
          openSettingsFor(binding);
        }
      : undefined;
  const actions: Partial<ThreadStageActions> = {
    onCaptureSubmissionPresentation: () => readCodexSubmissionPresentation(workbenchOwner),
    ...createAgentRuntimeStageActions({
      composerChatKey: input.threadId
        ? { kind: "session-thread", sessionId: input.sessionId, threadId: input.threadId }
        : undefined,
      target: () => target,
      owner: () => owner,
      prepare,
      readPresentation: () => readCodexSubmissionPresentation(workbenchOwner),
      capturePresentation: (target, submitted) =>
        captureCodexTurnPresentation(workbenchOwner, target, submitted),
      openFork: async (
        result: import("../../../shared/agent-runtime-api").AgentRuntimeLaunchResult,
      ) => {
        await input.onRefresh(result.projectId);
        requestComposerFocus({ kind: "session", sessionId: result.sessionId });
        await input.onOpenThread(result.threadId, { runtimeSessionId: result.sessionId });
      },
      hosted,
      manage: capabilities.canManage,
      nextSelection: () =>
        selection.model && selection.model !== rawSelection.model
          ? modelOf(selection)
          : nextSelection,
      nextInteractionMode: () => (showInteractionMode ? (nextMode ?? null) : null),
      manageProvider,
      onSideChatTitle: input.onSideChatTitle,
    }),
    onOpenThread: (threadId, context) =>
      input.onOpenThread(threadId, {
        ...context,
        runtimeSessionId: context?.runtimeSessionId ?? input.sessionId,
      }),
    onStartThreadForSession: async (request) => {
      const submittedPresentation =
        request.submittedPresentation ?? readCodexSubmissionPresentation(workbenchOwner);
      if (request.runInTarget === "cloud")
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.chooseLocalWorkspace",
            defaultMessage: "Choose a local workspace",
          }),
        );
      // The message shows at once. A draft still waiting for the catalog takes its default Agent's
      // model once that Agent is checked, without waiting for every other Agent's check.
      const pendingSelection =
        modelOf(selection) && !provisionalChoice ? null : resolveDefaultSelection();
      // Its failure is reported where the launch awaits it.
      pendingSelection?.catch(() => {});
      const submission = sessionFirstSubmissionOwner.begin({
        backend: selection.binding.driver,
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
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.projectDraftUnavailable",
            defaultMessage: "Project draft materialization is unavailable",
          }),
        );
      if (sessionId !== request.sessionId && !request.projectDraftId) {
        composerDraftIntents.moveFocusTransfer(
          { kind: "session", sessionId: request.sessionId },
          { kind: "session", sessionId },
        );
      }
      sessionFirstSubmissionOwner.update(submission.launchId, {
        targetSessionId: sessionId,
        targetProjectId: request.projectId,
        phase: "startingThread",
      });
      const launched = await runWithCleanup(
        async () => {
          const launchSelection = pendingSelection ? await pendingSelection : selection;
          const modelSelection = modelOf(launchSelection);
          if (!modelSelection)
            throw new Error(
              getIntl().formatMessage({
                id: "conversation.agentRuntimeConversationAdapter.chooseConfiguredAgent",
                defaultMessage: "Choose a configured Agent and model",
              }),
            );
          const launchProviders = catalogState.loading
            ? await agentRuntimeRuntime.catalog({ instanceIds: [modelSelection.instanceId] })
            : catalogState.providers;
          const resolved = requireAgentRuntimeModelSelection(launchProviders, modelSelection);
          if (launchSelection.binding.driver !== selection.binding.driver)
            sessionFirstSubmissionOwner.update(submission.launchId, {
              backend: launchSelection.binding.driver,
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
            title: request.prompt.slice(0, 120) || NEW_CHAT_TITLE,
            modelSelection,
            interactionMode:
              resolved.provider.showInteractionModeToggle === false ? "default" : draftMode,
            runtimeMode: draft.runtimeMode,
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
          return result;
        },
        {
          onError: (cause) => {
            sessionFirstSubmissionOwner.fail(submission.launchId, {
              stage: "startingThread",
              message: cause instanceof Error ? cause.message : String(cause),
            });
            throw cause;
          },
        },
      );
      // The chat exists from here. Failing to show it must not restore the draft and invite a
      // second send of the same message.
      try {
        await input.onRefresh(request.projectId);
        if (input.onLaunched) await input.onLaunched(launched);
        else await input.onOpenThread(launched.threadId, { runtimeSessionId: launched.sessionId });
        composerDraftIntents.completeFirstSend({ kind: "session", sessionId: launched.sessionId });
      } catch (cause) {
        toast.danger(
          getIntl().formatMessage(
            {
              id: "conversation.agentRuntimeConversationAdapter.startedButCannotOpen",
              defaultMessage: "The chat started, but it could not be opened: {reason}",
            },
            { reason: cause instanceof Error ? cause.message : String(cause) },
          ),
          { id: `agent-runtime-launch-open:${launched.sessionId}` },
        );
      }
    },
    onModelChange: (model) => chooseModel({ ...selection, model }),
    onReasoningEffortChange: (effort) =>
      selection.binding.driver === "claudeAgent" && isClaudeEffortLevel(effort)
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
      if (selection.binding.driver === "claudeAgent") {
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
            ...(selection.binding.driver === "codex" ? { serviceTier: candidate.serviceTier } : {}),
          },
        ),
      });
    },
    // A hosted fork or side chat merges back for whoever may manage it, as Core admits.
    ...(target && observed && agentRuntimeForkSource(observed) && capabilities.canManage
      ? {
          onMergeForkBack: async () => {
            const merged = await agentRuntimeRuntime.mergeBack({
              ...target,
              requestId: createUuidV7(),
            });
            await input.onRefresh(merged.projectId);
            await input.onOpenThread(merged.threadId, { runtimeSessionId: merged.sessionId });
            toast.success(
              getIntl().formatMessage({
                id: "conversation.agentRuntimeConversationAdapter.forkMerged",
                defaultMessage: "The fork's work joins your next message in this chat.",
              }),
            );
          },
        }
      : {}),
    // A hosted chat's permissions are the Space host's execution authority, not this Device's.
    ...(hosted
      ? {}
      : {
          onRuntimeModeChange: async (
            runtimeMode: import("@nodex/agent-runtime/contracts").RuntimeMode,
          ) => {
            if (!target) {
              await writeChoice(draftKey, { runtimeMode });
              return;
            }
            await agentRuntimeRuntime.setModes({
              ...target,
              requestId: createUuidV7(),
              runtimeMode,
            });
          },
        }),
    onCollaborationModeChange: async (interactionMode) => {
      if (!target) {
        await writeChoice(draftKey, { interactionMode });
        return;
      }
      // The Space host takes a hosted chat's mode with its next message; nothing changes until then.
      if (hosted) {
        if (choiceKey) await writeChoice(choiceKey, { interactionMode });
        return;
      }
      await agentRuntimeRuntime.setModes({ ...target, requestId: createUuidV7(), interactionMode });
    },
    onUnarchiveThread: async () => {
      if (target) await workspaceSessionCommands.unarchive(target.sessionId);
      await input.onRefresh(input.projectId);
    },
  };
  const kind = selection.binding.driver;
  const runtime = createAgentRuntimeConversationRuntime(
    kind,
    targetSessionId
      ? { sessionId: targetSessionId, ...(targetThreadId ? { threadId: targetThreadId } : {}) }
      : null,
    owner,
    hosted
      ? {
          canManage: capabilities.canManage,
          runIds: (memberActions?.runs ?? []).flatMap((run) => (run.can_stop ? [run.run_id] : [])),
        }
      : undefined,
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
  const modelOptions = currentModel?.capabilities?.optionDescriptors ?? [];
  const effortDescriptor = modelOptions.find(isAgentRuntimeEffortOption);
  const selectedEffort = readAgentRuntimeEffort(selection.options, effortDescriptor);
  const resolvedEffort =
    typeof selectedEffort === "string"
      ? selectedEffort
      : (models.find((model) => model.id === selectedModel)?.defaultReasoningEffort ?? "default");
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
  // Effort reaches the picker as the model's levels, so the options here are the rest.
  const configOptions: import("../../../shared/agent-conversation").AgentSessionConfigOption[] =
    modelOptions
      .filter((option) => option !== effortDescriptor)
      .map((option) => {
        const chosen = selection.options?.find((value) => value.id === option.id)?.value;
        const common = {
          id: option.id,
          name: option.label,
          description: option.description ?? null,
          category: null,
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
            typeof chosen === "string" && option.options.some((value) => value.id === chosen)
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
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.chooseModelOption",
          defaultMessage: "Choose an available model option",
        }),
      );
    await chooseModel({
      ...selection,
      options: [
        ...(selection.options ?? []).filter((candidate) => candidate.id !== id),
        { id, value },
      ],
    });
  };
  // Background work belongs to the Session's root, which also lists what its delegated
  // conversations left running; an opened child shows only its own Runs.
  const backgroundTasks = useAgentRuntimeBackgroundTasks(
    input.executionRef &&
      (input.threadId === undefined || input.threadId === input.executionRef.threadId)
      ? input.sessionId
      : null,
  );
  const preparationFailure = target
    ? failedWorkspacePreparation(state.conversation?.snapshot.projection.runs ?? [])
    : null;
  // A Run that could not start may have found its working directory gone; the composer then
  // says so and offers the fix, and fixing it sends that same message.
  const unstartedFailure = target
    ? unstartedRunFailure(state.conversation?.snapshot.projection.runs ?? [])
    : null;
  useEffect(() => {
    if (!unstartedFailure || !targetThreadId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.threadExecution.workspace(targetThreadId),
      exact: true,
    });
  }, [queryClient, targetThreadId, unstartedFailure]);
  // The composer owns inspection. Observe its result through the same query without fetching
  // it again; a different query function here would replace the composer's own recheck.
  const workspace = useQuery({
    ...threadWorkspaceAvailabilityQuery(targetThreadId ?? ""),
    enabled: false,
  });
  const attemptedWorkspaceRetries = useRef(new Set<string>());
  const availability = workspace.data?.state;
  const { dataUpdatedAt, fetchStatus, isSuccess } = workspace;
  useEffect(() => {
    if (!targetThreadId || !unstartedFailure || !isSuccess || fetchStatus !== "idle") return;
    // Invalidation and refetch can advance the cache before this effect sees the new result, so
    // act only on the result the cache still holds, never on one a recheck is replacing.
    const cached = queryClient.getQueryState(queryKeys.threadExecution.workspace(targetThreadId));
    if (
      !cached ||
      cached.isInvalidated ||
      cached.dataUpdatedAt !== dataUpdatedAt ||
      cached.fetchStatus !== "idle"
    )
      return;
    if (
      !shouldRetryWorkspaceMissingRun(
        unstartedFailure,
        availability,
        attemptedWorkspaceRetries.current,
      )
    )
      return;
    attemptedWorkspaceRetries.current.add(unstartedFailure);
    void agentRuntimeRuntime
      .retryWorkspaceMissingRun({ threadId: targetThreadId })
      .catch((error) =>
        console.warn("Failed to retry a Run waiting for its working directory", error),
      );
  }, [
    availability,
    dataUpdatedAt,
    fetchStatus,
    isSuccess,
    queryClient,
    targetThreadId,
    unstartedFailure,
  ]);
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
  // Only the Agent this chat runs on, or one the person chose, raises a readiness notice. A new chat
  // with nothing it could run asks for an Agent instead. Credits are never chosen automatically, so
  // an account that could spend them leaves a model to choose rather than an Agent to connect.
  const nodexBalance = nodexCreditBalance(nodexAccount.snapshot);
  const creditsCanRun =
    (nodexBalance === null || Math.trunc(nodexBalance) > 0) &&
    allEntries.some((entry) => {
      const entryProvider = policyForEntry(entry);
      return (
        entryProvider !== undefined &&
        spendsNodexCredit(entryProvider) &&
        !agentSetup.read(entry.binding, entryProvider) &&
        entryIsOn(entry) &&
        !entry.unavailableReason
      );
    });
  const noUsableAgent =
    !observed && !selection.model && !catalogState.loading && !catalogState.error && !creditsCanRun;
  const selectedReadiness =
    !provider && catalogState.loading
      ? null
      : agentSetup.read(selection.binding, provider, selection.model);
  const selectedNotice = selectedReadiness
    ? agentReadinessNotice(
        selection.binding.instanceId ?? selection.binding.driver,
        componentReadinessLabel(
          provider,
          provider
            ? agentRuntimeProviderLabel(provider, input.instances)
            : agentDefinition(selection.binding.driver).label,
          intl,
        ),
        selectedReadiness,
        !hosted || selectedReadiness.action?.kind === "check-again"
          ? () => agentSetup.run(selection.binding, selectedReadiness.action)
          : undefined,
        intl,
      )
    : null;
  const agentNotice =
    noUsableAgent && !selectedReadiness?.blocksSend
      ? hosted
        ? hostedAgentUnavailableNotice(intl)
        : connectAgentNotice(() => void connectAgent(), intl)
      : (observed || selection.model || selectedReadiness?.blocksSend) && !currentModelOff
        ? selectedNotice
        : null;
  // One standing condition at a time, the most specific first: this chat's own Run, then its
  // connection, then the Agents it can use.
  const composerNotice: ComposerNotice | null = preparationFailure
    ? {
        key: `worktree-preparation:${preparationFailure}`,
        tone: "danger",
        title: intl.formatMessage({
          id: "conversation.agentRuntimeConversationAdapter.worktreePreparationFailed",
          defaultMessage: "Couldn’t prepare the worktree",
        }),
        ...(hosted
          ? { detail: intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.hostedChat), actions: [] }
          : {
              actions: [
                {
                  label: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.retry",
                    defaultMessage: "Retry",
                  }),
                  pendingLabel: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.retrying",
                    defaultMessage: "Retrying…",
                  }),
                  run: () => retryPreparation(preparationFailure, false),
                },
                {
                  label: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.workLocally",
                    defaultMessage: "Work locally",
                  }),
                  pendingLabel: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.starting",
                    defaultMessage: "Starting…",
                  }),
                  run: () => retryPreparation(preparationFailure, true),
                },
              ],
            }),
      }
    : state.error
      ? {
          key: "conversation-connection",
          tone: "danger",
          title: intl.formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.connectionFailed",
            defaultMessage: "Couldn’t connect to this chat",
          }),
          detail: state.error,
          actions: owner
            ? [
                {
                  label: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.retry",
                    defaultMessage: "Retry",
                  }),
                  pendingLabel: intl.formatMessage({
                    id: "conversation.agentRuntimeConversationAdapter.retrying",
                    defaultMessage: "Retrying…",
                  }),
                  run: () => owner.resume(),
                },
              ]
            : [],
        }
      : catalogState.error
        ? {
            key: "agent-catalog",
            tone: "danger",
            title: intl.formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.agentCatalogFailed",
              defaultMessage: "Couldn’t load Agents",
            }),
            detail: catalogState.error,
            actions: [
              {
                label: intl.formatMessage({
                  id: "conversation.agentRuntimeConversationAdapter.retry",
                  defaultMessage: "Retry",
                }),
                pendingLabel: intl.formatMessage({
                  id: "conversation.agentRuntimeConversationAdapter.retrying",
                  defaultMessage: "Retrying…",
                }),
                run: checkCatalogAgain,
              },
            ],
          }
        : (agentNotice ?? windowsSandboxNotice ?? null);
  const teammate = agentTeammate(catalogState.providers, provider?.instanceId);
  const tipFacts = useMemo(() => chatTipFacts(projection), [projection]);
  const tip = useComposerTip({
    // A person's own chats speak, and only when nothing holds the composer.
    enabled:
      input.threadId === undefined &&
      input.onSideChatTitle === undefined &&
      composerNotice === null &&
      !selectedReadiness?.blocksSend &&
      !currentModelOff,
    sessionId: input.sessionId,
    chat: { kind: "session", sessionId: input.sessionId },
    moment: {
      ...tipFacts,
      started: observed !== undefined,
      teammate: teammate ? agentRuntimeProviderLabel(teammate, input.instances) : null,
      canConnectAgent: !hosted,
    },
    connectAgent: () => void connectAgent(),
  });
  const presentation: ConversationProviderPresentation = {
    ...(target && admissionRunId
      ? {
          admissionQueue: {
            runId: admissionRunId,
            read: async () =>
              (await agentRuntimeRuntime.control(target)).waitingAdmissions?.find(
                (entry) => entry.runId === admissionRunId,
              ) ?? null,
          },
        }
      : {}),
    runtimeMode: resolveAgentRuntimeMode(
      observed?.runtimeMode ?? draftRuntimeMode,
      provider?.supportedRuntimeModes,
    ),
    supportedRuntimeModes: provider?.supportedRuntimeModes,
    defaultRuntimeMode,
    resolveRuntimeAttachment: async (reference) => {
      if (!target)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.openToReadAttachment",
            defaultMessage: "Open the conversation before reading its attachment",
          }),
        );
      const result = await agentRuntimeRuntime.attachment({ ...target, ...reference });
      if (!result)
        throw new Error(
          getIntl().formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.attachmentUnavailable",
            defaultMessage: "Attachment unavailable",
          }),
        );
      return "dataUrl" in result ? result.dataUrl : result.path;
    },
    nativeIntelligence:
      selection.binding.driver === "claudeAgent"
        ? {
            selected: {
              fast: readRuntimeClaudeSelection(selection).fast ?? false,
              ultracode: readRuntimeClaudeSelection(selection).ultracode ?? false,
              thinking: readRuntimeClaudeSelection(selection).thinking,
              context: readRuntimeClaudeSelection(selection).context,
              contextInherited: readRuntimeClaudeSelection(selection).context === undefined,
            },
            capabilities: currentModel ? runtimeClaudeModelOption(currentModel) : {},
            change: async (patch) => {
              const next = { ...claudeIntent };
              for (const key of ["fast", "ultracode", "thinking", "context"] as const)
                if (patch[key] === null) delete next[key];
              await chooseModel(selection, {
                ...next,
                ...(patch.effort ? { effort: patch.effort } : {}),
                ...(typeof patch.fast === "boolean" ? { fast: patch.fast } : {}),
                ...(typeof patch.ultracode === "boolean" ? { ultracode: patch.ultracode } : {}),
                ...(typeof patch.thinking === "boolean" ? { thinking: patch.thinking } : {}),
                ...(typeof patch.context === "string" ? { context: patch.context } : {}),
              });
            },
          }
        : undefined,
    kind: selection.binding.driver,
    ...(selection.binding.driver === "codex" ? { serviceTier: selectedServiceTier } : {}),
    label:
      (provider ? agentRuntimeProviderLabel(provider, input.instances) : undefined) ??
      (agentDefinition(selection.binding.driver).driver
        ? agentDefinition(selection.binding.driver).label
        : intl.formatMessage({
            id: "conversation.agentRuntimeConversationAdapter.agent",
            defaultMessage: "Agent",
          })),
    emptyHistory: pendingImport
      ? acpImportedHistoryEmptyState(
          provider?.displayName ??
            intl.formatMessage({
              id: "conversation.agentRuntimeConversationAdapter.theAgent",
              defaultMessage: "the Agent",
            }),
          pendingImport,
        )
      : null,
    selection: selection.binding.instanceId ?? "",
    modelCatalog: {
      entries,
      currentModelOff: currentModelOff
        ? {
            ...currentModelOff,
            title: currentModelSpendsCredit
              ? intl.formatMessage(
                  {
                    id: "conversation.agentRuntimeConversationAdapter.nodexModelOff",
                    defaultMessage: "{model} on Nodex is off",
                  },
                  { model: currentModelLabel },
                )
              : intl.formatMessage(
                  {
                    id: "conversation.agentRuntimeConversationAdapter.modelOff",
                    defaultMessage: "{model} is off",
                  },
                  { model: currentModelLabel },
                ),
            ...(policyProvider &&
            !currentModelSpendsCredit &&
            isProviderOn(modelPolicyState.settings, policyProvider)
              ? {
                  turnOn: async () => {
                    await modelPolicyState.updateSettings(
                      setModelOn(modelPolicyState.settings, policyProvider, selection.model, true),
                    );
                  },
                }
              : {}),
          }
        : null,
      manageModels: openModelSettings,
      off: {
        entries: offEntries,
        count: catalogState.providers.reduce(
          (count, provider) =>
            count +
            provider.models.filter(
              (model) => !isModelOn(modelPolicyState.settings, provider, model.slug),
            ).length,
          0,
        ),
        choose: async (requested) => {
          const provider = catalogState.providers.find(
            (provider) => provider.instanceId === requested.binding.instanceId,
          );
          if (
            !provider ||
            spendsNodexCredit(provider) ||
            !isProviderOn(modelPolicyState.settings, provider)
          )
            throw new Error(
              getIntl().formatMessage({
                id: "conversation.agentRuntimeConversationAdapter.manageInAgentSettings",
                defaultMessage: "Manage this model in Settings → Agents.",
              }),
            );
          await modelPolicyState.updateSettings(
            setModelOn(modelPolicyState.settings, provider, requested.model, true),
          );
          await chooseModel(requested);
        },
      },
      selected: selection,
      loading: catalogState.loading,
      error: catalogState.error,
      choose: chooseModel,
      refresh: () => {
        refreshCatalog();
        agentSetup.refreshInstallation();
      },
      reload: () => {
        nodexAccount.act("refreshModels");
        reloadCatalog();
      },
      configOptions,
      changeConfig,
      runtimeOptions: [],
      chooseRuntime: () => {},
      manage: () => openSettingsFor(selection.binding),
      setups: agentSetup.setupRows(catalogState.providers),
    },
    commands:
      provider?.slashCommands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        inputHint: command.input?.hint ?? null,
        aliases: command.aliases ?? [],
      })) ?? [],
    controls: {
      steer: true,

      images: imageInput(currentModel, intl).supported,
      context: true,
      skills: true,
      subagents: true,
      goals: false,
    },
    ...(capabilities.canStop
      ? {}
      : {
          interruptUnavailableReason: intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.reservedStop),
        }),
    imageInputUnavailableReason: imageInput(currentModel, intl).unavailableReason,
    imageInputForSelection: (modelSelection) =>
      imageInput(
        catalogState.providers
          .find((entry) => entry.instanceId === modelSelection.instanceId)
          ?.models.find((entry) => entry.slug === modelSelection.model),
        intl,
      ),
    skillsLoading: composerSkills.isLoading,
    skills: skillInventory
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        name: skill.name,
        displayName: skill.displayName ?? formatComposerSkillDisplayName(skill.name),
        description: skill.shortDescription ?? skill.description ?? "",
        iconUrl: resolveComposerInventoryIconUrl(skill.desktopTool?.iconPath),
        brandColor: skill.desktopTool?.brandColor ?? null,
        path: skill.path,
        scope: skill.desktopTool ? "system" : skill.scope === "project" ? "repo" : "user",
        ...(skill.userInvocable === false ? { userInvocable: false } : {}),
      })),
    refreshSkills: async () => {
      if (localSkills) await composerSkills.refetch();
      else refreshCatalog();
    },
    notice: composerNotice,
    sendGate:
      provider?.installationSource?.kind === "component" &&
      selectedReadiness?.blocksSend &&
      selectedNotice
        ? { unsentReason: selectedNotice.title, notice: selectedNotice }
        : null,
    tip,
    backgroundTasks,
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
    reasoningEffortOptions:
      models.find((model) => model.id === selectedModel)?.supportedReasoningEfforts ?? [],
    runtimeMode: presentation.runtimeMode,
    supportedRuntimeModes: provider?.supportedRuntimeModes,
    defaultRuntimeMode,
    selectedMode: showInteractionMode
      ? (nextMode ?? observed?.interactionMode ?? draftMode)
      : "default",
    modes: (showInteractionMode
      ? [
          { name: "Code", mode: "default", model: null },
          { name: "Plan", mode: "plan", model: null },
        ]
      : []) as CodexCollaborationModePreset[],
  };
}
