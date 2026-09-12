import type { CodexConversationSnapshot } from "./types";

/** The request selector consumes presentation context, not a replicated conversation document. */
export type CodexConversationRequestContext = Pick<
  CodexConversationSnapshot,
  "projectId" | "threadId" | "turns" | "requests" | "canonicalRequests"
>;
