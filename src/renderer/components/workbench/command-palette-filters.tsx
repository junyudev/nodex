import { defineMessages, FormattedMessage, useIntl } from "@/lib/i18n";
import { pageAssigneeFromKey, pageAssigneeName } from "../../../shared/work-graph";
import { useMembers } from "@/lib/members-runtime";
import type { ComponentPropsWithoutRef } from "react";
import {
  DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES,
  WORKFLOW_STATUS_ORDER,
  type WorkflowStatus,
} from "../../../shared/workflow-status";
import {
  cloneCommandPalettePageFilters,
  getDefaultCommandPalettePageFilters,
  hasActiveCommandPalettePageFilters,
  summarizeCommandPalettePageFilters,
  type CommandPalettePageFilters,
} from "../../lib/command-palette";
import {
  TOGGLE_LIST_EMPTY_PRIORITY_LABEL,
  TOGGLE_LIST_PRIORITY_CHIP_LABELS,
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_TAG_FILTER_MODES,
} from "../../lib/toggle-list/types";
import { cn } from "../../lib/utils";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "../ui/popover";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "../ui/dropdown";

const tagModeMessages = defineMessages({
  any: { id: "workbench.commandPaletteFilters.tagMode.any", defaultMessage: "Any" },
  all: { id: "workbench.commandPaletteFilters.tagMode.all", defaultMessage: "All" },
  none: { id: "workbench.commandPaletteFilters.tagMode.none", defaultMessage: "None" },
});

const PANEL_CLASS_NAME = "min-w-96 max-w-[min(36rem,calc(100vw-2rem))]";
const SECTION_LABEL =
  "text-xs font-medium uppercase tracking-label text-token-description-foreground select-none";
const ROW_LABEL = "w-18 shrink-0 pt-0.75 text-xs text-token-description-foreground select-none";
const CHIP_BASE =
  "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground";
const CHIP_ACTIVE = "bg-text-info/18 text-info hover:bg-text-info/22 hover:text-info";
const TEXT_BTN =
  "inline-flex items-center gap-1 text-xs font-medium text-token-description-foreground hover:text-token-foreground";
const SUMMARY_CHIP =
  "inline-flex h-6 items-center gap-0.5 rounded-full bg-text-info/14 px-2 text-xs font-medium text-info hover:bg-text-info/18";
export interface CommandPaletteProjectFilterOption {
  id: string;
  label: string;
}

export interface CommandPaletteTagFilterOption {
  id: string;
  label: string;
}

type PopoverFinalFocus = ComponentPropsWithoutRef<typeof NodexPopoverContent>["finalFocus"];

function ToolbarPopoverContent({
  children,
  finalFocus,
}: {
  children: React.ReactNode;
  finalFocus?: PopoverFinalFocus;
}) {
  return (
    <NodexPopoverContent
      side="bottom"
      align="end"
      className={PANEL_CLASS_NAME}
      finalFocus={finalFocus}
    >
      <div className="flex flex-col gap-3 p-2">{children}</div>
    </NodexPopoverContent>
  );
}

function toggleString(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function toggleStatus(values: WorkflowStatus[], value: WorkflowStatus): WorkflowStatus[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function togglePriority(
  values: CommandPalettePageFilters["priorities"],
  value: CommandPalettePageFilters["priorities"][number],
): CommandPalettePageFilters["priorities"] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cn(CHIP_BASE, active && CHIP_ACTIVE)} onClick={onClick}>
      {label}
    </button>
  );
}

function FilterValueRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className={ROW_LABEL}>{label}</span>
      <div className="flex flex-wrap items-start gap-1.5">{children}</div>
    </div>
  );
}

export function CommandPalettePageFilterPopover({
  open,
  onOpenChange,
  finalFocus,
  filters,
  availableTags,
  availableAssignees,
  availableProjects,
  disabled,
  onChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: PopoverFinalFocus;
  filters: CommandPalettePageFilters;
  availableTags: CommandPaletteTagFilterOption[];
  availableAssignees: string[];
  availableProjects: CommandPaletteProjectFilterOption[];
  disabled: boolean;
  onChange: (update: (prev: CommandPalettePageFilters) => CommandPalettePageFilters) => void;
  children: React.ReactNode;
}) {
  const intl = useIntl();
  const members = useMembers();
  const filterActive = hasActiveCommandPalettePageFilters(filters);

  return (
    <NodexPopover open={open && !disabled} onOpenChange={onOpenChange}>
      <NodexPopoverTrigger>{children}</NodexPopoverTrigger>
      <ToolbarPopoverContent finalFocus={finalFocus}>
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL}>
            <FormattedMessage
              id="workbench.commandPaletteFilters.filters"
              defaultMessage={"Filters"}
            />
          </span>
          <button
            type="button"
            className={TEXT_BTN}
            onClick={() => onChange(() => getDefaultCommandPalettePageFilters())}
            disabled={!filterActive}
          >
            <FormattedMessage id="workbench.commandPaletteFilters.reset" defaultMessage={"Reset"} />
          </button>
        </div>

        <FilterValueRow
          label={intl.formatMessage({
            id: "workbench.commandPaletteFilters.status",
            defaultMessage: "Status",
          })}
        >
          {WORKFLOW_STATUS_ORDER.map((status) => (
            <FilterChip
              key={`status:${status}`}
              active={filters.statuses.includes(status)}
              label={intl.formatMessage(DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES[status])}
              onClick={() =>
                onChange((prev) => ({
                  ...cloneCommandPalettePageFilters(prev),
                  statuses: toggleStatus(prev.statuses, status),
                }))
              }
            />
          ))}
        </FilterValueRow>

        <FilterValueRow
          label={intl.formatMessage({
            id: "workbench.commandPaletteFilters.priority",
            defaultMessage: "Priority",
          })}
        >
          {TOGGLE_LIST_PRIORITY_ORDER.map((priority) => (
            <FilterChip
              key={`priority:${priority}`}
              active={filters.priorities.includes(priority)}
              label={TOGGLE_LIST_PRIORITY_CHIP_LABELS[priority]}
              onClick={() =>
                onChange((prev) => ({
                  ...cloneCommandPalettePageFilters(prev),
                  priorities: togglePriority(prev.priorities, priority),
                }))
              }
            />
          ))}
          <FilterChip
            active={filters.includeEmptyPriority}
            label={TOGGLE_LIST_EMPTY_PRIORITY_LABEL}
            onClick={() =>
              onChange((prev) => ({
                ...cloneCommandPalettePageFilters(prev),
                includeEmptyPriority: !prev.includeEmptyPriority,
              }))
            }
          />
        </FilterValueRow>

        <FilterValueRow
          label={intl.formatMessage({
            id: "workbench.commandPaletteFilters.tags",
            defaultMessage: "Tags",
          })}
        >
          <NodexOptionPicker
            value={filters.tagMode}
            onValueChange={(value) =>
              onChange((prev) => ({
                ...cloneCommandPalettePageFilters(prev),
                tagMode: value as CommandPalettePageFilters["tagMode"],
              }))
            }
            options={TOGGLE_LIST_TAG_FILTER_MODES.map((mode) => ({
              value: mode,
              label: intl.formatMessage(tagModeMessages[mode]),
            }))}
            triggerButton={
              <NodexDropdownButtonTrigger size="xs" className="w-18">
                {intl.formatMessage(tagModeMessages[filters.tagMode])}
              </NodexDropdownButtonTrigger>
            }
          />
          {availableTags.length === 0 ? (
            <span className="pt-1 text-xs text-token-description-foreground italic">
              <FormattedMessage
                id="workbench.commandPaletteFilters.noTags"
                defaultMessage={"No tags in results"}
              />
            </span>
          ) : (
            availableTags.map((tag) => (
              <FilterChip
                key={`tag:${tag.id}`}
                active={filters.tags.includes(tag.id)}
                label={tag.label}
                onClick={() =>
                  onChange((prev) => ({
                    ...cloneCommandPalettePageFilters(prev),
                    tags: toggleString(prev.tags, tag.id),
                  }))
                }
              />
            ))
          )}
        </FilterValueRow>

        {(members.data?.length ?? 0) > 1 ? (
          <FilterValueRow
            label={intl.formatMessage({
              id: "workbench.commandPaletteFilters.owner",
              defaultMessage: "Owner",
            })}
          >
            {members.data
              ?.filter((member) => member.lifecycle === "active")
              .map((member) => (
                <FilterChip
                  key={member.id}
                  label={member.display_name}
                  active={filters.owners?.includes(member.id) ?? false}
                  onClick={() =>
                    onChange((prev) => ({
                      ...cloneCommandPalettePageFilters(prev),
                      owners: toggleString(prev.owners ?? [], member.id),
                    }))
                  }
                />
              ))}
          </FilterValueRow>
        ) : null}
        <FilterValueRow
          label={intl.formatMessage({
            id: "workbench.commandPaletteFilters.assignee",
            defaultMessage: "Assignee",
          })}
        >
          {availableAssignees.length === 0 ? (
            <span className="pt-1 text-xs text-token-description-foreground italic">
              <FormattedMessage
                id="workbench.commandPaletteFilters.noAssignees"
                defaultMessage={"No assignees in results"}
              />
            </span>
          ) : (
            availableAssignees.map((assignee) => (
              <FilterChip
                key={`assignee:${assignee}`}
                active={filters.assignees.includes(assignee)}
                label={pageAssigneeName(pageAssigneeFromKey(assignee), members.data)}
                onClick={() =>
                  onChange((prev) => ({
                    ...cloneCommandPalettePageFilters(prev),
                    assignees: toggleString(prev.assignees, assignee),
                  }))
                }
              />
            ))
          )}
        </FilterValueRow>

        <FilterValueRow
          label={intl.formatMessage({
            id: "workbench.commandPaletteFilters.project",
            defaultMessage: "Project",
          })}
        >
          {availableProjects.length === 0 ? (
            <span className="pt-1 text-xs text-token-description-foreground italic">
              <FormattedMessage
                id="workbench.commandPaletteFilters.noProjects"
                defaultMessage={"No projects loaded"}
              />
            </span>
          ) : (
            availableProjects.map((project) => (
              <FilterChip
                key={`project:${project.id}`}
                active={filters.projectIds.includes(project.id)}
                label={project.label}
                onClick={() =>
                  onChange((prev) => ({
                    ...cloneCommandPalettePageFilters(prev),
                    projectIds: toggleString(prev.projectIds, project.id),
                  }))
                }
              />
            ))
          )}
        </FilterValueRow>
      </ToolbarPopoverContent>
    </NodexPopover>
  );
}

export function CommandPalettePageFiltersSummaryRow({
  filters,
  projectNameById,
  tagNameById,
  onOpenFilter,
}: {
  filters: CommandPalettePageFilters;
  projectNameById: ReadonlyMap<string, string>;
  tagNameById?: ReadonlyMap<string, string>;
  onOpenFilter: () => void;
}) {
  const intl = useIntl();
  const members = useMembers();
  const summaries = summarizeCommandPalettePageFilters(
    filters,
    projectNameById,
    tagNameById,
    members.data,
    intl,
  );
  if (summaries.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {summaries.map((summary) => (
        <button key={summary.key} type="button" className={SUMMARY_CHIP} onClick={onOpenFilter}>
          <span className="font-medium">{summary.label}:</span>
          <span className="max-w-56 truncate">{summary.value}</span>
        </button>
      ))}
    </div>
  );
}
