export type ComposerDictationSplit = () => number | null;
export type ComposerDictationFinish = "finished" | "not-active" | "cancelled";
export interface DictationTranscriptSegment {
  readonly id: number;
  readonly text: string;
}

/** Editor-owned provisional transcript. Capture and transcription use the same ports for either editor. */
export interface ComposerDictationTarget {
  start(split?: ComposerDictationSplit): void;
  update(text: string, segment?: DictationTranscriptSegment): void;
  finish(text: string): Promise<ComposerDictationFinish>;
  preserve(): void;
  cancel(): void;
}

export function formatDictationReplacement(before: string, remaining: string, after: string) {
  const prefix =
    remaining && before && !/[\s([{“‘]$/u.test(before) && /^[\p{L}\p{N}]/u.test(remaining)
      ? " "
      : "";
  const suffix =
    remaining && /[\p{L}\p{N}\p{M}]$/u.test(remaining) && /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  return { replacement: prefix + remaining + suffix, trailingSpace: suffix.length };
}
