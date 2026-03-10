export const SIDEBAR_TOP_LEVEL_SECTION_IDS = ["recents", "cards", "threads", "files"] as const;

export type SidebarTopLevelSectionId = (typeof SIDEBAR_TOP_LEVEL_SECTION_IDS)[number];

export const SIDEBAR_SECTION_ITEM_LIMITS = [5, 10, 15, 20] as const;

export type SidebarSectionItemLimit = (typeof SIDEBAR_SECTION_ITEM_LIMITS)[number];

export const DEFAULT_SIDEBAR_SECTION_ITEM_LIMIT: SidebarSectionItemLimit = 10;

export const SIDEBAR_TOP_LEVEL_SECTION_LABELS: Record<SidebarTopLevelSectionId, string> = {
  recents: "Recents",
  cards: "Cards",
  threads: "Threads",
  files: "Diffs",
};

export interface SidebarTopLevelSectionPrefs {
  visible: boolean;
  itemLimit: SidebarSectionItemLimit;
}

export type SidebarTopLevelSectionsPrefs = Record<SidebarTopLevelSectionId, SidebarTopLevelSectionPrefs>;

export function isSidebarTopLevelSectionId(value: unknown): value is SidebarTopLevelSectionId {
  return typeof value === "string" && SIDEBAR_TOP_LEVEL_SECTION_IDS.includes(value as SidebarTopLevelSectionId);
}

export function isSidebarSectionItemLimit(value: unknown): value is SidebarSectionItemLimit {
  return typeof value === "number" && SIDEBAR_SECTION_ITEM_LIMITS.includes(value as SidebarSectionItemLimit);
}

export function makeDefaultSidebarTopLevelSectionsPrefs(): SidebarTopLevelSectionsPrefs {
  return SIDEBAR_TOP_LEVEL_SECTION_IDS.reduce<SidebarTopLevelSectionsPrefs>((acc, sectionId) => {
    acc[sectionId] = {
      visible: true,
      itemLimit: DEFAULT_SIDEBAR_SECTION_ITEM_LIMIT,
    };
    return acc;
  }, {} as SidebarTopLevelSectionsPrefs);
}

export function normalizeSidebarTopLevelSectionOrder(value: unknown): SidebarTopLevelSectionId[] {
  const preferredOrder = Array.isArray(value) ? value.filter(isSidebarTopLevelSectionId) : [];
  const seen = new Set<SidebarTopLevelSectionId>();
  const nextOrder: SidebarTopLevelSectionId[] = [];

  preferredOrder.forEach((sectionId) => {
    if (seen.has(sectionId)) return;
    seen.add(sectionId);
    nextOrder.push(sectionId);
  });

  SIDEBAR_TOP_LEVEL_SECTION_IDS.forEach((sectionId) => {
    if (seen.has(sectionId)) return;
    nextOrder.push(sectionId);
  });

  return nextOrder;
}

export function normalizeSidebarTopLevelSectionsPrefs(value: unknown): SidebarTopLevelSectionsPrefs {
  const defaults = makeDefaultSidebarTopLevelSectionsPrefs();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;

  return SIDEBAR_TOP_LEVEL_SECTION_IDS.reduce<SidebarTopLevelSectionsPrefs>((acc, sectionId) => {
    const rawSection = (value as Record<string, unknown>)[sectionId];
    if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
      acc[sectionId] = defaults[sectionId];
      return acc;
    }

    const rawSectionRecord = rawSection as Record<string, unknown>;
    const visible = typeof rawSectionRecord.visible === "boolean"
      ? rawSectionRecord.visible
      : defaults[sectionId].visible;
    const itemLimit = isSidebarSectionItemLimit(rawSectionRecord.itemLimit)
      ? rawSectionRecord.itemLimit
      : defaults[sectionId].itemLimit;

    acc[sectionId] = {
      visible,
      itemLimit,
    };
    return acc;
  }, {} as SidebarTopLevelSectionsPrefs);
}

export function resolveVisibleSidebarTopLevelSections(
  order: readonly SidebarTopLevelSectionId[],
  sections: SidebarTopLevelSectionsPrefs,
): SidebarTopLevelSectionId[] {
  return normalizeSidebarTopLevelSectionOrder(order).filter((sectionId) => sections[sectionId].visible);
}

export function moveSidebarTopLevelSection(
  order: readonly SidebarTopLevelSectionId[],
  sections: SidebarTopLevelSectionsPrefs,
  sectionId: SidebarTopLevelSectionId,
  direction: -1 | 1,
): SidebarTopLevelSectionId[] {
  const normalizedOrder = normalizeSidebarTopLevelSectionOrder(order);
  const visibleOrder = resolveVisibleSidebarTopLevelSections(normalizedOrder, sections);
  const currentIndex = visibleOrder.indexOf(sectionId);
  if (currentIndex === -1) return normalizedOrder;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= visibleOrder.length) return normalizedOrder;

  const reorderedVisible = [...visibleOrder];
  const [movedSection] = reorderedVisible.splice(currentIndex, 1);
  reorderedVisible.splice(nextIndex, 0, movedSection);

  let visibleCursor = 0;
  return normalizedOrder.map((candidateId) => {
    if (!sections[candidateId].visible) return candidateId;
    const nextId = reorderedVisible[visibleCursor] ?? candidateId;
    visibleCursor += 1;
    return nextId;
  });
}
