import type { Card, Priority } from "../types";

export const TOGGLE_LIST_STATUS_ORDER = [
  "1-ideas",
  "2-analyzing",
  "3-backlog",
  "4-planning",
  "5-ready",
  "6-in-progress",
  "7-review",
  "8-done",
] as const;

export type ToggleListStatusId = (typeof TOGGLE_LIST_STATUS_ORDER)[number];

export const TOGGLE_LIST_STATUS_LABELS: Record<ToggleListStatusId, string> = {
  "1-ideas": "Ideas",
  "2-analyzing": "Analyzing",
  "3-backlog": "Backlog",
  "4-planning": "Planning",
  "5-ready": "Ready",
  "6-in-progress": "In Progress",
  "7-review": "Review",
  "8-done": "Done",
};

export const TOGGLE_LIST_PRIORITY_ORDER: Priority[] = [
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-later",
];

export const TOGGLE_LIST_PROPERTY_KEYS = ["priority", "estimate", "status", "tags"] as const;
export type ToggleListPropertyKey = (typeof TOGGLE_LIST_PROPERTY_KEYS)[number];

export const TOGGLE_LIST_RANK_FIELDS = [
  "board-order",
  "status",
  "priority",
  "estimate",
  "created",
  "title",
] as const;

export type ToggleListRankField = (typeof TOGGLE_LIST_RANK_FIELDS)[number];
export type ToggleListRankDirection = "asc" | "desc";

export type ToggleListRuleMode = "basic" | "advanced";

export interface ToggleListSortKey {
  field: ToggleListRankField;
  direction: ToggleListRankDirection;
}

export const TOGGLE_LIST_RANK_FIELD_LABELS: Record<ToggleListRankField, string> = {
  "board-order": "Board Order",
  status: "Status",
  priority: "Priority",
  estimate: "Estimate",
  created: "Created",
  title: "Title",
};

export const TOGGLE_LIST_PRIORITY_CHIP_LABELS: Record<Priority, string> = {
  "p0-critical": "P0",
  "p1-high": "P1",
  "p2-medium": "P2",
  "p3-low": "P3",
  "p4-later": "P4",
};

export type ToggleListTagFilterMode = "any" | "all" | "none";

export const TOGGLE_LIST_TAG_FILTER_MODES: ToggleListTagFilterMode[] = ["any", "all", "none"];

export const TOGGLE_LIST_TAG_FILTER_MODE_LABELS: Record<ToggleListTagFilterMode, string> = {
  any: "Any",
  all: "All",
  none: "None",
};

export interface ToggleListFilterRule {
  statuses: ToggleListStatusId[];
  priorities: Priority[];
  tags: string[];
  tagMode: ToggleListTagFilterMode;
  includeHostCard: boolean;
}

export type ToggleListClause =
  | { field: "status"; op: "in"; values: ToggleListStatusId[] }
  | { field: "priority"; op: "in"; values: Priority[] }
  | { field: "tags"; op: "hasAny" | "hasAll" | "hasNone"; values: string[] };

export interface ToggleListFilterGroup {
  all: ToggleListClause[];
}

export interface ToggleListFilterSpec {
  any: ToggleListFilterGroup[];
}

export interface ToggleListRulesV2 {
  mode: ToggleListRuleMode;
  includeHostCard: boolean;
  filter: ToggleListFilterSpec;
  sort: ToggleListSortKey[];
}

export interface ToggleListSettings {
  rulesV2: ToggleListRulesV2;
  propertyOrder: ToggleListPropertyKey[];
  hiddenProperties: ToggleListPropertyKey[];
  showEmptyEstimate: boolean;
}

export const DEFAULT_TOGGLE_LIST_SETTINGS: ToggleListSettings = {
  rulesV2: {
    mode: "basic",
    includeHostCard: false,
    filter: {
      any: [
        {
          all: [
            { field: "status", op: "in", values: [...TOGGLE_LIST_STATUS_ORDER] },
            { field: "priority", op: "in", values: [...TOGGLE_LIST_PRIORITY_ORDER] },
          ],
        },
      ],
    },
    sort: [
      { field: "board-order", direction: "asc" },
      { field: "created", direction: "desc" },
    ],
  },
  propertyOrder: [...TOGGLE_LIST_PROPERTY_KEYS],
  hiddenProperties: [],
  showEmptyEstimate: false,
};

export function formatPropertyName(property: ToggleListPropertyKey): string {
  switch (property) {
    case "priority":
      return "Priority";
    case "estimate":
      return "Estimate";
    case "status":
      return "Status";
    case "tags":
      return "Tags";
    default:
      return property;
  }
}

export interface ToggleListCard extends Card {
  columnId: ToggleListStatusId;
  columnName: string;
  boardIndex: number;
}
