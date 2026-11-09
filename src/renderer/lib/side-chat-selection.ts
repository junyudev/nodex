import type { PanelId } from "./types";

/** A side chat tab that selected text could join, in its panel presentation. */
export interface SideChatSelectionCandidate {
  readonly tabId: string;
  readonly panelId: PanelId;
  /** Selected in its group. */
  readonly active: boolean;
  /** Idle and ready, or still starting with selections collecting in its draft. */
  readonly accepting: boolean;
}

/** Prefer the active idle chat in the right panel, then the bottom panel. */
export function selectReusableSideChat<Candidate extends SideChatSelectionCandidate>(
  candidates: readonly Candidate[],
): Candidate | null {
  for (const panel of ["right", "bottom"] as const) {
    const inPanel = candidates.filter((candidate) => candidate.panelId === panel);
    const ordered = [
      ...inPanel.filter((candidate) => candidate.active),
      ...inPanel.filter((candidate) => !candidate.active),
    ];
    const available = ordered.find((candidate) => candidate.accepting);
    if (available) return available;
  }
  return null;
}
