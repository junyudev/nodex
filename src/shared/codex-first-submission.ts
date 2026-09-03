import type { ConversationFirstSubmissionIdentity } from "./types";
import { createUuidV7 } from "./uuid-v7";

/** Allocates the client-owned identities that stay stable while a first submission creates a Thread. */
export function createCodexFirstSubmissionIdentity(): ConversationFirstSubmissionIdentity {
  return {
    launchId: createUuidV7(),
    clientUserMessageId: createUuidV7(),
  };
}
