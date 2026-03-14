export interface CardActionMenuEntry {
  id:
    | "favorite"
    | "edit-icon"
    | "edit-property"
    | "layout"
    | "property-visibility"
    | "open-in"
    | "copy-link"
    | "duplicate"
    | "move-to"
    | "delete";
  label: string;
  shortcut?: string;
  disabled?: boolean;
  keywords: string[];
}

export interface CardMoveTarget {
  id: string;
  label: string;
  description: string;
  icon?: string;
  isCurrent: boolean;
  disabled: boolean;
}

export interface CardContextMenuProjectSummary {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  workspacePath?: string;
}

const CARD_ACTION_MENU_ENTRIES: CardActionMenuEntry[] = [
  {
    id: "favorite",
    label: "Add to Favorites",
    disabled: true,
    keywords: ["favorite", "star", "pin"],
  },
  {
    id: "edit-icon",
    label: "Edit icon",
    disabled: true,
    keywords: ["icon", "emoji", "cover"],
  },
  {
    id: "edit-property",
    label: "Edit property",
    disabled: true,
    keywords: ["property", "field", "metadata"],
  },
  {
    id: "layout",
    label: "Layout",
    disabled: true,
    keywords: ["layout", "view", "appearance"],
  },
  {
    id: "property-visibility",
    label: "Property visibility",
    disabled: true,
    keywords: ["property", "visibility", "display"],
  },
  {
    id: "open-in",
    label: "Open in",
    disabled: true,
    keywords: ["open", "stage", "panel"],
  },
  {
    id: "copy-link",
    label: "Copy deeplink",
    keywords: ["copy", "link", "reference"],
  },
  {
    id: "duplicate",
    label: "Duplicate",
    shortcut: "⌘D",
    disabled: true,
    keywords: ["duplicate", "clone", "copy"],
  },
  {
    id: "move-to",
    label: "Move to",
    shortcut: "⌘⇧P",
    keywords: ["move", "project", "database", "workspace"],
  },
  {
    id: "delete",
    label: "Delete",
    shortcut: "Del",
    keywords: ["delete", "remove", "trash"],
  },
];

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

export function getCardActionMenuEntries(query: string): CardActionMenuEntry[] {
  const normalizedQuery = normalizeSearchValue(query);
  if (normalizedQuery.length === 0) {
    return CARD_ACTION_MENU_ENTRIES;
  }

  return CARD_ACTION_MENU_ENTRIES.filter((entry) => {
    const haystack = [entry.label, ...entry.keywords].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function getCardMoveTargets(
  projects: CardContextMenuProjectSummary[],
  currentProjectId: string,
  query: string,
): CardMoveTarget[] {
  const normalizedQuery = normalizeSearchValue(query);

  return projects
    .filter((project) => {
      if (normalizedQuery.length === 0) {
        return true;
      }

      const haystack = [
        project.name,
        project.id,
        project.description ?? "",
        project.workspacePath ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .map((project) => {
      const isCurrent = project.id === currentProjectId;
      const secondaryText = project.description?.trim()
        || project.workspacePath?.trim();

      return {
        id: project.id,
        label: project.name,
        description: isCurrent ? `Current project${secondaryText ? ` · ${secondaryText}` : ""}` : (secondaryText || "Project"),
        icon: project.icon,
        isCurrent,
        disabled: isCurrent,
      };
    });
}
