export const TEXT_ACTION_COLOR_VALUES = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export const TEXT_ACTION_NOTION_COLOR_ORDER = TEXT_ACTION_COLOR_VALUES;

export type TextActionColorValue = (typeof TEXT_ACTION_COLOR_VALUES)[number];
export type TextActionRecentColorKind = "text" | "background";

export interface TextActionRecentColor {
  kind: TextActionRecentColorKind;
  color: Exclude<TextActionColorValue, "default">;
}

export const TEXT_ACTION_RECENT_COLOR_STORAGE_KEY = "nodex.textAction.currentHighlightColor.v1";
export const TEXT_ACTION_RECENT_COLOR_LIMIT = 5;
export const DEFAULT_TEXT_ACTION_RECENT_COLOR: TextActionRecentColor = {
  kind: "background",
  color: "yellow",
};
export const DEFAULT_TEXT_ACTION_RECENT_COLORS: readonly TextActionRecentColor[] = [
  DEFAULT_TEXT_ACTION_RECENT_COLOR,
];

type TextActionRecentColorStorage = Pick<Storage, "getItem" | "setItem">;

const TEXT_ACTION_COLOR_SET = new Set<string>(TEXT_ACTION_COLOR_VALUES);

export function isTextActionColorValue(value: unknown): value is TextActionColorValue {
  return typeof value === "string" && TEXT_ACTION_COLOR_SET.has(value);
}

function isRecentColorValue(value: unknown): value is Exclude<TextActionColorValue, "default"> {
  return isTextActionColorValue(value) && value !== "default";
}

function readBrowserStorage(): TextActionRecentColorStorage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseTextActionRecentColor(value: unknown): TextActionRecentColor | null {
  if (typeof value === "string") {
    const backgroundMatch = value.match(/^([a-z]+)_background$/);
    if (backgroundMatch && isRecentColorValue(backgroundMatch[1])) {
      return {
        kind: "background",
        color: backgroundMatch[1],
      };
    }

    if (isRecentColorValue(value)) {
      return {
        kind: "text",
        color: value,
      };
    }
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<TextActionRecentColor>;
  if (
    (candidate.kind === "text" || candidate.kind === "background") &&
    isRecentColorValue(candidate.color)
  ) {
    return {
      kind: candidate.kind,
      color: candidate.color,
    };
  }

  return null;
}

function areSameRecentColor(first: TextActionRecentColor, second: TextActionRecentColor): boolean {
  return first.kind === second.kind && first.color === second.color;
}

export function normalizeTextActionRecentColor(value: unknown): TextActionRecentColor {
  return parseTextActionRecentColor(value) ?? DEFAULT_TEXT_ACTION_RECENT_COLOR;
}

export function normalizeTextActionRecentColors(value: unknown): TextActionRecentColor[] {
  const candidates = Array.isArray(value) ? value : [value];
  const recents: TextActionRecentColor[] = [];

  for (const candidate of candidates) {
    const recent = parseTextActionRecentColor(candidate);
    if (!recent) continue;
    if (recents.some((existing) => areSameRecentColor(existing, recent))) continue;

    recents.push(recent);
    if (recents.length >= TEXT_ACTION_RECENT_COLOR_LIMIT) break;
  }

  if (recents.length === 0) {
    return [...DEFAULT_TEXT_ACTION_RECENT_COLORS];
  }

  return recents;
}

export function readTextActionRecentColors(
  storage: TextActionRecentColorStorage | null = readBrowserStorage(),
): TextActionRecentColor[] {
  if (!storage) return [...DEFAULT_TEXT_ACTION_RECENT_COLORS];

  try {
    const rawValue = storage.getItem(TEXT_ACTION_RECENT_COLOR_STORAGE_KEY);
    if (!rawValue) return [...DEFAULT_TEXT_ACTION_RECENT_COLORS];
    return normalizeTextActionRecentColors(JSON.parse(rawValue));
  } catch {
    return [...DEFAULT_TEXT_ACTION_RECENT_COLORS];
  }
}

export function writeTextActionRecentColors(
  recents: unknown,
  storage: TextActionRecentColorStorage | null = readBrowserStorage(),
): TextActionRecentColor[] {
  const normalized = normalizeTextActionRecentColors(recents);
  if (!storage) return normalized;

  try {
    storage.setItem(TEXT_ACTION_RECENT_COLOR_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    return normalized;
  }

  return normalized;
}

export function recordTextActionRecentColors(
  kind: TextActionRecentColorKind,
  color: TextActionColorValue,
  storage: TextActionRecentColorStorage | null = readBrowserStorage(),
): TextActionRecentColor[] | null {
  if (color === "default") return null;

  const recent = { kind, color };
  const existingRecents = readTextActionRecentColors(storage);
  const nextRecents = [
    recent,
    ...existingRecents.filter((candidate) => !areSameRecentColor(candidate, recent)),
  ].slice(0, TEXT_ACTION_RECENT_COLOR_LIMIT);

  return writeTextActionRecentColors(nextRecents, storage);
}
