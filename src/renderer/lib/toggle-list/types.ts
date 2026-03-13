import type { Card, CardStatus, Priority } from "../types";
import {
  CARD_STATUS_LABELS,
  CARD_STATUS_ORDER,
} from "../../../shared/card-status";

export const TOGGLE_LIST_STATUS_ORDER = [...CARD_STATUS_ORDER] as const;

export type ToggleListStatusId = CardStatus;

export const TOGGLE_LIST_STATUS_LABELS: Record<ToggleListStatusId, string> = {
  ...CARD_STATUS_LABELS,
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

export const TOGGLE_LIST_EMPTY_PRIORITY_LABEL = "-";

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
  includeEmptyPriority: boolean;
  tags: string[];
  tagMode: ToggleListTagFilterMode;
  includeHostCard: boolean;
}

export type ToggleListClause =
  | { field: "status"; op: "in"; values: ToggleListStatusId[] }
  | { field: "priority"; op: "in"; values: Priority[]; includeEmpty?: boolean }
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
  showEmptyPriority: boolean;
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
            { field: "priority", op: "in", values: [...TOGGLE_LIST_PRIORITY_ORDER], includeEmpty: true },
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
  showEmptyPriority: false,
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
