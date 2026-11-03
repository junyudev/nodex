import type { SetStateAction } from "react";
import {
  createReviewDiffDraftFromLine,
  readReviewDiffDraftStorage,
  type ReviewDiffDraft,
} from "@/lib/review-diff-annotations";

/** A row owns one cached snapshot of the persisted drafts for its source and patch. */
export function createReviewDiffDraftSource(scope: string, path: string, patchText: string) {
  let snapshot: Record<string, ReviewDiffDraft> | undefined;
  const listeners = new Set<() => void>();
  const getSnapshot = (): Record<string, ReviewDiffDraft> => {
    if (snapshot) return snapshot;
    snapshot = Object.fromEntries(
      Object.entries(readReviewDiffDraftStorage(scope)).flatMap(([key, text]) => {
        const [side, rawLineNumber] = key.split(":");
        if ((side !== "additions" && side !== "deletions") || !rawLineNumber) return [];
        const lineNumber = Number(rawLineNumber);
        if (!Number.isFinite(lineNumber) || lineNumber <= 0) return [];
        const draft = createReviewDiffDraftFromLine({ side, lineNumber, path, patchText });
        return [[key, { ...draft, text }]];
      }),
    );
    return snapshot;
  };
  return {
    scope,
    path,
    patchText,
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(update: SetStateAction<Record<string, ReviewDiffDraft>>) {
      const current = getSnapshot();
      const next = typeof update === "function" ? update(current) : update;
      if (Object.is(current, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
