import type { ResponseStreamingMode } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/** Paragraph updates of one message land at most once per window. */
export const ASSISTANT_STREAMING_WINDOW_MS = 400;

/**
 * Buffer assistant messages and reasoning alike, keeping unfinished markdown out of the read
 * model. Paragraphs that arrive inside one window are held and land together when it ends, so
 * the last paragraph of a burst never waits for an update that may not come.
 */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const delivered = new Map<string, { text: string; at: number }>();
  const held = new Map<
    string,
    {
      readonly event: ProviderAdapter.ProviderAdapterV2Event;
      readonly text: string;
      readonly dueAt: number;
    }
  >();
  const accept = (
    event: ProviderAdapter.ProviderAdapterV2Event,
    now: number,
  ): ProviderAdapter.ProviderAdapterV2Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      delivered.delete(key);
      held.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const previous = delivered.get(key);
    const { ready } = splitBufferedAssistantText(message.text);
    if (!ready || ready === previous?.text) return null;
    const update =
      event.type === "message.updated"
        ? { ...event, message: { ...event.message, text: ready } }
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? { ...event, turnItem: { ...event.turnItem, text: ready } }
          : event;
    if (previous && now - previous.at < ASSISTANT_STREAMING_WINDOW_MS) {
      held.set(key, {
        event: update,
        text: ready,
        dueAt: previous.at + ASSISTANT_STREAMING_WINDOW_MS,
      });
      return null;
    }
    held.delete(key);
    delivered.set(key, { text: ready, at: now });
    return update;
  };
  /** Held paragraphs whose window has ended, now delivered. */
  const takeDue = (now: number): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
    const due: ProviderAdapter.ProviderAdapterV2Event[] = [];
    for (const [key, entry] of held) {
      if (entry.dueAt > now) continue;
      held.delete(key);
      delivered.set(key, { text: entry.text, at: now });
      due.push(entry.event);
    }
    return due;
  };
  /** When the earliest held paragraph is due, if any is held. */
  const nextDueAt = (): number | null =>
    held.size === 0 ? null : Math.min(...[...held.values()].map((entry) => entry.dueAt));
  return { accept, takeDue, nextDueAt };
}
