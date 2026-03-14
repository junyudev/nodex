const STORAGE_KEY = "nodex-card-stage-layout-v1";

interface CardStageLayoutPrefs {
  limitMainContentWidth?: boolean;
  showRawContent?: boolean;
}

function readPrefs(): CardStageLayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const candidate = parsed as {
      limitMainContentWidth?: unknown;
      showRawContent?: unknown;
    };

    const prefs: CardStageLayoutPrefs = {};
    if (typeof candidate.limitMainContentWidth === "boolean") {
      prefs.limitMainContentWidth = candidate.limitMainContentWidth;
    }
    if (typeof candidate.showRawContent === "boolean") {
      prefs.showRawContent = candidate.showRawContent;
    }

    return prefs;
  } catch {
    return {};
  }
}

function writePrefs(prefs: CardStageLayoutPrefs): void {
  try {
    const nextPrefs = {
      ...readPrefs(),
      ...prefs,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPrefs));
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

export function readCardStageShowRawContentPreference(): boolean {
  return readPrefs().showRawContent ?? false;
}

export function writeCardStageShowRawContentPreference(showRawContent: boolean): void {
  writePrefs({ showRawContent });
}
