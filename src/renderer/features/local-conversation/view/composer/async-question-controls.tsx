import { useEffect, useState } from "react";
import { motion, type Variants } from "motion/react";
import { ActivitySpinnerIcon, BackIcon, EditIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AsyncQuestionChoiceMarker({
  index,
  activating = false,
}: {
  index?: number;
  activating?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-token-button-composer shrink-0 items-center justify-center rounded-full border text-xs leading-none font-medium",
        activating
          ? "border-text bg-token-foreground text-token-dropdown-background"
          : "border-default bg-text/5 text-token-description-foreground",
      )}
    >
      {index === undefined ? (
        <EditIcon className="icon-2xs" />
      ) : activating ? (
        <span className="size-1.5 rounded-full bg-current" />
      ) : (
        index + 1
      )}
    </span>
  );
}

export function AsyncQuestionChoices({
  title,
  options,
  selected,
  hovered,
  activating,
  disabled,
  variants,
  onHover,
  onChoose,
}: {
  title: string;
  options: readonly string[];
  selected: number;
  hovered: number | null | undefined;
  activating: number | null;
  disabled: boolean;
  variants?: Variants;
  onHover: (index: number) => void;
  onChoose: (index: number) => void;
}) {
  if (!options.length) return null;
  return (
    <div role="radiogroup" aria-label={title} className="flex flex-col gap-1">
      {options.map((option, index) => {
        const highlighted =
          activating !== null
            ? activating === index
            : hovered !== undefined
              ? hovered === index
              : selected === index;
        const recommended = option.endsWith(" (Recommended)");
        return (
          <motion.div key={index} variants={variants}>
            <button
              type="button"
              role="radio"
              aria-label={option}
              aria-checked={selected === index}
              disabled={disabled}
              onPointerEnter={() => onHover(index)}
              onClick={() => onChoose(index)}
              className={cn(
                "group flex min-h-8 w-full cursor-interaction items-center gap-2 rounded-xl px-2 py-1.5 text-start text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus disabled:cursor-default disabled:opacity-40",
                highlighted ? "bg-text/5" : "hover:bg-text/5",
              )}
            >
              <AsyncQuestionChoiceMarker index={index} activating={activating === index} />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 text-sm font-medium wrap-anywhere">
                    {recommended ? option.slice(0, -14) : option}
                  </span>
                  {recommended ? (
                    <span className="shrink-0 rounded-full border border-default px-1.5 py-0.5 text-xs text-token-description-foreground">
                      Recommended
                    </span>
                  ) : null}
                </span>
              </span>
              <BackIcon
                aria-hidden="true"
                className={cn(
                  "icon-xs ms-auto rotate-180 text-token-description-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                  highlighted && "opacity-100",
                )}
              />
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}

/** The deadline remains owned by the question runtime; this clock only renders its final seconds. */
function useVisibleCountdown(deadlineMs: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadlineMs === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [deadlineMs]);
  const seconds = deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - now) / 1_000));
  return seconds !== null && seconds <= 20 ? seconds : null;
}

export function AsyncQuestionActions({
  deadlineMs,
  submitting,
  canSend,
  label,
  onSkip,
  onSend,
}: {
  deadlineMs: number | null;
  submitting: boolean;
  canSend: boolean;
  label: string;
  onSkip: () => void;
  onSend: () => void;
}) {
  const seconds = useVisibleCountdown(deadlineMs);
  return (
    <div className="flex shrink-0 items-center gap-2 place-self-end">
      <NodexButton
        variant="outline"
        size="composer"
        data-async-question-dismiss="true"
        aria-label={
          seconds === null
            ? undefined
            : `Skip, ${seconds} ${seconds === 1 ? "second" : "seconds"} remaining`
        }
        disabled={submitting}
        onClick={onSkip}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
        className={cn(
          "gap-1 rounded-full border-default bg-token-bg-fog px-2 text-sm leading-[18px] font-medium enabled:hover:bg-text/5 disabled:opacity-40",
          seconds !== null &&
            "pe-[calc((var(--spacing-token-button-composer)-var(--spacing)*5)/2-1px)]",
        )}
      >
        Skip
        {seconds !== null ? (
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-full bg-text-info/10 px-1.5 text-xs leading-none font-medium text-info"
          >
            {seconds}s
          </span>
        ) : null}
      </NodexButton>
      <NodexButton
        variant="primary"
        size="composer"
        disabled={!canSend || submitting}
        onClick={onSend}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
        className="gap-1 rounded-full border border-default px-2 text-sm leading-[18px] font-medium text-token-dropdown-background enabled:hover:bg-text/80 disabled:opacity-40"
      >
        {submitting ? <ActivitySpinnerIcon className="icon-xxs" /> : null}
        {label}
      </NodexButton>
    </div>
  );
}
