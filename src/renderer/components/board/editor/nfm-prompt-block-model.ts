import { getIntl, type IntlShape } from "@/lib/i18n";
import type { PromptTurnPhase } from "../../../../shared/prompt-turn";

/** Where a Prompt's send button goes: the chat beside the Page, or a new chat. */
export type NfmPromptDestination =
  | { readonly kind: "beside"; readonly sessionId: string; readonly title: string }
  | { readonly kind: "new-chat" };

export type NfmPromptStatusTone = "working" | "attention" | "done" | "idle";

export interface NfmPromptSentPresentation {
  readonly tone: NfmPromptStatusTone;
  readonly label: string;
}

/** When the Prompt went, for a record whose Turn says nothing more. */
export function describeNfmPromptSentAt(sentAt: string, nowMs?: number, intl = getIntl()): string {
  const sentAtMs = Date.parse(sentAt);
  if (!Number.isFinite(sentAtMs))
    return intl.formatMessage({ id: "editor.nfmPromptBlockModel.sent", defaultMessage: "Sent" });
  const minutes = Math.max(0, (nowMs ?? Date.now()) - sentAtMs) / 60_000;
  if (minutes < 1)
    return intl.formatMessage({
      id: "editor.nfmPromptBlockModel.sentJustNow",
      defaultMessage: "Sent just now",
    });
  if (minutes >= 30 * 24 * 60) {
    const date = intl.formatDate(sentAtMs, { month: "short", day: "numeric" });
    return intl.formatMessage(
      { id: "editor.nfmPromptBlockModel.sentDate", defaultMessage: "Sent {date} ago" },
      { date },
    );
  }

  const [unit, count] =
    minutes < 60
      ? (["minute", minutes] as const)
      : minutes < 24 * 60
        ? (["hour", minutes / 60] as const)
        : minutes < 7 * 24 * 60
          ? (["day", minutes / (24 * 60)] as const)
          : (["week", minutes / (7 * 24 * 60)] as const);
  const elapsed = intl.formatNumber(Math.floor(count), {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  });
  return intl.formatMessage(
    { id: "editor.nfmPromptBlockModel.sentAgo", defaultMessage: "Sent {elapsed} ago" },
    { elapsed },
  );
}

/**
 * The last send, as its own Turn stands: what the chat does with other messages never shows here.
 * A record without a known Turn only says when it went.
 */
export function resolveNfmPromptSentPresentation(input: {
  readonly phase: PromptTurnPhase | null;
  readonly sentAt: string;
  readonly nowMs?: number;
  readonly intl?: IntlShape;
}): NfmPromptSentPresentation {
  const intl = input.intl ?? getIntl();
  switch (input.phase) {
    case "queued":
      return {
        tone: "idle",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.queued",
          defaultMessage: "Queued",
        }),
      };
    case "working":
      return {
        tone: "working",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.working",
          defaultMessage: "Working…",
        }),
      };
    case "waiting":
      return {
        tone: "attention",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.needsYou",
          defaultMessage: "Needs you",
        }),
      };
    case "done":
      return {
        tone: "done",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.answered",
          defaultMessage: "Answered",
        }),
      };
    case "failed":
      return {
        tone: "attention",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.failed",
          defaultMessage: "Failed",
        }),
      };
    case "interrupted":
      return {
        tone: "idle",
        label: intl.formatMessage({
          id: "editor.nfmPromptBlockModel.stopped",
          defaultMessage: "Stopped",
        }),
      };
    default:
      return { tone: "idle", label: describeNfmPromptSentAt(input.sentAt, input.nowMs, intl) };
  }
}

/** What the Prompt's Turn is doing, for when there is no reply to show yet. */
export function describeNfmPromptTurnState(
  phase: PromptTurnPhase | null,
  intl = getIntl(),
): string {
  switch (phase) {
    case "queued":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.queuedDetail",
        defaultMessage: "Queued until the chat finishes its current turn.",
      });
    case "working":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.workingDetail",
        defaultMessage: "The chat is working on this.",
      });
    case "waiting":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.waitingDetail",
        defaultMessage: "The chat needs your answer to continue.",
      });
    case "done":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.doneDetail",
        defaultMessage: "The chat finished without a written reply.",
      });
    case "failed":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.failedDetail",
        defaultMessage: "This turn failed. Open the chat to see why.",
      });
    case "interrupted":
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.stoppedDetail",
        defaultMessage: "This turn was stopped before it finished.",
      });
    default:
      return intl.formatMessage({
        id: "editor.nfmPromptBlockModel.missingDetail",
        defaultMessage: "The chat no longer has a record of this send.",
      });
  }
}

export function describeNfmPromptSend(
  destination: NfmPromptDestination,
  sentBefore: boolean,
  intl = getIntl(),
): string {
  if (destination.kind === "new-chat") {
    return sentBefore
      ? intl.formatMessage({
          id: "editor.nfmPromptBlockModel.sendAgainToNewChat",
          defaultMessage: "Send again to a new chat",
        })
      : intl.formatMessage({
          id: "editor.nfmPromptBlockModel.sendToNewChat",
          defaultMessage: "Send to a new chat",
        });
  }
  return sentBefore
    ? intl.formatMessage(
        { id: "editor.nfmPromptBlockModel.sendAgain", defaultMessage: "Send again to {chat}" },
        { chat: destination.title },
      )
    : intl.formatMessage(
        { id: "editor.nfmPromptBlockModel.send", defaultMessage: "Send to {chat}" },
        { chat: destination.title },
      );
}

interface PromptContentNode {
  readonly type?: string;
  readonly content?: unknown;
  readonly children?: readonly unknown[];
}

/** Agent config anywhere in a Prompt makes its send a Turn of its own, never a steer. */
export function nfmPromptStartsNewTurn(block: PromptContentNode): boolean {
  const inline = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.some((item: PromptContentNode) => item?.type === "agentConfig" || inline(item?.content));
  return (
    inline(block.content) ||
    (block.children ?? []).some((child) => nfmPromptStartsNewTurn(child as PromptContentNode))
  );
}

interface PromptTreeEditor {
  getTextCursorPosition: () => { block: { id: string } };
  getParentBlock: (id: string) => { id: string; type: string } | undefined;
  getBlock: (id: string) => { id: string; type: string } | undefined;
}

/** The Prompt holding the caret, through any depth of its own child Blocks. */
export function findNfmPromptBlockAtCaret(editor: PromptTreeEditor): string | null {
  let current: { id: string; type: string } | undefined;
  try {
    current = editor.getBlock(editor.getTextCursorPosition().block.id);
  } catch {
    return null;
  }
  while (current) {
    if (current.type === "prompt") return current.id;
    current = editor.getParentBlock(current.id);
  }
  return null;
}

/** The send button's square, and the gap between it and the text it follows. */
export const NFM_PROMPT_SEND_SIZE = 24;
export const NFM_PROMPT_SEND_GAP = 4;

/** A line of the Prompt's text, measured relative to the Prompt's text column. */
export interface NfmPromptLineBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export type NfmPromptSendAnchor =
  | { readonly placement: "inline"; readonly left: number; readonly top: number }
  | { readonly placement: "below"; readonly left: 0; readonly top: number };

/**
 * Where the send button sits. It follows the last line of text when that line has room for it,
 * and otherwise takes a row of its own beneath the text. Only the horizontal room decides, so the
 * row reserved for the lower placement cannot change which placement applies.
 */
export function resolveNfmPromptSendAnchor(input: {
  readonly lastLine: NfmPromptLineBox | null;
  readonly width: number;
}): NfmPromptSendAnchor {
  const { lastLine } = input;
  if (!lastLine) return { placement: "inline", left: 0, top: 0 };
  const left = lastLine.right + NFM_PROMPT_SEND_GAP;
  if (left + NFM_PROMPT_SEND_SIZE <= input.width) {
    const lineHeight = lastLine.bottom - lastLine.top;
    return {
      placement: "inline",
      left,
      top: lastLine.top + (lineHeight - NFM_PROMPT_SEND_SIZE) / 2,
    };
  }
  return { placement: "below", left: 0, top: lastLine.bottom + NFM_PROMPT_SEND_GAP };
}

export const NODEX_AGENT_MENTION_TITLE = "Nodex";

/** `@` offers Nodex for an empty query or one that starts its name, so `@no` and `@age` find it. */
export function matchesNodexAgentMention(query: string): boolean {
  const term = query.trim().toLowerCase();
  return !term || "nodex".startsWith(term) || "agent".startsWith(term);
}
