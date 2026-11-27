import {
  formatDictationReplacement,
  type ComposerDictationSplit,
  type ComposerDictationTarget,
  type DictationTranscriptSegment,
} from "./composer-dictation-target";

interface Range {
  readonly from: number;
  readonly to: number;
}

export interface DictationTextareaSelection extends Range {
  readonly direction?: HTMLTextAreaElement["selectionDirection"];
}

interface Change extends Range {
  readonly replacement: string;
}

interface RecoverableRange extends Range {
  readonly original: string;
}

interface Segment {
  readonly range: Range;
  readonly applied: boolean;
}

interface Session {
  readonly split: ComposerDictationSplit | undefined;
  readonly segments: Map<number, Segment | null>;
  readonly pending: Map<number, string>;
  activeSegment: number;
  recoverable: RecoverableRange[];
}

function replaceRange(text: string, { from, to, replacement }: Change): string {
  return text.slice(0, from) + replacement + text.slice(to);
}

/** Map a range around an edit, or invalidate it when the edit touches its contents. */
function mapRange<T extends Range>(range: T, change: Change): T | null {
  if (change.from === change.to && !change.replacement) return range;
  if (range.from >= change.to) {
    const delta = change.replacement.length - (change.to - change.from);
    return { ...range, from: range.from + delta, to: range.to + delta };
  }
  if (range.to <= change.from) return range;
  return null;
}

function mapSelection(
  selection: DictationTextareaSelection,
  change: Change,
): DictationTextareaSelection {
  const mapPosition = (position: number) =>
    position < change.from
      ? position
      : position < change.to
        ? change.from + Math.min(position - change.from, change.replacement.length)
        : position + change.replacement.length - (change.to - change.from);
  return { ...selection, from: mapPosition(selection.from), to: mapPosition(selection.to) };
}

/** Keep unchanged prefixes and suffixes anchored for late revisions and ordinary textarea edits. */
function textChange(before: string, after: string, caret?: number): Change {
  // A user edit usually leaves the caret at its end. Anchor the suffix there
  // when possible, since repeated text alone cannot tell which copy changed.
  const beforeCaret = before.length - (after.length - (caret ?? after.length));
  const atCaret =
    caret !== undefined && beforeCaret >= 0 && before.slice(beforeCaret) === after.slice(caret);
  let to = atCaret ? beforeCaret : before.length;
  let end = atCaret ? (caret ?? after.length) : after.length;
  let from = 0;
  while (from < Math.min(to, end) && before[from] === after[from]) from++;
  if (!atCaret) {
    while (to > from && end > from && before[to - 1] === after[end - 1]) {
      to--;
      end--;
    }
  }
  return { from, to, replacement: after.slice(from, end) };
}

function retainRecoverableEdit(
  ranges: readonly RecoverableRange[],
  text: string,
  change: Change,
): RecoverableRange[] {
  const retained: RecoverableRange[] = [];
  const touched: RecoverableRange[] = [];
  for (const range of ranges) {
    const mapped = mapRange(range, change);
    if (mapped) retained.push(mapped);
    else touched.push(range);
  }
  const from = Math.min(change.from, ...touched.map((range) => range.from));
  const to = Math.max(change.to, ...touched.map((range) => range.to));
  // A later segment may select the text of an earlier one. Restore their shared
  // original as one range so cancellation cannot bring a provisional transcript back.
  const original = [...touched]
    .sort((left, right) => right.from - left.from)
    .reduce(
      (text, range) =>
        replaceRange(text, {
          from: range.from - from,
          to: range.to - from,
          replacement: range.original,
        }),
      text.slice(from, to),
    );
  retained.push({ from, to: to + change.replacement.length - (change.to - change.from), original });
  return retained;
}

type WriteTextareaEdit = (
  before: string,
  text: string,
  selection: DictationTextareaSelection,
) => void;

/** Tracks plain-text ranges while the Inbox continues to own and persist the actual draft. */
export function createTextareaDictationTarget(initialWriter?: WriteTextareaEdit) {
  let write = initialWriter;
  let text = "";
  let selection: DictationTextareaSelection = { from: 0, to: 0 };
  let session: Session | null = null;
  let composition: Promise<void> | null = null;
  let endComposition: (() => void) | null = null;
  let didEditDuringComposition = false;

  const retarget = () => {
    if (!session) return;
    const id = session.split?.();
    if (id === null || id === undefined) return;
    session.activeSegment = id;
    session.segments.set(id, { range: selection, applied: false });
  };

  const observe = (nextText: string, nextSelection?: DictationTextareaSelection) => {
    const edited = nextText !== text;
    const moved =
      nextSelection && (nextSelection.from !== selection.from || nextSelection.to !== selection.to);
    if (nextSelection) selection = nextSelection;
    else if (edited) selection = { from: nextText.length, to: nextText.length };

    if (edited && session) {
      const change = textChange(
        text,
        nextText,
        nextSelection?.from === nextSelection?.to ? nextSelection?.to : undefined,
      );
      for (const [id, segment] of session.segments) {
        if (!segment) continue;
        const range = mapRange(segment.range, change);
        session.segments.set(id, range ? { ...segment, range } : null);
      }
      session.recoverable = session.recoverable.flatMap((range) => mapRange(range, change) ?? []);
    }
    text = nextText;
    if (!edited && !moved) return;
    if (composition) didEditDuringComposition = true;
    else retarget();
  };

  const apply = (change: Change, nextSelection: DictationTextareaSelection) => {
    const before = text;
    text = replaceRange(text, change);
    selection = nextSelection;
    if (text !== before) write?.(before, text, nextSelection);
  };

  const insert = (transcript: string, range = selection, segmentId?: number) => {
    const { from, to } = range;
    const { replacement, trailingSpace } = formatDictationReplacement(
      text.slice(0, from),
      transcript.replace(/\r\n?/gu, "\n").trim(),
      text.slice(to),
    );
    const previous = text.slice(from, to);
    // A segment that has emitted nothing keeps its original selection.
    if (!replacement && (segmentId === undefined || !session?.segments.get(segmentId)?.applied))
      return;
    if (previous === replacement) return;

    const change = { from, to, replacement };
    const nextRange = { from, to: from + replacement.length };
    const localDiff = textChange(previous, replacement);
    const diff = { ...localDiff, from: from + localDiff.from, to: from + localDiff.to };
    const followsSegment =
      segmentId === undefined ||
      (session?.activeSegment === segmentId && selection.from >= from && selection.to <= to);
    const cursor = nextRange.to - trailingSpace;
    const nextSelection = followsSegment
      ? { from: cursor, to: cursor }
      : mapSelection(selection, diff);
    if (session && segmentId !== undefined) {
      for (const [id, entry] of session.segments) {
        if (id === segmentId || !entry) continue;
        const range = entry.applied
          ? mapRange(entry.range, change)
          : mapSelection(entry.range, diff);
        session.segments.set(id, range ? { ...entry, range } : null);
      }
      session.segments.set(segmentId, { range: nextRange, applied: true });
      session.recoverable = retainRecoverableEdit(session.recoverable, text, change);
    }
    apply(change, nextSelection);
  };

  const update = (transcript: string, segment?: DictationTranscriptSegment) => {
    if (!session) return;
    const id = segment?.id ?? 0;
    const value = segment?.text ?? transcript;
    if (composition) {
      session.pending.set(id, value);
      return;
    }
    const segmentRange = session.segments.get(id)?.range;
    if (segmentRange) insert(value, segmentRange, id);
  };

  const finishComposition = () => {
    if (!composition) return;
    composition = null;
    if (didEditDuringComposition) retarget();
    didEditDuringComposition = false;
    const pending = session?.pending;
    for (const [id, value] of pending ?? []) update(value, { id, text: value });
    pending?.clear();
    endComposition?.();
    endComposition = null;
  };

  const target: ComposerDictationTarget = {
    start(split) {
      session = {
        split,
        segments: new Map(split ? [[0, { range: selection, applied: false }]] : []),
        pending: new Map(),
        activeSegment: 0,
        recoverable: [],
      };
    },
    update,
    async finish(transcript) {
      const finishing = session;
      await composition;
      if (session !== finishing) return "cancelled";
      if (!finishing) return "not-active";
      if (finishing.segments.size === 0) insert(transcript);
      if (finishing.segments.size === 1) update(transcript);
      session = null;
      return "finished";
    },
    preserve() {
      session = null;
    },
    cancel() {
      const recoverable = session?.recoverable;
      session = null;
      if (!recoverable?.length) return;
      const before = text;
      for (const range of [...recoverable].sort((left, right) => right.from - left.from)) {
        const change = { ...range, replacement: range.original };
        text = replaceRange(text, change);
        selection = mapSelection(selection, change);
      }
      if (text !== before) write?.(before, text, selection);
    },
  };

  return {
    ...target,
    get text() {
      return text;
    },
    setWriter(writer: WriteTextareaEdit) {
      write = writer;
    },
    observe,
    insert,
    append: (transcript: string) => insert(transcript, { from: text.length, to: text.length }),
    beginComposition: () => {
      composition ??= new Promise<void>((resolve) => {
        endComposition = resolve;
      });
    },
    finishComposition,
  };
}
