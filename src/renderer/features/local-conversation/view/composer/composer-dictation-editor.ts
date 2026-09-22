import { closeHistory } from "@tiptap/pm/history";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import styles from "./composer-dictation-editor.module.css";

interface DictationRange {
  readonly from: number;
  readonly to: number;
  readonly original: Slice;
  readonly startedAt: number;
  readonly cursor?: number;
}
interface DictationSegment {
  readonly transcript: string;
  readonly consumed: number;
  readonly current: DictationRange | null;
}
interface WordArrival {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly delay: number;
}
interface DictationState extends DictationSegment {
  readonly recoverable: readonly DictationRange[];
  readonly arrivals: readonly WordArrival[];
  readonly segments?: ReadonlyMap<number, DictationSegment>;
  readonly cursorRevision?: number;
}

export type ComposerDictationSplit = () => number | null;
export type ComposerDictationFinish = "finished" | "not-active" | "cancelled";

export interface ComposerDictationEditor {
  readonly document: ProseMirrorNode;
  start(split?: ComposerDictationSplit): void;
  update(text: string, segment?: { readonly id: number; readonly text: string }): void;
  finish(
    text: string,
    readDetachedDocument?: () => ProseMirrorNode | null,
  ): Promise<ComposerDictationFinish>;
  preserve(): void;
  cancel(): void;
  dispose(): void;
}

const dictationKey = new PluginKey<DictationState | null>("composer-dictation");
const retargetHandlers = new WeakMap<EditorView, () => void>();
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const withState = (transaction: Transaction, state: DictationState | null): Transaction =>
  transaction.setMeta(dictationKey, { state });

function mapSegment(segment: DictationSegment, transaction: Transaction): DictationSegment {
  let { current, consumed } = segment;
  for (const mapping of transaction.mapping.maps) {
    if (!current) break;
    const range = current;
    let from = range.from;
    mapping.forEach((start, end) => {
      if (start < range.to && end > range.from) from = Math.max(from, end);
    });
    const cursor = range.cursor ?? range.to;
    if (from > range.from) {
      if (from >= cursor) {
        current = null;
        break;
      }
      consumed = segment.transcript.length - (cursor - from);
    }
    const mappedFrom = mapping.map(from, 1);
    current = {
      ...range,
      from: mappedFrom,
      to: range.from === range.to ? mappedFrom : mapping.map(range.to, -1),
      cursor: mapping.map(cursor, 1),
      original: from === range.from ? range.original : Slice.empty,
    };
  }
  return { ...segment, current, consumed };
}

// Anchor the untouched suffix across revisions even when recognition changes earlier words.
export function mapDictationConsumedPrefix(
  previous: string,
  next: string,
  consumed: number,
): number {
  if (consumed === 0 || next.startsWith(previous.slice(0, consumed))) return consumed;
  const before = previous.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) ?? [];
  const after = next.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) ?? [];
  let prefix = 0;
  let offset = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) {
    offset += before[prefix++]!.length;
    if (offset >= consumed) return consumed;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.at(-suffix - 1) === after.at(-suffix - 1)
  )
    suffix += 1;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const replacedLength = before.slice(prefix, oldEnd).join("").length;
  if (consumed >= offset + replacedLength && suffix > 0)
    return consumed + after.slice(prefix, newEnd).join("").length - replacedLength;
  const oldCount = oldEnd - prefix;
  const newCount = newEnd - prefix;
  const costs = Array.from({ length: oldCount + 1 }, () =>
    Array.from({ length: newCount + 1 }, () => 0),
  );
  for (let oldIndex = oldCount; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount; newIndex >= 0; newIndex -= 1) {
      costs[oldIndex]![newIndex] =
        oldIndex === oldCount
          ? newCount - newIndex
          : newIndex === newCount
            ? oldCount - oldIndex
            : Math.min(
                costs[oldIndex + 1]![newIndex]! + 1,
                costs[oldIndex]![newIndex + 1]! + 1,
                costs[oldIndex + 1]![newIndex + 1]! +
                  (before[prefix + oldIndex] === after[prefix + newIndex] ? 0 : 1),
              );
    }
  }
  let oldIndex = 0;
  let newIndex = 0;
  let mapped = offset;
  while (oldIndex < oldCount && offset < consumed) {
    const substitution = before[prefix + oldIndex] === after[prefix + newIndex] ? 0 : 1;
    if (
      newIndex < newCount &&
      costs[oldIndex]![newIndex] === costs[oldIndex + 1]![newIndex + 1]! + substitution
    ) {
      offset += before[prefix + oldIndex++]!.length;
      mapped += after[prefix + newIndex++]!.length;
      continue;
    }
    if (costs[oldIndex]![newIndex] === costs[oldIndex + 1]![newIndex]! + 1) {
      offset += before[prefix + oldIndex++]!.length;
      continue;
    }
    mapped += after[prefix + newIndex++]!.length;
  }
  return mapped;
}

function mapRecoverable(
  ranges: readonly DictationRange[],
  transaction: Transaction,
): readonly DictationRange[] {
  return transaction.mapping.maps.reduce<readonly DictationRange[]>(
    (ranges, mapping) =>
      ranges.flatMap((range) => {
        let touched = false;
        mapping.forEach((from, to) => {
          touched ||= from < range.to && to > range.from;
        });
        return touched
          ? []
          : [{ ...range, from: mapping.map(range.from, 1), to: mapping.map(range.to, -1) }];
      }),
    ranges,
  );
}

export const composerDictationPlugin = new Plugin<DictationState | null>({
  key: dictationKey,
  state: {
    init: () => null,
    apply(transaction, previous, previousEditorState) {
      const meta = transaction.getMeta(dictationKey) as
        | { state: DictationState | null }
        | undefined;
      if (meta) {
        const next = meta.state;
        if (!next?.current) return next;
        const current = next.current;
        const oldRange = previous?.current;
        const oldText = oldRange
          ? previousEditorState.doc.textBetween(oldRange.from, oldRange.to)
          : "";
        const newText = transaction.doc.textBetween(current.from, current.to);
        const appended =
          (!oldRange || oldRange.from === current.from) && newText.startsWith(oldText);
        const now = performance.now();
        const arrivals = appended
          ? (previous?.arrivals ?? []).filter(
              (arrival) => now - arrival.startedAt < 500 + arrival.delay,
            )
          : [];
        if (appended) {
          let wordIndex = 0;
          for (const word of wordSegmenter.segment(newText.slice(oldText.length))) {
            if (!word.isWordLike) continue;
            const from = current.from + oldText.length + word.index;
            arrivals.push({
              from,
              to: from + word.segment.length,
              startedAt: now,
              delay: Math.min(wordIndex++ * 30, 120),
            });
          }
        }
        return { ...next, arrivals };
      }
      if (!previous || (!transaction.docChanged && !transaction.selectionSet)) return previous;
      const recoverable = mapRecoverable(previous.recoverable, transaction);
      if (!previous.segments)
        return {
          ...previous,
          consumed: previous.transcript.length,
          current: null,
          recoverable,
          arrivals: [],
        };
      return {
        ...previous,
        segments: new Map(
          [...previous.segments].map(([id, segment]) => [id, mapSegment(segment, transaction)]),
        ),
        current: null,
        recoverable,
        arrivals: [],
        cursorRevision:
          (previous.cursorRevision ?? 0) +
          (transaction.docChanged || !transaction.selection.eq(previousEditorState.selection)
            ? 1
            : 0),
      };
    },
  },
  props: {
    decorations: (state) =>
      DecorationSet.create(
        state.doc,
        (dictationKey.getState(state)?.arrivals ?? []).map((arrival) =>
          Decoration.inline(arrival.from, arrival.to, {
            class: styles.wordArrival,
            style: `animation-delay: ${arrival.delay}ms`,
            "data-dictation-arrival": String(arrival.startedAt),
          }),
        ),
      ),
  },
  view: () => ({
    update(view, previous) {
      if (
        dictationKey.getState(previous)?.cursorRevision !== undefined &&
        dictationKey.getState(view.state)?.cursorRevision !==
          dictationKey.getState(previous)?.cursorRevision
      )
        retargetHandlers.get(view)?.();
      const startedAt = dictationKey.getState(view.state)?.arrivals.at(-1)?.startedAt;
      if (
        startedAt === undefined ||
        startedAt === dictationKey.getState(previous)?.arrivals.at(-1)?.startedAt
      )
        return;
      for (const element of view.dom.querySelectorAll(`[data-dictation-arrival="${startedAt}"]`)) {
        for (const animation of element.getAnimations?.() ?? []) animation.currentTime = 0;
      }
    },
  }),
});

/** Owns replaceable transcript ranges independently of the React editor's mounted lifetime. */
export function createComposerDictationEditor(view: EditorView): ComposerDictationEditor {
  let detachedState: EditorState | null = null;
  let pendingText: string | null = null;
  const pendingSegments = new Map<number, string>();
  let session = 0;
  let splitAudio: ComposerDictationSplit | undefined;
  let activeSegment = 0;
  let finishComposition: (() => void) | null = null;
  const state = (): EditorState => detachedState ?? view.state;
  const dispatch = (transaction: Transaction): void => {
    if (detachedState) {
      detachedState = detachedState.apply(transaction);
      return;
    }
    view.dispatch(transaction);
  };
  const selectionRange = (): DictationRange => {
    const { selection } = state();
    return {
      from: selection.from,
      to: selection.to,
      original: selection.content(),
      startedAt: Date.now(),
      cursor: selection.to,
    };
  };
  const syncSelection = (): void => {
    if (detachedState) return;
    const selection = view.dom.ownerDocument.getSelection();
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !view.dom.contains(selection.anchorNode) ||
      !view.dom.contains(selection.focusNode)
    )
      return;
    const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
    const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
    const next = TextSelection.between(
      view.state.doc.resolve(anchor),
      view.state.doc.resolve(head),
    );
    if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next));
  };
  const retarget = (): void => {
    const current = dictationKey.getState(state());
    if (!current?.segments || view.composing) return;
    const id = splitAudio?.();
    if (id === undefined || id === null) return;
    activeSegment = id;
    const segments = new Map(current.segments);
    segments.set(id, { transcript: "", consumed: 0, current: selectionRange() });
    dispatch(withState(state().tr, { ...current, segments }));
  };
  const applyTranscript = (text: string, id?: number): void => {
    const base = dictationKey.getState(state());
    const segment = id === undefined ? null : base?.segments?.get(id);
    if (!base || (id !== undefined && !segment?.current)) return;
    const previous = segment ? { ...base, ...segment } : base;
    if (text === previous.transcript) return;
    let consumed = mapDictationConsumedPrefix(previous.transcript, text, previous.consumed);
    if (!previous.current && consumed > 0)
      consumed +=
        text.slice(consumed).match(/^[.!?,;:…。！？、，；：।॥]+(?=\s|$)/u)?.[0].length ?? 0;
    const remaining = text.slice(consumed).trim();
    const next = { ...previous, transcript: text, consumed };
    if (!previous.current && !remaining) {
      dispatch(withState(state().tr, next));
      return;
    }
    const editorState = state();
    const range = previous.current ?? selectionRange();
    const before = editorState.doc.textBetween(Math.max(0, range.from - 1), range.from, "\n");
    const after = editorState.doc.textBetween(
      range.to,
      Math.min(editorState.doc.content.size, range.to + 1),
      "\n",
    );
    const prefix =
      remaining && before && !/[\s([{“‘]$/u.test(before) && /^[\p{L}\p{N}]/u.test(remaining)
        ? " "
        : "";
    const suffix =
      remaining && /[\p{L}\p{N}\p{M}]$/u.test(remaining) && /^[\p{L}\p{N}]/u.test(after) ? " " : "";
    const replacement = prefix + remaining + suffix;
    const original = editorState.doc.textBetween(range.from, range.to);
    let sameStart = 0;
    let sameEnd = 0;
    while (sameStart < original.length && original[sameStart] === replacement[sameStart])
      sameStart += 1;
    while (
      sameEnd < original.length - sameStart &&
      sameEnd < replacement.length - sameStart &&
      original.at(-sameEnd - 1) === replacement.at(-sameEnd - 1)
    )
      sameEnd += 1;
    const transaction = editorState.tr
      .insertText(
        replacement.slice(sameStart, replacement.length - sameEnd),
        range.from + sameStart,
        range.to - sameEnd,
      )
      .setTime(range.startedAt);
    if (!previous.current) closeHistory(transaction);
    const current = {
      ...range,
      to: range.from + replacement.length,
      cursor: range.from + replacement.length - suffix.length,
    };
    const recoverable = previous.recoverable
      .filter(
        (entry) => entry !== previous.current && !(range.from < entry.to && range.to > entry.from),
      )
      .map((entry) => ({
        ...entry,
        from: transaction.mapping.map(entry.from, 1),
        to: transaction.mapping.map(entry.to, -1),
      }));
    recoverable.push(current);
    if (
      id === undefined ||
      (id === activeSegment &&
        editorState.selection.empty &&
        editorState.selection.head === range.cursor)
    ) {
      transaction.setSelection(TextSelection.create(transaction.doc, current.cursor));
    } else if (editorState.selection instanceof TextSelection) {
      const mapPosition = (position: number): number =>
        position >= range.from && position < range.to
          ? Math.min(position, current.to)
          : transaction.mapping.map(position);
      transaction.setSelection(
        TextSelection.create(
          transaction.doc,
          mapPosition(editorState.selection.anchor),
          mapPosition(editorState.selection.head),
        ),
      );
    }
    let segments = previous.segments;
    if (segments && id !== undefined)
      segments = new Map(
        [...segments].map(([segmentId, entry]) => [
          segmentId,
          segmentId === id
            ? { transcript: text, consumed, current }
            : mapSegment(entry, transaction),
        ]),
      );
    const scrollParent = detachedState ? null : view.dom.parentElement;
    const atBottom =
      scrollParent &&
      scrollParent.scrollHeight - scrollParent.clientHeight - scrollParent.scrollTop <= 1;
    dispatch(withState(transaction, { ...next, segments, current, recoverable }));
    if (scrollParent && atBottom) scrollParent.scrollTop = scrollParent.scrollHeight;
  };
  const update = (text: string, segment?: { readonly id: number; readonly text: string }): void => {
    if (view.isDestroyed && !detachedState) return;
    if (!detachedState && view.composing) {
      if (segment) pendingSegments.set(segment.id, segment.text);
      else pendingText = text;
      return;
    }
    if (!detachedState && view.hasFocus()) syncSelection();
    applyTranscript(segment?.text ?? text, segment?.id);
  };
  const flushComposition = (): void => {
    queueMicrotask(() => {
      const text = pendingText;
      pendingText = null;
      if (text !== null) update(text);
      for (const [id, text] of pendingSegments) update(text, { id, text });
      pendingSegments.clear();
      retarget();
      finishComposition?.();
      finishComposition = null;
    });
  };
  view.dom.addEventListener("compositionend", flushComposition);
  retargetHandlers.set(view, retarget);
  return {
    get document() {
      return state().doc;
    },
    start(split) {
      splitAudio = undefined;
      syncSelection();
      splitAudio = split;
      activeSegment = 0;
      session += 1;
      pendingText = null;
      pendingSegments.clear();
      finishComposition?.();
      finishComposition = null;
      dispatch(
        withState(closeHistory(state().tr), {
          transcript: "",
          consumed: 0,
          current: null,
          recoverable: [],
          arrivals: [],
          segments: split
            ? new Map([[0, { transcript: "", consumed: 0, current: selectionRange() }]])
            : undefined,
          cursorRevision: split ? 0 : undefined,
        }),
      );
    },
    update,
    async finish(text, readDetachedDocument) {
      if (!dictationKey.getState(state())) return "not-active";
      const finishingSession = session;
      if (!detachedState && view.composing)
        await new Promise<void>((resolve) => {
          finishComposition = resolve;
        });
      if (finishingSession !== session) return "cancelled";
      if (!view.dom.isConnected) {
        const document = readDetachedDocument?.();
        if (document && !document.eq(state().doc)) {
          const transaction = state().tr.replaceWith(0, state().doc.content.size, document.content);
          transaction.setSelection(TextSelection.atEnd(transaction.doc));
          dispatch(transaction);
        }
      }
      splitAudio = undefined;
      const segments = dictationKey.getState(state())?.segments;
      if (!segments) applyTranscript(text);
      else if (segments.size === 1) applyTranscript(text, 0);
      dispatch(withState(closeHistory(state().tr), null));
      return "finished";
    },
    preserve() {
      splitAudio = undefined;
      session += 1;
      pendingText = null;
      pendingSegments.clear();
      finishComposition?.();
      finishComposition = null;
      dispatch(withState(closeHistory(state().tr), null));
    },
    cancel() {
      splitAudio = undefined;
      session += 1;
      pendingText = null;
      pendingSegments.clear();
      finishComposition?.();
      finishComposition = null;
      const current = dictationKey.getState(state());
      if (!current) return;
      const transaction = state().tr;
      for (const range of [...current.recoverable].sort((left, right) => right.from - left.from))
        transaction.replace(range.from, range.to, range.original);
      dispatch(withState(closeHistory(transaction), null));
    },
    dispose() {
      detachedState ??= view.state;
      retargetHandlers.delete(view);
      splitAudio = undefined;
      pendingText = null;
      pendingSegments.clear();
      finishComposition?.();
      finishComposition = null;
      view.dom.removeEventListener("compositionend", flushComposition);
    },
  };
}
