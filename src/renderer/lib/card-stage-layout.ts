const STORAGE_KEY = "nodex-card-stage-layout-v1";

interface CardStageLayoutPrefs {
  limitMainContentWidth?: boolean;
}

function readPrefs(): CardStageLayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const candidate = parsed as { limitMainContentWidth?: unknown };
    if (typeof candidate.limitMainContentWidth !== "boolean") return {};

    return { limitMainContentWidth: candidate.limitMainContentWidth };
  } catch {
    return {};
  }
}

function writePrefs(prefs: CardStageLayoutPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable.
  }
}

export function readCardStageContentWidthPreference(): boolean {
  return readPrefs().limitMainContentWidth ?? true;
}

export function writeCardStageContentWidthPreference(limitMainContentWidth: boolean): void {
  writePrefs({ limitMainContentWidth });
}
