export const CARD_STAGE_COLLAPSIBLE_PROPERTIES = [
  "tags",
  "assignee",
  "threads",
  "schedule",
  "agentBlocked",
  "agentStatus",
] as const;

export type CardStageCollapsibleProperty = (typeof CARD_STAGE_COLLAPSIBLE_PROPERTIES)[number];

export const DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES: CardStageCollapsibleProperty[] = [
  "agentBlocked",
  "agentStatus",
];

export const CARD_STAGE_COLLAPSIBLE_PROPERTY_LABELS: Record<CardStageCollapsibleProperty, string> = {
  tags: "Tags",
  assignee: "Assignee",
  threads: "Threads",
  schedule: "Schedule",
  agentBlocked: "Agent blocked",
  agentStatus: "Agent status",
};

export const CARD_STAGE_COLLAPSED_PROPERTIES_STORAGE_KEY = "nodex-card-stage-collapsed-properties-v1";

function isCardStageCollapsibleProperty(value: unknown): value is CardStageCollapsibleProperty {
  return typeof value === "string" && CARD_STAGE_COLLAPSIBLE_PROPERTIES.includes(value as CardStageCollapsibleProperty);
}

function normalizeList(values: unknown[]): CardStageCollapsibleProperty[] {
  const selected = new Set<CardStageCollapsibleProperty>();

  for (const value of values) {
    if (!isCardStageCollapsibleProperty(value)) continue;
    selected.add(value);
  }

  return CARD_STAGE_COLLAPSIBLE_PROPERTIES.filter((property) => selected.has(property));
}

export function normalizeCardStageCollapsedProperties(value: unknown): CardStageCollapsibleProperty[] {
  if (Array.isArray(value)) return normalizeList(value);

  if (typeof value === "string") {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return normalizeList(entries);
  }

  return [...DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES];
}

export function readCardStageCollapsedProperties(): CardStageCollapsibleProperty[] {
  try {
    const raw = localStorage.getItem(CARD_STAGE_COLLAPSED_PROPERTIES_STORAGE_KEY);
    return raw === null ? [...DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES] : normalizeCardStageCollapsedProperties(raw);
  } catch {
    return [...DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES];
  }
}

export function writeCardStageCollapsedProperties(value: unknown): CardStageCollapsibleProperty[] {
  const normalized = normalizeCardStageCollapsedProperties(value);

  try {
    localStorage.setItem(CARD_STAGE_COLLAPSED_PROPERTIES_STORAGE_KEY, normalized.join(","));
  } catch {
    // localStorage may be unavailable.
  }

  return normalized;
}

export function toggleCardStageCollapsedProperty(
  current: readonly CardStageCollapsibleProperty[],
  property: CardStageCollapsibleProperty,
): CardStageCollapsibleProperty[] {
  const selected = new Set(current);

  if (selected.has(property)) {
    selected.delete(property);
  } else {
    selected.add(property);
  }

  return CARD_STAGE_COLLAPSIBLE_PROPERTIES.filter((entry) => selected.has(entry));
}

export function formatCardStageCollapsedPropertyCountLabel(count: number, expanded: boolean): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  const suffix = normalizedCount === 1 ? "property" : "properties";

  return expanded
    ? `Hide ${normalizedCount} ${suffix}`
    : `${normalizedCount} more ${suffix}`;
}
