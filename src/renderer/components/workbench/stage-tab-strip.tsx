import { Plus, X } from "lucide-react";
import { cn } from "../../lib/utils";

export interface StageTabItem {
  id: string;
  label: string;
  muted?: boolean;
  closable?: boolean;
  running?: boolean;
  title?: string;
}

interface StageTabStripProps {
  tabs: StageTabItem[];
  activeTabId: string;
  showActiveUnderline?: boolean;
  onSelect: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onAddTab?: () => void;
  addLabel?: string;
  className?: string;
}

export function StageTabStrip({
  tabs,
  activeTabId,
  showActiveUnderline = true,
  onSelect,
  onCloseTab,
  onAddTab,
  addLabel = "Add tab",
  className,
}: StageTabStripProps) {
  return (
    <div className={cn("flex h-7 min-w-0 items-center", className)}>
      <div className="hide-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              title={tab.title ?? tab.label}
              className={cn(
                "group relative h-6 max-w-55 shrink-0 px-2.5 text-sm font-medium",
                "inline-flex items-center gap-1.5 rounded-md transition-all duration-150",
                isActive
                  ? "bg-(--background-secondary) text-(--foreground)"
                  : "text-(--foreground-tertiary) hover:bg-(--background-tertiary)/50 hover:text-(--foreground-secondary)",
              )}
            >
              {tab.running && (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--accent-blue)"
                />
              )}
              <span className={cn("truncate", tab.muted && "opacity-60")}>{tab.label}</span>
              {tab.closable && onCloseTab && (
                <span
                  role="button"
                  tabIndex={-1}
                  className={cn(
                    "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm",
                    "opacity-0 group-hover:opacity-100",
                    "text-(--foreground-tertiary) hover:bg-(--background-tertiary) hover:text-(--foreground)",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <X className="size-2.5" />
                </span>
              )}
              {isActive && showActiveUnderline && (
                <span
                  aria-hidden
                  className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-(--accent-blue)"
                />
              )}
            </button>
          );
        })}
      </div>

      {onAddTab && (
        <button
          onClick={onAddTab}
          title={addLabel}
          className={cn(
            "ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            "text-(--foreground-tertiary) hover:bg-(--background-tertiary)/50 hover:text-(--foreground-secondary)",
          )}
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );
}
