import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useReplicaCopy } from "./copy";
import { PROVIDER_NAMES, type ProviderKind } from "../demos/lumen";
import { cx } from "./Window";
import {
  PlusIcon,
  PriorityValueIcon,
  SpinnerIcon,
  SuccessCircleIcon,
  ChatIcon,
  WorkflowDoingIcon,
  WorkflowPlanIcon,
  WorkflowReviewIcon,
  WorkflowDoneIcon,
  WorkflowTriageIcon,
  type ReplicaPriority,
} from "./icons";

export const STATUSES = ["Triage", "Plan", "Doing", "Review", "Done"] as const;
export type Status = (typeof STATUSES)[number];

const STATUS_GLYPH = {
  Triage: WorkflowTriageIcon,
  Plan: WorkflowPlanIcon,
  Doing: WorkflowDoingIcon,
  Review: WorkflowReviewIcon,
  Done: WorkflowDoneIcon,
};

// status-presentation.tsx / theme-source.css: dots stay constant; column surfaces follow theme.
const STATUS_ACCENT: Record<Status, string> = {
  Triage: "#8e8b86",
  Plan: "#8b6cd8",
  Doing: "#2783de",
  Review: "#bc4c00",
  Done: "#46a171",
};
const STATUS_COLUMN: Record<Status, string> = {
  Triage: "bg-[rgba(42,28,0,0.03)] dark:bg-white/3",
  Plan: "bg-[rgba(76,29,199,0.04)] dark:bg-[rgba(167,139,250,0.06)]",
  Doing: "bg-[rgba(0,118,217,0.04)] dark:bg-[rgba(94,159,232,0.06)]",
  Review: "bg-[rgba(127,51,0,0.04)] dark:bg-[rgba(222,146,85,0.06)]",
  Done: "bg-[rgba(0,96,38,0.04)] dark:bg-[rgba(114,188,143,0.06)]",
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
  readonly turn?: PageTurn;
  readonly chat?: { readonly provider: ProviderKind; readonly working: boolean };
}

/** Whose move a work Page is (page-turn-chip.tsx), worded for the reader. */
export type PageTurn =
  | { readonly kind: "working"; readonly provider: ProviderKind }
  | { readonly kind: "review" };

/** The Turn chip a card or row leads its footer with: a spinner while an Agent works. */
export function TurnChip({
  turn,
  className,
}: {
  readonly turn: PageTurn;
  readonly className?: string;
}) {
  const copy = useReplicaCopy();
  return (
    <span
      className={cx(
        "inline-flex min-w-0 items-center gap-[3.28px] truncate",
        turn.kind === "review" ? "text-[#e25507] dark:text-[#ff8549]" : "text-app-muted",
        className,
      )}
    >
      {turn.kind === "working" ? (
        <SpinnerIcon className="size-[11.48px]" />
      ) : (
        <SuccessCircleIcon className="size-[11.48px] shrink-0" />
      )}
      <span className="truncate">
        {turn.kind === "working"
          ? copy.isWorking(PROVIDER_NAMES[turn.provider])
          : copy.readyForYourReview}
      </span>
    </span>
  );
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
  const copy = useReplicaCopy();
  // An empty column folds to a strip with its name set on end, as the app draws it.
  if (count === 0)
    return (
      <div
        className={cx(
          "flex w-[33px] shrink-0 flex-col items-center gap-[6.56px] rounded-[10px] py-[9.84px] text-[11px] [corner-shape:superellipse(1.5)]",
          STATUS_COLUMN[status],
        )}
      >
        <StatusIcon status={status} className="size-[13px]" />
        <span className="[writing-mode:vertical-rl]" style={{ color: STATUS_ACCENT[status] }}>
          {copy.status[status]}
        </span>
        <span
          className="flex size-[16.4px] items-center justify-center rounded-full text-[9.84px] tabular-nums"
          style={{
            color: STATUS_ACCENT[status],
            background: `color-mix(in srgb, ${STATUS_ACCENT[status]} 12%, transparent)`,
          }}
        >
          0
        </span>
      </div>
    );
  return (
    <div
      className={cx(
        "flex w-[226px] shrink-0 flex-col rounded-[10px] pb-1.5 [corner-shape:superellipse(1.5)]",
        STATUS_COLUMN[status],
      )}
    >
      <div className="flex h-[33px] items-center gap-[5px] px-[7px] text-[11px] font-normal">
        <StatusIcon status={status} className="size-[13px]" />
        <span>{copy.status[status]}</span>
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
          <PlusIcon className="size-[13px]" /> {copy.newPage}
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
      className="min-w-0 overflow-hidden rounded-[10px] bg-white/96 dark:bg-[rgba(47,47,47,0.96)] [corner-shape:superellipse(1.5)]"
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
              <ChatIcon className="size-2.5" />
            )}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 px-[7px] pb-[3px] text-[10px] leading-[15px] text-app-muted">
        {card.body}
      </p>
      {card.turn || card.priority ? (
        <div className="flex min-w-0 flex-wrap items-center gap-[3.28px] px-[7px] pb-[7px] text-[9.84px] leading-[13.12px]">
          {card.turn ? <TurnChip turn={card.turn} className="h-[19.68px] px-[1.64px]" /> : null}
          {card.priority ? (
            <span className="flex size-[19.68px] items-center justify-center rounded-full border-[0.5px] border-app-line text-app-muted">
              <PriorityValueIcon priority={card.priority} className="size-3" />
            </span>
          ) : null}
        </div>
      ) : (
        <div className="h-1" />
      )}
    </motion.div>
  );
}
