import type { Cue } from "./timeline";

/** One message sweeping through the composer and into the Inbox. */
export interface BurstEntry {
  readonly id: string;
  readonly text: string;
  /** The composer starts filling. */
  readonly start: number;
  /** The message leaves the composer and lands in the Inbox. */
  readonly sent: number;
}

export interface InboxBurst {
  readonly entries: readonly BurstEntry[];
  /** `sent:<id>` when a message lands and `planned:<id>` when its plan does, in time order. */
  readonly cues: readonly Cue[];
  /** When the last plan lands. */
  readonly plannedAt: number;
}

/** The composer fills in a quick sweep: it is the burst that reads, not each keystroke. */
export const BURST_TYPE_MS = 4;
/** The full message holds a beat before it sends, so each one registers. */
const SEND_HOLD_MS = 70;
const NEXT_MESSAGE_MS = 90;
/** How long the Inbox thinks about a message before its plan lands. */
const PLAN_MS = 650;

/**
 * A burst of messages dropped into the Inbox back to back. Each one is planned while the rest are
 * still arriving, so plans land in the order the messages were sent and the first one shows
 * within about a second.
 */
export function buildInboxBurstTimeline(
  messages: readonly { readonly id: string; readonly text: string }[],
  startAt: number,
): InboxBurst {
  const entries: BurstEntry[] = [];
  const cues: Cue[] = [];
  let clock = startAt;
  let plannedAt = startAt;
  for (const { id, text } of messages) {
    const sent = clock + text.length * BURST_TYPE_MS + SEND_HOLD_MS;
    entries.push({ id, text, start: clock, sent });
    plannedAt = sent + PLAN_MS;
    cues.push({ id: `sent:${id}`, at: sent }, { id: `planned:${id}`, at: plannedAt });
    clock = sent + NEXT_MESSAGE_MS;
  }
  return { entries, cues: cues.sort((a, b) => a.at - b.at), plannedAt };
}

/** What the composer holds at `t`: the message being typed, or nothing between messages. */
export function composerTextAt(burst: InboxBurst, t: number): string {
  const entry = burst.entries.find((candidate) => t >= candidate.start && t < candidate.sent);
  return entry ? entry.text.slice(0, Math.ceil((t - entry.start) / BURST_TYPE_MS)) : "";
}

/** The burst holds the composer from its first keystroke to its last send. */
export function composingAt(burst: InboxBurst, t: number): boolean {
  const first = burst.entries[0];
  const last = burst.entries.at(-1);
  return first !== undefined && last !== undefined && t >= first.start && t < last.sent;
}
