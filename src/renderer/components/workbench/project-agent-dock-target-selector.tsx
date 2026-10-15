import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/shared/icons";
import { NodexDropdownButtonTrigger } from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  resolveProjectAgentDockLiveIndicator,
  type ProjectAgentDockChatIndicator,
  type ProjectAgentDockModel,
  type ProjectAgentDockTargetRow,
} from "@/lib/project-agent-dock-model";
import {
  useAgentRuntimeSessionActivity,
  type AgentRuntimeActivityStore,
} from "@/lib/agent-runtime-session-activity";
import {
  runtimeSessionLiveIndicator,
  SESSION_LIVE_INDICATOR_LABELS,
} from "@/lib/session-execution";
import { cn } from "@/lib/utils";

export interface ProjectAgentDockTargetSelectorProps {
  readonly model: ProjectAgentDockModel;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (row: ProjectAgentDockTargetRow) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  /** Live Session activity; tests inject an isolated store. */
  readonly activityStore?: AgentRuntimeActivityStore;
}

function indicatorLabel(indicator: ProjectAgentDockChatIndicator): string | null {
  if (indicator === "running") return SESSION_LIVE_INDICATOR_LABELS.running;
  if (indicator === "background") return SESSION_LIVE_INDICATOR_LABELS.background;
  if (indicator === "unread") return "Unread";
  if (indicator === "needs-attention") return "Needs attention";
  return null;
}

/** Each row subscribes only to its own Session's activity. */
function useLiveIndicator(
  row: ProjectAgentDockTargetRow,
  store: AgentRuntimeActivityStore | undefined,
): ProjectAgentDockChatIndicator {
  const activity = useAgentRuntimeSessionActivity(row.runtimeSessionId, store);
  return resolveProjectAgentDockLiveIndicator(row, runtimeSessionLiveIndicator(activity));
}

function targetRowAccessibleLabel(
  row: ProjectAgentDockTargetRow,
  indicator: ProjectAgentDockChatIndicator,
): string {
  const status = row.kind === "session" ? indicatorLabel(indicator) : null;
  return [status, row.label, row.preview]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

function ProjectAgentDockChatIndicatorView({
  indicator,
}: {
  readonly indicator: ProjectAgentDockChatIndicator;
}) {
  const label = indicatorLabel(indicator);

  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center"
      data-project-agent-dock-chat-indicator={indicator}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
    >
      {indicator === "running" || indicator === "background" ? (
        <ActivitySpinnerIcon
          className={cn(
            "icon-2xs shrink-0",
            indicator === "background" && "text-token-description-foreground opacity-70",
          )}
          animationDurationMs={indicator === "background" ? 5_000 : 2_000}
        />
      ) : (
        <span
          className={cn(
            "size-1.5 rounded-full",
            indicator === "unread" || indicator === "needs-attention"
              ? "bg-token-charts-blue"
              : "bg-current text-token-description-foreground",
          )}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function ProjectAgentDockTargetOption({
  row,
  optionId,
  active,
  activityStore,
  onActivate,
  onAccept,
}: {
  readonly row: ProjectAgentDockTargetRow;
  readonly optionId: string;
  readonly active: boolean;
  readonly activityStore: AgentRuntimeActivityStore | undefined;
  readonly onActivate: () => void;
  readonly onAccept: () => void;
}) {
  const indicator = useLiveIndicator(row, activityStore);
  return (
    <button
      id={optionId}
      type="button"
      role="option"
      aria-label={targetRowAccessibleLabel(row, indicator)}
      aria-selected={row.selected}
      className={cn(
        "flex min-h-8 w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-1 text-left",
        active && "bg-token-foreground/5",
      )}
      onPointerMove={onActivate}
      onClick={onAccept}
    >
      {row.kind === "new" ? (
        <PlusIcon
          className="size-3.5 shrink-0 text-token-description-foreground"
          aria-hidden="true"
        />
      ) : (
        <ProjectAgentDockChatIndicatorView indicator={indicator} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center">
          <span className="min-w-0 flex-1 truncate text-sm text-token-foreground">{row.label}</span>
        </span>
        {row.preview ? (
          <span className="block truncate text-xs text-token-description-foreground">
            {row.preview}
          </span>
        ) : null}
      </span>
      <CheckmarkIcon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", row.selected ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

export function ProjectAgentDockTargetSelector({
  model,
  query,
  onQueryChange,
  onSelect,
  onLoadMore,
  onRetry,
  activityStore,
}: ProjectAgentDockTargetSelectorProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const activeRow = model.rows[activeIndex] ?? model.rows[0] ?? null;
  const activeDescendantId = activeRow ? `${listboxId}-option-${activeIndex}` : undefined;
  const triggerIndicator = useLiveIndicator(model.trigger, activityStore);
  const triggerIndicatorLabel =
    model.trigger.kind === "session" ? indicatorLabel(triggerIndicator) : null;

  useEffect(() => {
    if (!open) return;
    const selectedIndex = model.rows.findIndex((row) => row.selected);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [model.rows, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const accept = (row: ProjectAgentDockTargetRow | null) => {
    if (!row) return;
    onSelect(row);
    onQueryChange("");
    closeAndRestoreFocus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        if (model.rows.length === 0) return 0;
        return (current + delta + model.rows.length) % model.rows.length;
      });
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : Math.max(0, model.rows.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      accept(activeRow);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    }
  };

  return (
    <NodexPopover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) onQueryChange("");
      }}
    >
      <NodexPopoverTrigger>
        <NodexDropdownButtonTrigger
          ref={triggerRef}
          aria-label={`Connected chat: ${model.trigger.label}${
            triggerIndicatorLabel ? `, ${triggerIndicatorLabel}` : ""
          }`}
          size="sm"
          shape="pill"
          chrome="transparent"
          muted
          className="group/agent-target max-w-72 px-1.5 text-token-text-tertiary hover:text-token-foreground"
        >
          {model.trigger.kind === "new" ? (
            <PlusIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-token-description-foreground"
            />
          ) : (
            <ProjectAgentDockChatIndicatorView indicator={triggerIndicator} />
          )}
          <span className="min-w-0 truncate font-normal">{model.trigger.label}</span>
        </NodexDropdownButtonTrigger>
      </NodexPopoverTrigger>
      <NodexPopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-[320px] max-w-[calc(100vw-24px)] overflow-hidden p-1"
        initialFocus={false}
        finalFocus={false}
      >
        <div className="flex h-8 items-center gap-1.5 px-1.5">
          <SearchIcon
            className="size-3.5 shrink-0 text-token-description-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Choose connected chat"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeDescendantId}
            value={query}
            placeholder="Find a chat"
            className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm text-token-foreground outline-none placeholder:text-token-description-foreground"
            onChange={(event) => {
              onQueryChange(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label="Project chats"
          className="notion-scroller vertical max-h-72 overflow-y-auto py-0.5"
        >
          {model.rows.map((row, index) => (
            <ProjectAgentDockTargetOption
              key={row.id}
              row={row}
              optionId={`${listboxId}-option-${index}`}
              active={index === activeIndex}
              activityStore={activityStore}
              onActivate={() => setActiveIndex(index)}
              onAccept={() => accept(row)}
            />
          ))}
          {model.collectionMessage ? (
            <div className="flex min-h-8 items-center justify-between gap-2 px-2 text-xs text-token-description-foreground">
              <span className="truncate">{model.collectionMessage}</span>
              {model.collectionMessage !== "Loading chats…" ? (
                <button
                  type="button"
                  className="shrink-0 cursor-interaction rounded-md px-1.5 py-1 text-token-foreground hover:bg-token-foreground/5"
                  onClick={onRetry}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {model.hasMore ? (
            <button
              type="button"
              className="flex h-8 w-full cursor-interaction items-center rounded-lg px-2 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
              onClick={onLoadMore}
            >
              Load more
            </button>
          ) : null}
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
