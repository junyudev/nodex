import { createContext, useContext } from "react";
import type {
  CodexConnectionState,
  CodexConversationChildMembership,
  CodexConversationLiveRequest,
  CodexConversationSnapshot,
} from "../../../shared/types";
import type { LocalConversationAttachmentState } from "./conversation-attachment-state";
import type { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";

/** One resident execution source; replacing its reader invalidates already admitted UI work. */
export interface ConversationContentSource {
  readonly identity: string;
  readonly isCurrent: () => boolean;
}

/** Product conversation reads and lifecycle; protocol ownership stays in each Adapter. */
export interface ConversationRuntime {
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
  readonly resume: (threadId: string) => Promise<void>;
  readonly markRead: (threadId: string) => Promise<void>;
  readonly setPresented: (threadId: string, surfaceId: string, presented: boolean) => Promise<void>;
}

export const ConversationRuntimeContext = createContext<ConversationRuntime | null>(null);
export const useConversationRuntimeOverride = () => useContext(ConversationRuntimeContext);
