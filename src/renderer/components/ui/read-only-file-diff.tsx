import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { useEffect, useMemo } from "react";
import { diffHighlightCacheKey, diffHighlightTextLength } from "@/lib/diff-highlight-cache";
import { mainThreadSourceLanguage } from "@/lib/source-highlight-cache";
import {
  getSourceHighlightPool,
  primeSourceHighlight,
  SourceHighlightPoolProvider,
  useSourceHighlightPoolState,
} from "@/lib/source-highlight-pool";
import {
  getWordDiffHighlightPool,
  WordDiffHighlightPoolProvider,
  useWordDiffHighlightPoolState,
} from "@/lib/diff-highlight-pool";

type ReadOnlyFileDiffProps<Annotation> = Omit<
  FileDiffProps<Annotation, undefined>,
  | "edit"
  | "editorOptions"
  | "editStateKey"
  | "onEditChange"
  | "onEditComplete"
  | "disableWorkerPool"
>;

/** Read-only diffs share finished syntax work across Session switches. */
export function ReadOnlyFileDiff<Annotation = undefined>(props: ReadOnlyFileDiffProps<Annotation>) {
  const wordDiffs = (props.options?.lineDiffType ?? "word-alt") === "word-alt";
  const ProfileDiff = wordDiffs ? WordDiff : LineDiff;
  // Switching profiles must replace Pierre's instance: it captures its manager
  // at construction, and each manager owns a different set of render options.
  return <ProfileDiff {...props} />;
}

function WordDiff<Annotation>(props: ReadOnlyFileDiffProps<Annotation>) {
  const state = useWordDiffHighlightPoolState();
  return (
    <WordDiffHighlightPoolProvider>
      <PooledDiff {...props} state={state} pool={getWordDiffHighlightPool()} />
    </WordDiffHighlightPoolProvider>
  );
}

function LineDiff<Annotation>(props: ReadOnlyFileDiffProps<Annotation>) {
  const state = useSourceHighlightPoolState();
  return (
    <SourceHighlightPoolProvider>
      <PooledDiff {...props} state={state} pool={getSourceHighlightPool()} />
    </SourceHighlightPoolProvider>
  );
}

function PooledDiff<Annotation>({
  state,
  pool,
  fileDiff,
  ...props
}: ReadOnlyFileDiffProps<Annotation> & {
  readonly state: "working" | "starting" | "unavailable";
  readonly pool: WorkerPoolManager | null;
}) {
  const identity = useMemo(() => diffHighlightCacheKey(fileDiff), [fileDiff]);
  const textLength = useMemo(() => diffHighlightTextLength(fileDiff), [fileDiff]);
  const language =
    state === "working" ? fileDiff.lang : mainThreadSourceLanguage(fileDiff.lang, textLength);
  const highlightedDiff = useMemo(
    () => ({
      ...fileDiff,
      lang: language ?? undefined,
      cacheKey: `${identity}\0${language ?? ""}`,
    }),
    [fileDiff, identity, language],
  );
  useEffect(() => {
    if (state !== "working" || !pool) return;
    // Retain in-flight work across transient row unmounts. A renderer-owned
    // request is otherwise cancelled when its last viewer detaches.
    void primeSourceHighlight(pool, { fileDiff: highlightedDiff }).catch(() => {});
  }, [highlightedDiff, pool, state]);
  return <FileDiff<Annotation> {...props} fileDiff={highlightedDiff} />;
}
