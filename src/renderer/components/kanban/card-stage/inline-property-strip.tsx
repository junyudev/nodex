import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { estimateOptions, estimateStyles, type Estimate, type Priority } from "@/lib/types";
import { columnStyles } from "@/components/kanban/column";
import { CalendarIcon, PriorityIcon, StatusIcon } from "@/components/shared/property-icons";
import { KANBAN_PRIORITY_OPTIONS, KANBAN_STATUS_OPTIONS } from "@/lib/kanban-options";
import {
  cardStagePropertyEmptyValue,
  cardStagePropertyEmptyValueInteractive,
  cardStagePropertyInputChrome,
  cardStagePropertyTextSize,
  cardStagePropertyTriggerChrome,
  cardStagePropertyValueHoverSurface,
} from "./property-value-styles";

interface CardStageInlinePropertyStripProps {
  priority: Priority;
  estimate: string;
  dueDate: string;
  currentColumnId: string;
  currentColumnName: string;
  colStyle: {
    badgeBg: string;
    badgeText: string;
    accentColor: string;
  };
  onPriorityChange: (next: Priority) => void;
  onEstimateChange: (next: string) => void;
  onDueDateChange: (next: string) => void;
  onClearDueDate: () => void;
  onSetDueDateToday: () => void;
  onColumnChange: (nextColumnId: string) => Promise<void>;
}

export function CardStageInlinePropertyStrip({
  priority,
  estimate,
  dueDate,
  currentColumnId,
  currentColumnName,
  colStyle,
  onPriorityChange,
  onEstimateChange,
  onDueDateChange,
  onClearDueDate,
  onSetDueDateToday,
  onColumnChange,
}: CardStageInlinePropertyStripProps) {
  return (
    <div className="mb-3">
      <div className="grid w-fit grid-cols-[auto_auto_auto_auto] gap-x-4">
        <div className="flex h-6 items-center">
          <div className="flex items-center gap-0.5 rounded-sm px-1.5">
            <div className="flex h-6 w-4 items-center justify-center text-(--foreground-secondary)">
              <PriorityIcon />
            </div>
            <span className="text-sm/4.5 font-medium text-(--foreground-secondary)">Priority</span>
          </div>
        </div>

        <div className="flex h-6 items-center">
          <div className="flex items-center gap-0.5 rounded-sm px-1.5">
            <div className="flex h-6 w-4 items-center justify-center text-(--foreground-secondary)">
              <StatusIcon />
            </div>
            <span className="text-sm/4.5 font-medium text-(--foreground-secondary)">Status</span>
          </div>
        </div>

        <div className="flex h-6 items-center">
          <div className="flex items-center gap-0.5 rounded-sm px-1.5">
            <div className="flex h-6 w-4 items-center justify-center text-(--foreground-secondary)">
              <PriorityIcon />
            </div>
            <span className="text-sm/4.5 font-medium text-(--foreground-secondary)">Estimates</span>
          </div>
        </div>

        <div className="flex h-6 items-center">
          <div className="flex items-center gap-0.5 rounded-sm px-1.5">
            <div className="flex h-6 w-4 items-center justify-center text-(--foreground-secondary)">
              <CalendarIcon />
            </div>
            <span className="text-sm/4.5 font-medium text-(--foreground-secondary)">Due date</span>
          </div>
        </div>

        <div className="flex h-7.5 items-center px-1.5">
          <Select value={priority} onValueChange={(value) => onPriorityChange(value as Priority)}>
            <SelectTrigger
              className={cn(
                cardStagePropertyTriggerChrome,
                cardStagePropertyValueHoverSurface,
                "gap-1 px-0",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 items-center rounded-sm px-1.5 text-sm",
                  KANBAN_PRIORITY_OPTIONS.find((option) => option.value === priority)?.className,
                )}
              >
                {KANBAN_PRIORITY_OPTIONS.find((option) => option.value === priority)?.shortLabel}
              </span>
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {KANBAN_PRIORITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span
                    className={cn(
                      "inline-flex h-5 items-center rounded-sm px-1.5 text-sm",
                      option.className,
                    )}
                  >
                    {option.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex h-7.5 items-center px-1.5">
          <Select value={currentColumnId} onValueChange={(value) => void onColumnChange(value)}>
            <SelectTrigger
              className={cn(
                cardStagePropertyTriggerChrome,
                cardStagePropertyValueHoverSurface,
                "gap-0 px-0",
              )}
            >
              <div
                className={cn(
                  "inline-flex h-5 items-center overflow-hidden rounded-lg pr-2 pl-1.75",
                  colStyle.badgeBg,
                )}
              >
                <div className="flex h-5 items-center overflow-hidden">
                  <svg width="13" height="8" viewBox="0 0 13 8" fill="none" className="shrink-0">
                    <rect width="8" height="8" rx="4" fill={colStyle.accentColor} />
                  </svg>
                  <span className={cn("text-sm/5 font-normal", colStyle.badgeText)}>
                    {currentColumnName}
                  </span>
                </div>
              </div>
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {KANBAN_STATUS_OPTIONS.map((option) => {
                const statusStyle = columnStyles[option.id];
                return (
                  <SelectItem key={option.id} value={option.id}>
                    <div
                      className={cn(
                        "inline-flex h-5 items-center rounded-lg pr-2 pl-1.75",
                        statusStyle?.badgeBg ?? "bg-(--gray-bg)",
                      )}
                    >
                      <div className="flex h-5 items-center">
                        <svg width="13" height="8" viewBox="0 0 13 8" fill="none" className="shrink-0">
                          <rect width="8" height="8" rx="4" fill={statusStyle?.accentColor ?? "#8E8B86"} />
                        </svg>
                        <span
                          className={cn(
                            "text-sm/5 font-normal",
                            statusStyle?.badgeText ?? "text-(--foreground-secondary)",
                          )}
                        >
                          {option.name}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="flex h-7.5 items-center px-1.5">
          <Select value={estimate} onValueChange={onEstimateChange}>
            <SelectTrigger
              className={cn(
                cardStagePropertyTriggerChrome,
                cardStagePropertyValueHoverSurface,
                "gap-1 px-0",
                estimate === "none" && "text-(--foreground-tertiary) hover:text-(--foreground-secondary)",
              )}
            >
              {estimate !== "none" && estimate in estimateStyles ? (
                <span
                  className={cn(
                    "inline-flex h-5 items-center rounded-sm px-1.5 text-sm/5",
                    estimateStyles[estimate as Estimate].className,
                  )}
                >
                  {estimateStyles[estimate as Estimate].label}
                </span>
              ) : (
                <span className={cardStagePropertyEmptyValue}>Empty</span>
              )}
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {estimateOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.value !== "none" ? (
                    <span className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-sm", estimateStyles[option.value].className)}>
                      {option.label}
                    </span>
                  ) : option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex h-7.5 items-center px-1.5">
          {dueDate ? (
            <div className="flex w-full items-center gap-1">
              <Input
                type="date"
                value={dueDate}
                onChange={(event) => onDueDateChange(event.target.value)}
                className={cn(
                  cardStagePropertyInputChrome,
                  cardStagePropertyTextSize,
                  cardStagePropertyValueHoverSurface,
                  "h-auto w-full px-0 text-(--foreground)",
                )}
              />
              <button
                type="button"
                onClick={onClearDueDate}
                className="shrink-0 text-(--foreground-disabled) transition-colors hover:text-(--foreground-secondary)"
                aria-label="Clear due date"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSetDueDateToday}
              className={cardStagePropertyEmptyValueInteractive}
            >
              Empty
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
