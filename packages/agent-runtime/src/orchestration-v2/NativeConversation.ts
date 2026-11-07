import type { OrchestrationV2ProviderThread } from "@nodex/runtime-contracts";
import type * as DateTime from "effect/DateTime";

/** Keep portable history while retiring native-only state before a fresh conversation. */
export const detachNativeConversation = (
  thread: OrchestrationV2ProviderThread,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderThread => ({
  ...thread,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  nativeMetadata: null,
  contextUsage: null,
  goal: null,
  pendingBackgroundTasks: [],
  status: thread.status === "closed" ? "closed" : "not_loaded",
  contextHandoffRequired: true,
  updatedAt,
});

/** Retired histories can relinquish their native source, but can never become live again. */
export const isClosedNativeDetachment = (thread: OrchestrationV2ProviderThread): boolean =>
  thread.status === "closed" &&
  thread.nativeThreadRef === null &&
  thread.nativeConversationHeadRef === null &&
  thread.contextHandoffRequired === true;
