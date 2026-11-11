import type { InboxDecision, PushPreferences } from "@nodex/mobile-protocol";
import { getRuntime } from "./instance";
import type { MobileRuntime } from "./runtime";

export type { ConnectionState, SavedHost } from "./connection";
export type { InboxFilter, InboxRow } from "./lists";
export type { NotificationProblem } from "./notifications";
export type { PendingCapture } from "./outbox";
export type { LocalImage } from "./platform";
export {
  useConnection,
  useHosts,
  useProjects,
  useAgentCatalog,
  useNewChatPreferences,
  useInbox,
  useChats,
  useChat,
  useFileUri,
  usePictureUri,
  useNotifications,
} from "./hooks";

export const enableNotifications = () => getRuntime().notifications.enable();
export const retryNotifications = () => getRuntime().notifications.retry();
export const setNotificationPreferences = (patch: Partial<PushPreferences>) =>
  getRuntime().notifications.setPreferences(patch);
export const dismissNotificationOffer = () => getRuntime().notifications.dismissOffer();
export const clearChatNotifications = (sessionId: string) =>
  getRuntime().notifications.clearDelivered({ sessionId });
/** An opened Inbox message is seen: clear what was delivered about its Page and its chat. */
export const clearInboxNotifications = (pageId: string, sessionId: string | null) =>
  getRuntime().notifications.clearDelivered(sessionId ? { pageId, sessionId } : { pageId });

export const pairWithUri = (uri: string) => getRuntime().connection.pairWithUri(uri);
export const activateHost = (hostId: string) => getRuntime().connection.activateHost(hostId);
export const forgetHost = (hostId: string) => getRuntime().forgetHost(hostId);
export const reconnectNow = () => getRuntime().connection.reconnectNow();

export const captureToInbox = (input: Parameters<MobileRuntime["outbox"]["captureToInbox"]>[0]) =>
  getRuntime().outbox.captureToInbox(input);
export const retryCapture = (captureId: string) => getRuntime().outbox.retryCapture(captureId);
export const discardCapture = (captureId: string) => getRuntime().outbox.discardCapture(captureId);
export const decideInbox = (pageId: string, decision: InboxDecision) =>
  getRuntime().decideInbox(pageId, decision);
export const undoInbox = (undoToken: string) => getRuntime().undoInbox(undoToken);
export const fetchInboxEntry = (pageId: string) => getRuntime().fetchInboxEntry(pageId);
/** Calls back whenever the connected Space says its Inbox may have changed. */
export const onInboxChanged = (handler: () => void) =>
  getRuntime().connection.rpc.on("changed", ({ topics }) => {
    if (topics.includes("inbox")) handler();
  });

export const startChat = (input: Parameters<MobileRuntime["startChat"]>[0]) =>
  getRuntime().startChat(input);
export const fetchChatItem = (sessionId: string, itemId: string) =>
  getRuntime().fetchChatItem(sessionId, itemId);
export const markChatRead = (sessionId: string) => getRuntime().chats.markChatRead(sessionId);
export const setChatArchived = (sessionId: string, archived: boolean) =>
  getRuntime().setChatArchived(sessionId, archived);

export const resolveFileUri = (ref: string): Promise<string> => getRuntime().resolveFileUri(ref);
