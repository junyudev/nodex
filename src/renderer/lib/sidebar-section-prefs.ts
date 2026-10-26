export const SIDEBAR_COLLAPSIBLE_SECTION_IDS = ["pinned", "pages", "projects", "chats"] as const;

export type SidebarCollapsibleSectionId = (typeof SIDEBAR_COLLAPSIBLE_SECTION_IDS)[number];

export type SidebarDisclosureSectionId = SidebarCollapsibleSectionId | `custom:${string}`;

export type SidebarCollapsibleSectionsState = Record<string, boolean> &
  Record<SidebarCollapsibleSectionId, boolean>;

/** Show more steps a section keeps revealed, keyed by section. Absent means its first page. */
export type SidebarSectionExtraPagesState = Readonly<
  Partial<Record<SidebarCollapsibleSectionId, number>>
>;

/** Rejects implausible stored values; Show more never approaches it. */
const SIDEBAR_SECTION_MAX_EXTRA_PAGES = 1000;

export function makeDefaultSidebarCollapsibleSectionsState(): SidebarCollapsibleSectionsState {
  return SIDEBAR_COLLAPSIBLE_SECTION_IDS.reduce<SidebarCollapsibleSectionsState>(
    (acc, sectionId) => {
      acc[sectionId] = false;
      return acc;
    },
    {} as SidebarCollapsibleSectionsState,
  );
}

export function isSidebarCollapsibleSectionId(
  value: unknown,
): value is SidebarCollapsibleSectionId {
  return (
    typeof value === "string" &&
    SIDEBAR_COLLAPSIBLE_SECTION_IDS.includes(value as SidebarCollapsibleSectionId)
  );
}

export function normalizeSidebarCollapsibleSectionsState(
  value: unknown,
): SidebarCollapsibleSectionsState {
  const defaults = makeDefaultSidebarCollapsibleSectionsState();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
  const normalized = SIDEBAR_COLLAPSIBLE_SECTION_IDS.reduce<SidebarCollapsibleSectionsState>(
    (acc, sectionId) => {
      const record = value as Record<string, unknown>;
      const collapsed =
        sectionId === "pages" ? (record.pages ?? record.library) : record[sectionId];
      acc[sectionId] = typeof collapsed === "boolean" ? collapsed : defaults[sectionId];
      return acc;
    },
    {} as SidebarCollapsibleSectionsState,
  );
  for (const [key, collapsed] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith("custom:") || key.length > 320) continue;
    if (typeof collapsed === "boolean") normalized[key] = collapsed;
  }
  return normalized;
}

export function normalizeSidebarSectionExtraPages(value: unknown): SidebarSectionExtraPagesState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const normalized: Partial<Record<SidebarCollapsibleSectionId, number>> = {};
  for (const sectionId of SIDEBAR_COLLAPSIBLE_SECTION_IDS) {
    const extraPages = record[sectionId];
    if (typeof extraPages !== "number" || !Number.isInteger(extraPages) || extraPages <= 0) {
      continue;
    }
    normalized[sectionId] = Math.min(extraPages, SIDEBAR_SECTION_MAX_EXTRA_PAGES);
  }
  return normalized;
}

/** Returns the next state, dropping a section that returns to its first page. */
export function withSidebarSectionExtraPages(
  current: SidebarSectionExtraPagesState,
  sectionId: SidebarCollapsibleSectionId,
  extraPages: number,
): SidebarSectionExtraPagesState {
  const next = Math.max(0, Math.trunc(extraPages));
  if ((current[sectionId] ?? 0) === next) return current;
  const { [sectionId]: _previous, ...rest } = current;
  return next === 0 ? rest : { ...rest, [sectionId]: next };
}
