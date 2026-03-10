import { useForm, useStore } from "@tanstack/react-form";
import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { handleFormSubmit } from "@/lib/forms";
import { KANBAN_PRIORITY_OPTIONS, resolveKanbanPriorityOption } from "../../lib/kanban-options";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { estimateStyles, estimateOptions } from "@/lib/types";
import type { CardInput, Priority, Estimate } from "@/lib/types";
import { cn } from "@/lib/utils";

interface InlineCardCreatorProps {
  onSave: (input: CardInput) => Promise<void>;
  onCancel: () => void;
}

function isElementTarget(target: EventTarget | null): target is Element {
  return target instanceof Element;
}

export function InlineCardCreator({ onSave, onCancel }: InlineCardCreatorProps) {
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLFormElement>(null);
  const form = useForm({
    defaultValues: {
      title: "",
      priority: null as Priority | null,
      estimate: null as Estimate | null,
      agentStatus: null as string | null,
    },
    onSubmit: async ({ value, formApi }) => {
      if (!value.title.trim() || saving) return;

      setSaving(true);
      try {
        await onSave({
          title: value.title.trim(),
          description: "",
          priority: value.priority || "p2-medium",
          estimate: value.estimate || undefined,
          tags: [],
          agentStatus: value.agentStatus || undefined,
          agentBlocked: false,
        });
        formApi.reset();
        inputRef.current?.focus();
      } finally {
        setSaving(false);
      }
    },
  });
  const formValues = useStore(form.store, (state) => state.values);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Handle click outside to cancel (if empty) or save (if has title)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isElementTarget(e.target) && e.target.closest('[data-slot="select-content"]')) {
        return;
      }

      if (!containerRef.current || !(e.target instanceof Node)) {
        return;
      }

      if (containerRef.current.contains(e.target)) {
        return;
      }

      if (formValues.title.trim()) {
        void form.handleSubmit();
        return;
      }

      onCancel();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [form, formValues.title, onCancel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && formValues.title.trim()) {
      e.preventDefault();
      void form.handleSubmit();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <form
      ref={containerRef}
      className={cn(
        // Match card styling exactly - Notion: border-radius:10px
        "rounded-lg bg-(--card)",
        // Shadow - Notion exact from Chrome DevTools
        "shadow-[0_4px_12px_rgba(25,25,25,0.027),0_1px_2px_rgba(25,25,25,0.02),0_0_0_1px_rgba(42,28,0,0.07)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.1),0_0_0_1px_rgba(255,255,255,0.07)]",
        // Ring to indicate editing state
        "ring-2 ring-(--ring)"
      )}
      onSubmit={(event) => handleFormSubmit(event, form.handleSubmit)}
    >
      {/* Title input area - match card: padding-inline:10px, padding-top:8px, padding-bottom:6px */}
      <div className="px-2.5 pt-2 pb-1">
        <Input
          ref={inputRef}
          value={formValues.title}
          onChange={(event) => form.setFieldValue("title", event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a name..."
          className={cn(
            "h-auto border-none px-0 shadow-none",
            // Match card title: font-size:15px, line-height:1.5, font-weight:500
            "text-sm/normal font-medium text-(--foreground)",
            "bg-transparent focus-visible:ring-0",
            "placeholder:font-normal placeholder:text-(--foreground-disabled)"
          )}
        />
      </div>

      {/* Property buttons - match card badges area: margin-inline:6px, padding-bottom:8px */}
      <div className="mx-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-1 text-xs text-(--foreground-secondary)">
        {/* Priority */}
        {formValues.priority ? (
          <PriorityBadge priority={formValues.priority} onClear={() => form.setFieldValue("priority", null)} />
        ) : (
          <Select onValueChange={(value) => form.setFieldValue("priority", value as Priority)}>
            <SelectTrigger
              className={cn(
                "h-6 w-auto gap-1 border-none px-1 py-1 shadow-none",
                "hover:bg-(--background-tertiary)"
              )}
            >
              <svg className="h-2 w-2" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 5v3M8 10v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Priority</span>
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {KANBAN_PRIORITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Estimate */}
        {formValues.estimate ? (
          <EstimateBadge estimate={formValues.estimate} onClear={() => form.setFieldValue("estimate", null)} />
        ) : (
          <Select onValueChange={(value) => form.setFieldValue("estimate", value as Estimate)}>
            <SelectTrigger
              className={cn(
                "h-6 w-auto gap-1 border-none px-1 py-1 shadow-none",
                "hover:bg-(--background-tertiary)"
              )}
            >
              <svg className="h-2 w-2" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Estimate</span>
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {estimateOptions.filter((opt) => opt.value !== "none").map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-sm", estimateStyles[opt.value as Estimate].className)}>
                    {opt.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Agent Status */}
        {formValues.agentStatus ? (
          <button
            type="button"
            onClick={() => form.setFieldValue("agentStatus", null)}
            className={cn(
              "flex items-center gap-1 px-2 py-1",
              "bg-(--blue-bg) text-(--blue-text)",
              "rounded-xs hover:opacity-80"
            )}
          >
            <span className="font-mono text-xs">{formValues.agentStatus}</span>
            <span>×</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              const status = prompt("Agent status:");
              if (status) form.setFieldValue("agentStatus", status);
            }}
            className={cn(
              "flex h-7 items-center gap-1 px-2",
              "hover:bg-(--background-tertiary)",
              "rounded-xs"
            )}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
              <path d="M3 5h10M3 8h10M3 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>Status</span>
          </button>
        )}
      </div>
    </form>
  );
}

function PriorityBadge({ priority, onClear }: { priority: Priority; onClear: () => void }) {
  const priorityOption = resolveKanbanPriorityOption(priority);
  const priorityLabel = priorityOption.label.split(" - ")[0] ?? priorityOption.label;
  return (
    <button
      onClick={onClear}
      className={cn(
        // Match card badge: height:18px, border-radius:3px, padding-inline:6px, line-height:120%, font-size:12px
        "inline-flex h-4.5 items-center gap-1 rounded-sm px-1.5 text-sm/snug-plus",
        priorityOption.className,
        "hover:opacity-80"
      )}
    >
      {priorityLabel} <span>×</span>
    </button>
  );
}

function EstimateBadge({ estimate, onClear }: { estimate: Estimate; onClear: () => void }) {
  const style = estimateStyles[estimate];
  return (
    <button
      onClick={onClear}
      className={cn(
        "inline-flex h-4.5 items-center gap-1 rounded-sm px-1.5 text-sm/snug-plus",
        style.className,
        "hover:opacity-80"
      )}
    >
      {style.label} <span>×</span>
    </button>
  );
}
