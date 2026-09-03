import { useEffect, useSyncExternalStore } from "react";

import type { CodexConversationTurn } from "../../lib/types";
import {
  hasDurableCanonicalFirstSubmission,
  projectSessionFirstSubmissionTurns,
  selectSessionFirstSubmission,
  sessionFirstSubmissionOwner,
  type FirstSubmissionPresentationTarget,
  type SessionFirstSubmission,
} from "./session-first-submission-owner";

function useFirstSubmissionSnapshot() {
  return useSyncExternalStore(
    sessionFirstSubmissionOwner.subscribe,
    sessionFirstSubmissionOwner.getSnapshot,
    sessionFirstSubmissionOwner.getSnapshot,
  );
}

export function useSessionFirstSubmission(
  target: FirstSubmissionPresentationTarget,
): SessionFirstSubmission | null {
  const snapshot = useFirstSubmissionSnapshot();
  return selectSessionFirstSubmission(snapshot, target);
}

export function useSessionFirstSubmissionTurns(
  target: FirstSubmissionPresentationTarget,
  canonicalTurns: readonly CodexConversationTurn[],
): {
  readonly submission: SessionFirstSubmission | null;
  readonly turns: CodexConversationTurn[];
} {
  const snapshot = useFirstSubmissionSnapshot();
  const submission = selectSessionFirstSubmission(snapshot, target);
  return {
    submission,
    turns: projectSessionFirstSubmissionTurns(snapshot, target, canonicalTurns),
  };
}

function scheduleAfterStablePresentation(callback: () => void): () => void {
  const usesAnimationFrame = typeof requestAnimationFrame === "function";
  const schedule = usesAnimationFrame
    ? requestAnimationFrame
    : (frameCallback: FrameRequestCallback) =>
        setTimeout(() => frameCallback(performance.now()), 0) as unknown as number;
  const cancel = usesAnimationFrame
    ? cancelAnimationFrame
    : (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  let secondFrame: number | null = null;
  const firstFrame = schedule(() => {
    secondFrame = schedule(callback);
  });

  return () => {
    cancel(firstFrame);
    if (secondFrame !== null) cancel(secondFrame);
  };
}

/**
 * Retires the fallback only after the canonical row has survived the final transcript commit.
 * Keeping it across two presentation frames covers route/body remounts without duplicating the
 * row: projection already yields to canonical data whenever that data is present.
 */
export function useAcknowledgeSessionFirstSubmission(
  target: FirstSubmissionPresentationTarget,
  canonicalTurns: readonly CodexConversationTurn[],
  ready: boolean,
): void {
  const snapshot = useFirstSubmissionSnapshot();
  const submission = selectSessionFirstSubmission(snapshot, target);
  const durableCanonicalSubmissionVisible = Boolean(
    submission &&
    hasDurableCanonicalFirstSubmission(canonicalTurns, submission.clientUserMessageId),
  );
  const launchId = submission?.launchId ?? null;
  useEffect(() => {
    if (!ready || !launchId || !durableCanonicalSubmissionVisible) return;
    return scheduleAfterStablePresentation(() => {
      sessionFirstSubmissionOwner.complete(launchId);
    });
  }, [durableCanonicalSubmissionVisible, launchId, ready]);
}
