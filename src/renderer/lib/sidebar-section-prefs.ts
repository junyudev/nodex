export const SIDEBAR_COLLAPSIBLE_SECTION_IDS = ["pinned", "pages", "projects", "chats"] as const;

export type SidebarCollapsibleSectionId = (typeof SIDEBAR_COLLAPSIBLE_SECTION_IDS)[number];

export type SidebarDisclosureSectionId = SidebarCollapsibleSectionId | `custom:${string}`;

export type SidebarCollapsibleSectionsState = Record<string, boolean> &
  Record<SidebarCollapsibleSectionId, boolean>;

export const SIDEBAR_SECTION_ITEM_LIMITS = [5, 10, 15, 20] as const;

export type SidebarSectionItemLimit = (typeof SIDEBAR_SECTION_ITEM_LIMITS)[number];

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
