import type { DatabasePage, WorkflowStatus, Priority } from "../types";
import { PRIORITY_VALUES } from "../../../shared/priority";
import { getPriorityShortLabel } from "../priority-presentation";
import type { SortEmptyPlacement } from "../sort-empty-placement";
import { WORKFLOW_STATUS_ORDER } from "../../../shared/workflow-status";

export const TOGGLE_LIST_STATUS_ORDER = [...WORKFLOW_STATUS_ORDER] as const;

export type ToggleListStatusId = WorkflowStatus;

export const TOGGLE_LIST_PRIORITY_ORDER: readonly Priority[] = PRIORITY_VALUES;

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
  emptyPlacement?: SortEmptyPlacement;
}

export const TOGGLE_LIST_RANK_FIELD_LABELS: Record<ToggleListRankField, string> = {
  "board-order": "Board Order",
  status: "Status",
  priority: "Priority",
  estimate: "Estimate",
  created: "Created",
  title: "Title",
};

export const TOGGLE_LIST_PRIORITY_CHIP_LABELS: Record<Priority, string> = Object.fromEntries(
  PRIORITY_VALUES.map((priority) => [priority, getPriorityShortLabel(priority)]),
) as Record<Priority, string>;

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
            {
              field: "priority",
              op: "in",
              values: [...TOGGLE_LIST_PRIORITY_ORDER],
              includeEmpty: true,
            },
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

export interface ToggleListCard extends DatabasePage {
  columnId: ToggleListStatusId;
  columnName: string;
  boardIndex: number;
}
