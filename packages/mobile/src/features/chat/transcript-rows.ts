import type { ChatItem, ChatState } from "@nodex/mobile-protocol";

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

const isItemRunning = (item: WorkItem): boolean =>
  item.kind === "activity" ? item.status === "running" : item.streaming;

const countSteps = (items: readonly WorkItem[]): number =>
  items.filter((item) => item.kind === "activity").length;

/** One line for a run of work: what it is doing now, or how much it did. */
export const workTitle = (items: readonly WorkItem[]): string => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && isItemRunning(item)) return item.kind === "activity" ? item.title : "Thinking";
  }
  const steps = countSteps(items);
  if (steps === 0) return "Thought";
  return steps === 1 ? "1 step" : `${steps} steps`;
};

/**
 * Turns transcript items into list rows, oldest first. Adjacent work collapses into one row whose id
 * is its first item's, so an opened group stays open as more steps arrive. While a Run is active and
 * nothing is visibly moving, a trailing row says so; that is never left to a stale spinner.
 */
export const transcriptRows = (
  items: readonly ChatItem[],
  state: Pick<ChatState, "status">,
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
      running: work.some(isItemRunning),
      failedCount: work.filter((item) => item.kind === "activity" && item.status === "failed")
        .length,
      title: workTitle(work),
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
  if (state.status === "running" && !moving) rows.push({ type: "working", id: "working" });
  return rows;
};
