import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { ProviderKind } from "../demos/lumen";
import { cx } from "./Window";
import {
  PlusIcon,
  PriorityValueIcon,
  SpinnerIcon,
  ThreadIcon,
  WorkflowBuildIcon,
  WorkflowPlanIcon,
  WorkflowReviewIcon,
  WorkflowShipIcon,
  WorkflowTriageIcon,
  type ReplicaPriority,
} from "./icons";

export const STATUSES = ["Triage", "Plan", "Build", "Review", "Ship"] as const;
export type Status = (typeof STATUSES)[number];

const STATUS_GLYPH = {
  Triage: WorkflowTriageIcon,
  Plan: WorkflowPlanIcon,
  Build: WorkflowBuildIcon,
  Review: WorkflowReviewIcon,
  Ship: WorkflowShipIcon,
};

// status-presentation.tsx / theme-source.css: dots stay constant; column surfaces follow theme.
const STATUS_ACCENT: Record<Status, string> = {
  Triage: "#8e8b86",
  Plan: "#8e8b86",
  Build: "#2783de",
  Review: "#bc4c00",
  Ship: "#46a171",
};
const STATUS_COLUMN: Record<Status, string> = {
  Triage: "bg-[rgba(42,28,0,0.03)] dark:bg-white/3",
  Plan: "bg-[rgba(28,19,1,0.04)] dark:bg-white/4",
  Build: "bg-[rgba(0,118,217,0.04)] dark:bg-[rgba(94,159,232,0.06)]",
  Review: "bg-[rgba(127,51,0,0.04)] dark:bg-[rgba(222,146,85,0.06)]",
  Ship: "bg-[rgba(0,96,38,0.04)] dark:bg-[rgba(114,188,143,0.06)]",
};

/** The workflow value glyph is distinct from the Status property's generic icon. */
export function StatusIcon({
  status,
  className = "size-3.5",
}: {
  readonly status: Status;
  readonly className?: string;
}) {
  const Glyph = STATUS_GLYPH[status];
  return <Glyph className={className} style={{ color: STATUS_ACCENT[status] }} />;
}

export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: Status;
  readonly priority?: ReplicaPriority;
  readonly chat?: { readonly provider: ProviderKind; readonly working: boolean };
}

export function BoardColumn({
  status,
  count,
  children,
}: {
  readonly status: Status;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex w-[226px] shrink-0 flex-col rounded-[10px] pb-1.5 [corner-shape:superellipse(1.5)]",
        STATUS_COLUMN[status],
      )}
    >
      <div className="flex h-[33px] items-center gap-[5px] px-[7px] text-[11px] font-normal">
        <StatusIcon status={status} className="size-[13px]" />
        <span>{status}</span>
        <span className="text-app-faint tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-[7px] px-[7px]">
        {children}
        <div
          className="flex h-[33px] items-center gap-2 rounded-[8px] border-[0.5px] px-2 text-[11.5px] [corner-shape:superellipse(1.5)]"
          style={{
            color: STATUS_ACCENT[status],
            borderColor: `color-mix(in srgb, ${STATUS_ACCENT[status]} 17%, transparent)`,
          }}
        >
          <PlusIcon className="size-[13px]" /> New page
        </div>
      </div>
    </div>
  );
}

export function BoardCardView({
  card,
  cursorTarget,
}: {
  readonly card: BoardCard;
  readonly cursorTarget?: string;
}) {
  return (
    <motion.div
      layoutId={card.id}
      layout
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      data-cursor-target={cursorTarget}
      className="min-w-0 overflow-hidden rounded-[10px] bg-white/96 dark:bg-[rgba(54,54,54,0.96)] [corner-shape:superellipse(1.5)]"
      style={{
        boxShadow: `0 3px 10px color-mix(in srgb, var(--app-fg) 5%, transparent), 0 1px 2px color-mix(in srgb, var(--app-fg) 4%, transparent), 0 0 0 0.8px color-mix(in srgb, ${STATUS_ACCENT[card.status]} 17%, transparent)`,
      }}
    >
      <div className="flex items-start gap-1 px-[7px] pt-[7px] pb-[3px]">
        <span className="min-w-0 flex-1 text-[11.5px] leading-[17px] font-medium">
          {card.title}
        </span>
        {card.chat ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-app-faint">
            {card.chat.working ? (
              <SpinnerIcon className="size-2.5" />
            ) : (
              <ThreadIcon className="size-2.5" />
            )}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 px-[7px] pb-[3px] text-[10px] leading-[15px] text-app-muted">
        {card.body}
      </p>
      <div className="px-[7px] pb-[7px]">
        <span className="flex size-5 items-center justify-center rounded-full border-[0.5px] border-app-line text-app-muted">
          <PriorityValueIcon priority={card.priority ?? "high"} className="size-3" />
        </span>
      </div>
    </motion.div>
  );
}
