/** The message accepted by a Page send, whether it starts, queues, or steers a Turn. */
export interface PageChatSendResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly messageId: string;
}
