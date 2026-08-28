import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ActivitySpinnerIcon, ExpandPanelIcon, RestorePanelIcon } from "@/components/shared/icons";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { CodexTranscriptEntry } from "../../../../lib/types";
import { cn } from "../../../../lib/utils";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";
import { useMeasuredElementHeight } from "./use-measured-element-height";

export interface TodoListSurfaceProps {
  item: Pick<CodexTranscriptEntry, "markdownText" | "rawItem"> & {
    status?: CodexTranscriptEntry["status"];
  };
}

type TodoStepStatus = "pending" | "in_progress" | "completed";

interface TodoStep {
  step: string;
  status: TodoStepStatus;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeRawTodoSteps(rawItem: unknown): TodoStep[] {
  const rawRecord = asRecord(rawItem);
  const rawPlan = rawRecord?.plan;
  if (!Array.isArray(rawPlan)) return [];

  return rawPlan.reduce<TodoStep[]>((acc, entry) => {
    const candidate = asRecord(entry);
    const step = typeof candidate?.step === "string" ? candidate.step.trim() : "";
    const status = candidate?.status;
    if (step.length === 0) return acc;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return acc;
    acc.push({ step, status });
    return acc;
  }, []);
}

function parseMarkdownTodoSteps(markdownText: string): TodoStep[] {
  const lines = markdownText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines
    .reduce<TodoStep[]>((acc, line) => {
      const checkboxMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (checkboxMatch) {
        acc.push({
          step: checkboxMatch[2]?.trim() ?? "",
          status: checkboxMatch[1]?.toLowerCase() === "x" ? "completed" : "pending",
        });
        return acc;
      }

      const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
      if (orderedMatch) {
        acc.push({
          step: orderedMatch[1]?.trim() ?? "",
          status: "pending",
        });
      }
      return acc;
    }, [])
    .filter((entry) => entry.step.length > 0);
}

export function parseTodoSteps(
  item: Pick<CodexTranscriptEntry, "markdownText" | "rawItem"> & {
    status?: CodexTranscriptEntry["status"];
  },
): TodoStep[] {
  const rawSteps = normalizeRawTodoSteps(item.rawItem);
  const parsedSteps =
    rawSteps.length > 0 ? rawSteps : parseMarkdownTodoSteps(item.markdownText ?? "");
  if (parsedSteps.length === 0) return [];
  if (parsedSteps.some((step) => step.status === "in_progress")) return parsedSteps;
  if (item.status !== "inProgress") return parsedSteps;

  const nextSteps = [...parsedSteps];
  const firstPendingIndex = nextSteps.findIndex((step) => step.status === "pending");
  if (firstPendingIndex >= 0) {
    nextSteps[firstPendingIndex] = {
      ...nextSteps[firstPendingIndex]!,
      status: "in_progress",
    };
  }
  return nextSteps;
}

function TodoStatusIcon({ status }: { status: TodoStepStatus }) {
  if (status === "completed") {
    return (
      <div className="flex h-3.5 w-4.5 items-center justify-center overflow-hidden">
        <svg
          viewBox="0 0 16 16"
          className="icon-3xs shrink-0 text-token-foreground"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12.14 4.14L6.39 11.5L3.86 8.97"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }

  if (status === "in_progress") {
    return (
      <div className="flex h-3.5 w-4.5 items-center justify-center overflow-hidden">
        <ActivitySpinnerIcon className="size-[9px] text-token-foreground/60" />
      </div>
    );
  }

  return (
    <div className="flex h-3.5 w-4.5 items-center justify-center overflow-hidden">
      <div className="h-[8px] w-[8px] rounded-full border border-token-foreground/35" />
    </div>
  );
}

function countCompletedSteps(steps: TodoStep[]): number {
  return steps.reduce((count, step) => count + (step.status === "completed" ? 1 : 0), 0);
}

function resolveActiveStepIndex(steps: TodoStep[], completedCount: number): number {
  const explicitIndex = steps.findIndex((step) => step.status === "in_progress");
  if (explicitIndex >= 0) return explicitIndex;
  if (steps.length === 0) return -1;
  if (completedCount === steps.length) return steps.length - 1;

  const firstIncompleteIndex = steps.findIndex((step) => step.status !== "completed");
  return firstIncompleteIndex >= 0 ? firstIncompleteIndex : steps.length - 1;
}

function TodoListCompactTooltip({ steps }: { steps: TodoStep[] }) {
  return (
    <div className="flex max-h-[min(var(--nodex-floating-surface-available-height),calc(100vh-16px))] min-h-0 max-w-80 flex-1 flex-col overflow-hidden rounded-xl">
      <div className="vertical-scroll-fade-mask flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2 [--edge-fade-distance:1rem]">
        {steps.map((step, index) => (
          <div key={`${index}:${step.step}`} className="flex max-w-80 min-w-0 items-start gap-2">
            <TodoStatusIcon status={step.status} />
            <span
              className={cn(
                "text-size-chat max-w-72 min-w-0 break-words leading-4",
                step.status === "completed"
                  ? "text-token-text-tertiary"
                  : "text-token-text-secondary",
              )}
            >
              {step.step}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TodoProgressDonut({ percent }: { percent: number }) {
  const reducedMotion = useResolvedReducedMotion();
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const strokeDashoffset = 100 - clampedPercent;

  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className="shrink-0 text-token-charts-blue"
    >
      <circle
        cx="6"
        cy="6"
        r="5"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.16"
      />
      <motion.circle
        cx="6"
        cy="6"
        r="5"
        stroke="currentColor"
        strokeWidth="2"
        opacity={clampedPercent === 0 ? 0 : 1}
        strokeLinecap="round"
        fill="none"
        pathLength="100"
        strokeDasharray="100"
        initial={reducedMotion ? false : { strokeDashoffset: 100 }}
        animate={{ strokeDashoffset }}
        transition={
          reducedMotion ? { duration: 0 } : { delay: 0.15, duration: 0.3, ease: "easeOut" }
        }
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}

export function TodoListCompactPillContent({ item }: TodoListSurfaceProps) {
  const steps = useMemo(() => parseTodoSteps(item), [item]);
  const completedCount = useMemo(() => countCompletedSteps(steps), [steps]);
  const activeStepIndex = useMemo(
    () => resolveActiveStepIndex(steps, completedCount),
    [completedCount, steps],
  );
  if (steps.length === 0 || activeStepIndex < 0) return null;

  const stepNumber = activeStepIndex + 1;
  const progressPercent = (completedCount / steps.length) * 100;

  return (
    <NodexTooltip
      delay={0}
      hoverable
      surface="rich"
      side="top"
      sideOffset={8}
      tooltipContent={<TodoListCompactTooltip steps={steps} />}
      style={{
        maxWidth: "min(24rem, var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
      }}
    >
      <span className="inline-flex max-w-full min-w-0 cursor-interaction hover:text-token-foreground">
        <span className="text-size-chat flex max-w-full min-w-0 items-center gap-1.5 text-token-text-secondary">
          <TodoProgressDonut percent={progressPercent} />
          <span className="whitespace-nowrap tabular-nums">
            Step {stepNumber} / {steps.length}
          </span>
        </span>
      </span>
    </NodexTooltip>
  );
}

export function TodoListSurface({ item }: TodoListSurfaceProps) {
  const steps = useMemo(() => parseTodoSteps(item), [item]);
  const completedCount = useMemo(() => countCompletedSteps(steps), [steps]);
  const totalCount = steps.length;
  const activeStepIndex = useMemo(
    () => resolveActiveStepIndex(steps, completedCount),
    [completedCount, steps],
  );
  const [expanded, setExpanded] = useState(true);
  const activeStepRef = useRef<HTMLDivElement | null>(null);
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();

  useEffect(() => {
    const activeElement = activeStepRef.current;
    if (!activeElement || activeStepIndex < 0) return;
    activeElement.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [activeStepIndex]);

  const summaryLabel = `${completedCount} out of ${totalCount === 1 ? "1 task completed" : `${totalCount} tasks completed`}`;

  return (
    <div className="bg-token-input-background/70 text-token-foreground border-token-border/80 relative overflow-clip border-x border-t backdrop-blur-sm transition-colors first:rounded-t-2xl cursor-interaction">
      <div className="flex flex-col">
        <div className="flex w-full items-center justify-between gap-1.5 py-1.5 pr-2 pl-3 text-sm font-normal">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <div className="flex min-w-0 items-center">
              <div className="text-size-chat flex min-w-0 items-center gap-1">
                {item.status !== "completed" ? (
                  <div className="flex items-center justify-center text-token-input-placeholder-foreground opacity-60">
                    <svg
                      viewBox="0 0 16 16"
                      className="icon-xs text-token-foreground"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M8 2.5v3m0 5v3m5.5-5.5h-3m-5 0h-3"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                ) : null}
                <span className="min-w-0 truncate text-token-input-placeholder-foreground">
                  {summaryLabel}
                </span>
              </div>
            </div>
          </div>
          <div className="flex min-w-fit shrink-0 items-center gap-1.5 select-none sm:ml-auto">
            <button
              type="button"
              aria-label={expanded ? "Collapse todo list" : "Expand todo list"}
              className="text-token-input-placeholder-foreground hover:bg-transparent hover:text-token-foreground focus-visible:outline-none"
              onClick={() => {
                setExpanded((current) => !current);
              }}
            >
              {expanded ? (
                <RestorePanelIcon className="icon-2xs" />
              ) : (
                <ExpandPanelIcon className="icon-2xs" />
              )}
            </button>
          </div>
        </div>

        <motion.div
          initial={false}
          animate={{
            height: expanded ? elementHeightPx : 0,
            opacity: expanded ? 1 : 0,
          }}
          transition={CODEX_THREAD_ACCORDION_TRANSITION}
          className={cn(expanded ? "overflow-visible" : "overflow-hidden")}
          data-thread-find-skip={expanded ? undefined : true}
          style={{
            pointerEvents: expanded ? "auto" : "none",
          }}
        >
          <div ref={elementRef}>
            <div className="flex flex-col gap-2 bg-token-input-background/70 p-2 backdrop-blur-sm">
              <div className="vertical-scroll-fade-mask max-h-40 space-y-2 overflow-y-auto [--edge-fade-distance:2rem]">
                {steps.map((step, index) => (
                  <div
                    key={`${index}:${step.step}`}
                    ref={index === activeStepIndex ? activeStepRef : null}
                    className="flex items-start gap-2"
                  >
                    <div className="flex flex-shrink-0 items-start gap-0.5">
                      <TodoStatusIcon status={step.status} />
                      <span className="text-size-chat leading-4">{index + 1}.</span>
                    </div>
                    <span
                      className={cn(
                        "text-size-chat flex-1 leading-4",
                        step.status === "completed" && "line-through",
                      )}
                    >
                      {step.step}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
