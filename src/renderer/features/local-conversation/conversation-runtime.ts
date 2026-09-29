import { createContext, useContext } from "react";
import type {
  CodexConnectionState,
  CodexConversationChildMembership,
  CodexConversationLiveRequest,
  CodexConversationSnapshot,
} from "../../../shared/types";
import type { LocalConversationAttachmentState } from "./conversation-attachment-state";

/** Product conversation reads and lifecycle; protocol ownership stays in each Adapter. */
export interface ConversationRuntime {
  readonly kind: "codex" | "claude" | "acp";
  readonly hostId: string;
  readonly subscribe: (threadId: string | null, listener: () => void) => () => void;
  readonly read: (threadId: string | null) => CodexConversationSnapshot | null;
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
