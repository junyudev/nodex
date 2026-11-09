/**
 * A Readback is the agent's opening statement for a Run a person started, shown in the window
 * they moved to when they are no longer looking at that chat. Main decides whether a Readback
 * exists and which window shows it; the window owns how long it stays on screen.
 * See docs/product-specs/desktop-notification-behavior.md#readback.
 */

/** Where opening a Readback goes: the same target a desktop notification for the chat opens. */
export interface ReadbackNavigation {
  readonly hostId: string;
  /** The conversation that spoke: the chat's root Thread, or a side chat's own Thread. */
  readonly conversationId: string;
  /** `session:<id>/thread:<root>` of the chat to select; a side chat names its source chat. */
  readonly navigationPath: string;
  /** The side-chat tab to select inside the source chat, when the speaker is a side chat. */
  readonly activateTabId: string | null;
}

export interface Readback {
  /** One per Run: {@link readbackId}. */
  readonly id: string;
  /** The Session that spoke, which takes Reply and Stop; a side chat's own Session. */
  readonly sessionId: string;
  /** That Session's root Thread. */
  readonly threadId: string;
  /** The exact Run; Stop never reaches a later Run of the same chat. */
  readonly runId: string;
  /** The assistant message the text came from. */
  readonly itemId: string;
  /** The agent's own Markdown, unedited. */
  readonly text: string;
  /** The chat's title when the Readback was made; windows prefer the live title. */
  readonly title: string;
  /** Milliseconds since the epoch when Main admitted the Readback. */
  readonly createdAt: number;
  readonly navigation: ReadbackNavigation;
}

export type ReadbackWithdrawReason =
  /** The person is now looking at the chat. */
  | "seen"
  /** The Run ended while the window showing the Readback was in the background. */
  | "ended"
  /** Readback was turned off. */
  | "disabled"
  /** The chat was archived or deleted. */
  | "removed";

/** Main → the one window chosen to show a Readback. */
export type ReadbackEvent =
  /** Show this Readback; it replaces any Readback of the same Session. */
  | { readonly type: "show"; readonly readback: Readback }
  | { readonly type: "withdraw"; readonly id: string; readonly reason: ReadbackWithdrawReason };

export const readbackId = (sessionId: string, runId: string): string =>
  `readback:${sessionId}:${runId}`;
