import type { ChatItem, ChatState } from "@nodex/mobile-protocol";

import { plainMarkdownText } from "../../markdown/parse";

type WorkItem = Extract<ChatItem, { kind: "activity" | "thinking" }>;

export type TranscriptRow =
  | {
      readonly type: "user";
      readonly id: string;
      readonly item: Extract<ChatItem, { kind: "user" }>;
    }
  | {
      readonly type: "assistant";
      readonly id: string;
      readonly item: Extract<ChatItem, { kind: "assistant" }>;
    }
  | {
      readonly type: "notice";
      readonly id: string;
      readonly item: Extract<ChatItem, { kind: "notice" }>;
    }
  | {
      /** A run of tool steps and reasoning, collapsed to one line until opened. */
      readonly type: "work";
      readonly id: string;
      readonly items: readonly WorkItem[];
      readonly running: boolean;
      readonly failedCount: number;
      readonly title: string;
    }
  | { readonly type: "working"; readonly id: "working" };

const isWork = (item: ChatItem): item is WorkItem =>
  item.kind === "activity" || item.kind === "thinking";

/** A step still at work, whose output keeps arriving until it ends. */
export const isRunningStep = (item: ChatItem): boolean =>
  item.kind === "activity" && item.status === "running";

const isItemRunning = (item: WorkItem): boolean =>
  item.kind === "activity" ? isRunningStep(item) : item.streaming;

// A whole line of bold text, still open while it streams, or an ATX heading, either one quoted.
const HEADING_LINE = /^(?:>\s*)*(?:\*\*(?<strong>[^*\n]+?)(?:\*\*)?|#{1,6}\s+(?<atx>\S.*))$/u;
const THOUGHT_EXCERPT_SOURCE = 600;

/**
 * The latest heading a thought names, as plain text. Reasoning summarized in headed sections names
 * what the Agent is doing in each heading; prose thinking has none.
 */
export const thoughtHeading = (text: string): string | null => {
  const lines = text
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .split(/\r\n|\r|\n|[\u2028\u2029\u0085]/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HEADING_LINE.exec(lines[index]?.trim() ?? "");
    const heading = match?.groups?.strong ?? match?.groups?.atx;
    const plain = heading ? plainMarkdownText(heading) : "";
    if (plain) return plain;
  }
  return null;
};

/**
 * How a step reads in a stretch of work, as on the desktop: a thought by its latest heading or the
 * start of its prose, as plain text; a tool step by its title.
 */
export const stepTitle = (item: WorkItem): string =>
  item.kind === "activity"
    ? item.title
    : (thoughtHeading(item.text) ??
      (plainMarkdownText(item.text.slice(0, THOUGHT_EXCERPT_SOURCE)) || "Thought"));

const countSteps = (items: readonly WorkItem[]): number =>
  items.filter((item) => item.kind === "activity").length;

/** One line for a run of work: what it is doing now, or how much it did. */
export const workTitle = (items: readonly WorkItem[], live = true): string => {
  const running = live ? items.findLast(isItemRunning) : undefined;
  if (running)
    return running.kind === "activity"
      ? running.title
      : (thoughtHeading(running.text) ?? "Thinking");
  const steps = countSteps(items);
  if (steps === 0) return "Thought";
  return steps === 1 ? "1 step" : `${steps} steps`;
};

/**
 * Turns transcript items into list rows, oldest first. Adjacent work collapses into one row whose id
 * is its first item's, so an opened group stays open as more steps arrive. While a Run is active and
 * nothing is visibly moving, a trailing row says so; that is never left to a stale spinner. A chat
 * this phone can no longer follow is shown as it was last seen, with nothing in motion.
 */
export const transcriptRows = (
  items: readonly ChatItem[],
  state: Pick<ChatState, "status">,
  live = true,
): readonly TranscriptRow[] => {
  const rows: TranscriptRow[] = [];
  let work: WorkItem[] = [];
  const flush = () => {
    const first = work[0];
    if (!first) return;
    rows.push({
      type: "work",
      id: `work:${first.id}`,
      items: work,
      running: live && work.some(isItemRunning),
      failedCount: work.filter((item) => item.kind === "activity" && item.status === "failed")
        .length,
      title: workTitle(work, live),
    });
    work = [];
  };
  for (const item of items) {
    if (isWork(item)) {
      work.push(item);
      continue;
    }
    flush();
    if (item.kind === "user") rows.push({ type: "user", id: item.id, item });
    else if (item.kind === "assistant") rows.push({ type: "assistant", id: item.id, item });
    else rows.push({ type: "notice", id: item.id, item });
  }
  flush();
  const last = rows.at(-1);
  const moving =
    (last?.type === "assistant" && last.item.streaming) || (last?.type === "work" && last.running);
  if (live && state.status === "running" && !moving) rows.push({ type: "working", id: "working" });
  return rows;
};
