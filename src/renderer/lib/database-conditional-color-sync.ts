import type { DatabaseViewConditionalColorRule } from "../../shared/database-kernel";

export function databaseConditionalColorRulesFingerprint(
  rules: readonly DatabaseViewConditionalColorRule[],
): string {
  return JSON.stringify(rules);
}

/**
 * Accepts a new shared value only while the local editor is clean. An in-flight
 * publication may update the shared View after the user has already made a
 * newer edit, so the canonical handoff must never replace that newer draft.
 */
export function reconcileDatabaseConditionalColorDraft(input: {
  readonly previousShared: readonly DatabaseViewConditionalColorRule[];
  readonly nextShared: readonly DatabaseViewConditionalColorRule[];
  readonly draft: readonly DatabaseViewConditionalColorRule[];
}): readonly DatabaseViewConditionalColorRule[] {
  const previousFingerprint = databaseConditionalColorRulesFingerprint(input.previousShared);
  const nextFingerprint = databaseConditionalColorRulesFingerprint(input.nextShared);
  if (nextFingerprint === previousFingerprint) return input.draft;
  return databaseConditionalColorRulesFingerprint(input.draft) === previousFingerprint
    ? input.nextShared
    : input.draft;
}
