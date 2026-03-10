import { useForm, useStore } from "@tanstack/react-form";
import { useRef, useEffect } from "react";
import { slotToTime, formatTimeRange } from "@/lib/calendar-utils";
import { handleFormSubmit } from "@/lib/forms";

interface CalendarInlineCreatorProps {
  dayDate: Date;
  startSlot: number;
  endSlot: number;
  hourHeight: number;
  onCommit: (title: string, start: Date, end: Date) => void;
  onCancel: () => void;
}

export function CalendarInlineCreator({
  dayDate,
  startSlot,
  endSlot,
  hourHeight,
  onCommit,
  onCancel,
}: CalendarInlineCreatorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const form = useForm({
    defaultValues: {
      title: "",
    },
    onSubmit: ({ value, formApi }) => {
      const title = value.title.trim();
      if (!title) return;
      onCommit(title, start, end);
      formApi.reset();
    },
  });
  const title = useStore(form.store, (state) => state.values.title);

  const minSlot = Math.min(startSlot, endSlot);
  const maxSlot = Math.max(startSlot, endSlot);

  const startTime = slotToTime(minSlot);
  const endTime = slotToTime(maxSlot + 1);

  const slotHeight = hourHeight / 4;
  const top = minSlot * slotHeight;
  const height = (maxSlot - minSlot + 1) * slotHeight;

  const start = new Date(dayDate);
  start.setHours(startTime.hour, startTime.minute, 0, 0);
  const end = new Date(dayDate);
  end.setHours(endTime.hour, endTime.minute, 0, 0);

  useEffect(() => {
    // Focus on next frame to avoid pointer event conflicts
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && title.trim()) {
      e.preventDefault();
      void form.handleSubmit();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <form
      className="absolute inset-x-1 z-20 overflow-hidden rounded-sm border-l-[calc(var(--spacing)*0.75)] border-l-(--accent-blue)"
      style={{
        top,
        height: Math.max(height, 30),
        backgroundColor: "color-mix(in srgb, var(--accent-blue) 14%, var(--background))",
      }}
      onSubmit={(event) => handleFormSubmit(event, form.handleSubmit)}
    >
      <div className="flex flex-col gap-0.5 px-1.5 py-1">
        <input
          ref={inputRef}
          value={title}
          onChange={(event) => form.setFieldValue("title", event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (title.trim()) {
              void form.handleSubmit();
            } else {
              onCancel();
            }
          }}
          placeholder="New task..."
          className="w-full bg-transparent text-xs font-medium text-(--accent-blue) outline-none placeholder:text-(--accent-blue)/50"
        />
        <span className="text-xs/tight text-(--foreground-tertiary)">
          {formatTimeRange(start, end)}
        </span>
      </div>
    </form>
  );
}
