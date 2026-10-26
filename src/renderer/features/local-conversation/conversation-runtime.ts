import { createContext, useContext } from "react";
import type {
  CodexConnectionState,
  CodexConversationChildMembership,
  CodexConversationLiveRequest,
  CodexConversationSnapshot,
} from "../../../shared/types";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { LocalConversationAttachmentState } from "./conversation-attachment-state";
import type { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";
import type { AsyncQuestionDelivery, AsyncQuestionRuntime } from "./async-question-runtime";
import type { CodexHistoryBoundaryRef } from "../../../shared/codex-conversation-state/codex-history-topology";
import type { CodexConversationHistoryTurnItemsRef } from "../../../shared/codex-conversation-history-page";
import type { CodexPromptRailPreview } from "../../../shared/codex-prompt-rail-history";

/** Viewport demand addresses the publishing owner; native read envelopes stay in its Adapter. */
export interface ConversationHistoryPort {
  readonly loadBoundary: (boundary: CodexHistoryBoundaryRef) => Promise<"applied" | "stale">;
  /** Present only where individual Turns can also contain unloaded item pages. */
  readonly loadTurnItems?: (
    items: CodexConversationHistoryTurnItemsRef,
  ) => Promise<"applied" | "stale">;
  /** Present where the owner can list Turns that resident history has not loaded yet. */
  readonly promptRail?: ConversationPromptRailPort;
}

/** One Turn of a conversation's prompt index; identity matches its resident Turn id. */
export interface ConversationPromptTurn {
  readonly turnId: string;
  /** Present where the owner reads previews with its index. */
  readonly previews?: readonly CodexPromptRailPreview[];
}

/**
 * Prompt navigation over every Turn, bound to the history reader that published it. Reads never
 * install history; only `install` makes a Turn resident, through the same owner.
 */
export interface ConversationPromptRailPort {
  /** Turns in conversation order, or null when the owner cannot index this conversation now. */
  readonly loadIndex: (signal: AbortSignal) => Promise<readonly ConversationPromptTurn[] | null>;
  /** Present where previews need their own read. */
  readonly preview?: (
    turnId: string,
    signal: AbortSignal,
  ) => Promise<readonly CodexPromptRailPreview[] | null>;
  /** Makes one Turn resident so navigation can reveal its message. */
  readonly install: (turnId: string, signal: AbortSignal) => Promise<"applied" | "stale">;
}

/** Optional questions answered beside the ordinary Composer, through the execution owner. */
export interface ConversationAsyncQuestionPort {
  readonly runtime: AsyncQuestionRuntime;
  readonly deliver: AsyncQuestionDelivery;
}

/** One resident execution source; replacing its reader invalidates already admitted UI work. */
export interface ConversationContentSource {
  readonly identity: string;
  readonly isCurrent: () => boolean;
}

/** Configured Agent names and marks for the Agents a conversation's work ran on. */
export interface ConversationAgentLabelPort {
  /** Notifies when the configured Agents or their model names change. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The configured Agent label and model display name, as one label. */
  readonly label: (providerInstanceId: string, model: string | null) => string | null;
  /** The Agent Backend whose mark identifies the Agent, when it is configured. */
  readonly kind: (providerInstanceId: string) => AgentBackendBinding["kind"] | null;
}

/** Delegated task rows request Stop through their conversation's owner. */
export interface ConversationDelegatedTaskPort {
  /** Notifies when unsettled Stop requests change. */
  readonly subscribe: (listener: () => void) => () => void;
  /** A Stop request stays visible until the task settles or the request fails. */
  readonly isStopping: (taskId: string) => boolean;
  /** Releases a settled task's Stop request. */
  readonly settle: (taskId: string) => void;
  readonly stop: (
    parentThreadId: string,
    task: {
      readonly taskId: string;
      readonly ownerRunId: string | null;
      readonly childThreadId: string | null;
    },
  ) => Promise<void>;
}

/** Product conversation reads and lifecycle; protocol ownership stays in each Adapter. */
export interface ConversationRuntime {
  /** Captures the selected history reader's lifetime without changing execution retention. */
  readonly history?: (threadId: string) => ConversationHistoryPort | null;
  /** Present where work can run on several configured Agents. */
  readonly agentLabels?: ConversationAgentLabelPort;
  /** Present only where delegated tasks have an execution owner that can stop them. */
  readonly delegatedTasks?: ConversationDelegatedTaskPort;
  /** Present where the execution owner holds asynchronous questions; native chats use their manager. */
  readonly asyncQuestions?: ConversationAsyncQuestionPort;
  /** Provider presentation only; reads and lifecycle must use this runtime's owner ports. */
  readonly kind: "codex" | "claude" | "acp" | "opencode";
  readonly hostId: string;
  /** App-owned execution descendants share this Core Session. Native observation IDs do not. */
  readonly sessionId?: string;
  readonly subscribe: (threadId: string | null, listener: () => void) => () => void;
  /** Aggregate providers can publish membership and child observations with one subscription. */
  readonly subscribeChildObservations?: (
    threadId: string | null,
    listener: () => void,
  ) => () => void;
  /** Keep the same immutable snapshot reference until its provider publication changes. */
  readonly read: (threadId: string | null) => CodexConversationSnapshot | null;
  /** Read-only keyed content projection; execution authority stays in the Session Interface. */
  readonly transcriptReadOwner?: (threadId: string | null) => CodexTranscriptReadOwner | null;
  readonly contentSource?: (threadId: string | null) => ConversationContentSource | null;
  readonly attachment: (threadId: string | null) => LocalConversationAttachmentState;
  readonly connection: () => CodexConnectionState;
  readonly role: (threadId: string | null) => "owner" | "follower" | null;
  readonly primaryRequest: (threadId: string | null) => CodexConversationLiveRequest | null;
  readonly children: (threadId: string | null) => readonly CodexConversationChildMembership[];
  readonly retain: (threadId: string, foreground: boolean) => () => void;
  /**
   * Hydrates one item whose detail the live projection withholds, such as a finished command's
   * output; the transcript then shows it in place. Absent where items arrive complete.
   */
  readonly readItemDetail?: (threadId: string | null, itemId: string) => Promise<void>;
  /** Loads readable history through this owner without resuming execution or acquiring a writer. */
  readonly loadHistory: (threadId: string) => Promise<void>;
  readonly resume: (threadId: string) => Promise<void>;
  readonly markRead: (threadId: string) => Promise<void>;
  readonly setPresented: (threadId: string, surfaceId: string, presented: boolean) => Promise<void>;
}

export const ConversationRuntimeContext = createContext<ConversationRuntime | null>(null);
export const useConversationRuntimeOverride = () => useContext(ConversationRuntimeContext);
