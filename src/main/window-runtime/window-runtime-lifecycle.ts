export type WindowRuntimeAuxiliaryRole = "avatar-overlay";

interface WindowRuntimeWindowSnapshotBase {
  /** Monotonic in-process order of the last focus claim. It is never persisted. */
  readonly focusSequence: number | null;
  readonly focused: boolean;
  readonly webContentsId: number;
  readonly windowId: number;
}

export interface WindowRuntimePrimaryWindowSnapshot extends WindowRuntimeWindowSnapshotBase {
  readonly activeSessionId: string | null;
  readonly kind: "primary";
  readonly layoutRevision: number;
  readonly windowSessionId: string;
}

export interface WindowRuntimeAuxiliaryWindowSnapshot extends WindowRuntimeWindowSnapshotBase {
  readonly kind: "auxiliary";
  readonly role: WindowRuntimeAuxiliaryRole;
}

export type WindowRuntimeWindowSnapshot =
  | WindowRuntimePrimaryWindowSnapshot
  | WindowRuntimeAuxiliaryWindowSnapshot;

/** A bounded projection of live windows; it deliberately excludes complete Workbench layouts. */
export interface WindowRuntimeSnapshot {
  readonly revision: number;
  readonly windows: readonly WindowRuntimeWindowSnapshot[];
}

export type WindowRuntimeLifecycleEvent =
  | {
      readonly kind: "registered";
      readonly revision: number;
      readonly window: WindowRuntimeWindowSnapshot;
    }
  | {
      readonly kind: "layout-changed";
      readonly previousActiveSessionId: string | null;
      readonly revision: number;
      readonly window: WindowRuntimePrimaryWindowSnapshot;
    }
  | {
      readonly kind: "focus-changed";
      readonly revision: number;
      readonly window: WindowRuntimeWindowSnapshot;
    }
  | {
      readonly kind: "released";
      readonly revision: number;
      readonly window: WindowRuntimeWindowSnapshot;
    };

/**
 * Selects one live host without leaking Electron window handles into policy code.
 * Focus wins, then the most recently focused eligible window, then a sole never-focused window.
 */
export function selectPreferredWindowRuntimeWindow(
  snapshot: WindowRuntimeSnapshot,
  isEligible: (window: WindowRuntimeWindowSnapshot) => boolean,
): WindowRuntimeWindowSnapshot | null {
  const eligible = snapshot.windows.filter(isEligible);
  const focused = eligible.filter((window) => window.focused);
  if (focused.length > 0) return selectMostRecentlyFocused(focused);

  const previouslyFocused = eligible.filter((window) => window.focusSequence !== null);
  if (previouslyFocused.length > 0) return selectMostRecentlyFocused(previouslyFocused);

  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

function selectMostRecentlyFocused(
  windows: readonly WindowRuntimeWindowSnapshot[],
): WindowRuntimeWindowSnapshot {
  return windows.reduce((selected, candidate) => {
    const selectedSequence = selected.focusSequence ?? -1;
    const candidateSequence = candidate.focusSequence ?? -1;
    if (candidateSequence > selectedSequence) return candidate;
    if (candidateSequence < selectedSequence) return selected;
    return candidate.webContentsId > selected.webContentsId ? candidate : selected;
  });
}
