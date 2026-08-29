export type DatabaseViewPresentationActivityPhase = "ready" | "saving" | "loading" | "publishing";

export interface DatabaseViewPresentationActivity {
  readonly phase: DatabaseViewPresentationActivityPhase;
  readonly interactionLocked: boolean;
}

/**
 * Personal writes are optimistic and serialized, so saving is observable work
 * rather than an interaction lock. Hydration and durable publication are the
 * only phases in which presentation controls cannot safely accept new intent.
 */
export function resolveDatabaseViewPresentationActivity({
  loading,
  saving,
  publishing,
}: {
  readonly loading: boolean;
  readonly saving: boolean;
  readonly publishing: boolean;
}): DatabaseViewPresentationActivity {
  if (publishing) return { phase: "publishing", interactionLocked: true };
  if (loading) return { phase: "loading", interactionLocked: true };
  if (saving) return { phase: "saving", interactionLocked: false };
  return { phase: "ready", interactionLocked: false };
}
