export const SIDEBAR_COLLAPSIBLE_SECTION_IDS = ["pinned", "pages", "projects", "chats"] as const;

export type SidebarCollapsibleSectionId = (typeof SIDEBAR_COLLAPSIBLE_SECTION_IDS)[number];

export type SidebarDisclosureSectionId = SidebarCollapsibleSectionId | `custom:${string}`;

export type SidebarCollapsibleSectionsState = Record<string, boolean> &
  Record<SidebarCollapsibleSectionId, boolean>;

/**
 * A sidebar list whose revealed depth the Profile remembers: a built-in section, one
 * Project's chats, or a custom Section.
 */
export type SidebarListId = SidebarCollapsibleSectionId | `project:${string}` | `custom:${string}`;

/** Show more steps each sidebar list keeps revealed. Absent means its first page. */
export type SidebarListExtraPagesState = Readonly<Partial<Record<SidebarListId, number>>>;

/** Rejects implausible stored values; Show more never approaches it. */
const SIDEBAR_LIST_MAX_EXTRA_PAGES = 1000;
/** Lists for removed Projects or Sections age out behind the most recently changed ones. */
const SIDEBAR_LIST_MAX_REMEMBERED = 200;

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

export function isSidebarListId(value: string): value is SidebarListId {
  if (isSidebarCollapsibleSectionId(value)) return true;
  if (value.length > 320) return false;
  return (
    (value.startsWith("project:") && value.length > "project:".length) ||
    (value.startsWith("custom:") && value.length > "custom:".length)
  );
}

export function normalizeSidebarListExtraPages(value: unknown): SidebarListExtraPagesState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([listId, pages]) =>
    isSidebarListId(listId) && typeof pages === "number" && Number.isInteger(pages) && pages > 0
      ? [[listId, Math.min(pages, SIDEBAR_LIST_MAX_EXTRA_PAGES)] as const]
      : [],
  );
  return Object.fromEntries(entries.slice(-SIDEBAR_LIST_MAX_REMEMBERED));
}

/**
 * Returns the next state with the changed list most recent, dropping a list that returns
 * to its first page.
 */
export function withSidebarListExtraPages(
  current: SidebarListExtraPagesState,
  listId: SidebarListId,
  extraPages: number,
): SidebarListExtraPagesState {
  const next = Math.max(0, Math.trunc(extraPages));
  if ((current[listId] ?? 0) === next) return current;
  const { [listId]: _previous, ...rest } = current;
  if (next === 0) return rest;
  return Object.fromEntries(
    [...Object.entries(rest), [listId, next] as const].slice(-SIDEBAR_LIST_MAX_REMEMBERED),
  );
}
