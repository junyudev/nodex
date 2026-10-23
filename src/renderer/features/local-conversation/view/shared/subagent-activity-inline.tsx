import { useState, type ReactElement, type ReactNode } from "react";
import { NodexHoverCard, NodexHoverCardProvider } from "@/components/ui/hover-card";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { getSubagentActivityDisplayBudget } from "./subagent-activity-presentation";
import { SubagentAvatar } from "./subagent-avatar";

export interface SubagentActivityInlineItem {
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly details: ReactNode;
  readonly onOpen?: () => void;
}

/** Metadata already available to the transcript; opening this surface never loads task history. */
export function SubagentActivityDetails({
  name,
  status,
  statusTone = "neutral",
  description,
  metadata,
  path,
  startedAtMs,
  action,
}: {
  readonly name: string;
  readonly status: string;
  readonly statusTone?: "neutral" | "danger";
  readonly description?: ReactNode;
  readonly metadata?: string | null;
  readonly path?: string | null;
  readonly startedAtMs?: number | null;
  readonly action?: ReactNode;
}) {
  const startedAt = startedAtMs == null ? null : new Date(startedAtMs);
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm text-token-text-secondary">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 font-medium break-words text-token-foreground">{name}</span>
        <span className={cn("shrink-0", statusTone === "danger" && "text-token-charts-red")}>
          {status}
        </span>
      </div>
      {description}
      {metadata ? (
        <span className="break-words text-xs text-token-text-tertiary">{metadata}</span>
      ) : null}
      {path ? (
        <span className="break-all font-mono text-xs text-token-text-tertiary">{path}</span>
      ) : null}
      {startedAt || action ? (
        <div className="flex items-center justify-between gap-3 text-xs text-token-text-tertiary">
          {startedAt ? (
            <time dateTime={startedAt.toISOString()}>
              Started{" "}
              {startedAt.toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
    </div>
  );
}

function SubagentActivityHover({
  item,
  children,
}: {
  item: SubagentActivityInlineItem;
  children: ReactElement<{ onClick?: () => void }>;
}) {
  return (
    <NodexHoverCard
      ariaLabel={`${item.name} details`}
      hoverCardContent={item.details}
      placement="bottom-start"
      sideOffset={6}
      contentClassName="w-80 max-w-[calc(100vw-24px)]"
      contentBodyClassName="p-3"
      dismissOnReferencePress={Boolean(children.props.onClick)}
    >
      {children}
    </NodexHoverCard>
  );
}

const nameClassName =
  "inline-block max-w-[min(24ch,100%)] truncate rounded-sm align-bottom text-start focus-visible:outline-2 focus-visible:outline-offset-0";

/** Shared visual grammar; native events and Runtime tasks supply their own status facts. */
export function SubagentActivityInline({
  items,
  statusLabel,
  statusTone = "neutral",
  onOpenAll,
  testId = "subagent-activity-inline-group",
}: {
  readonly items: readonly SubagentActivityInlineItem[];
  readonly statusLabel: string;
  readonly statusTone?: "neutral" | "danger";
  readonly onOpenAll?: () => void | Promise<void>;
  readonly testId?: string;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(
    () => new Set(items.map((item) => item.id)),
  );
  const markSeen = (id: string) => {
    setSeenIds((current) => (current.has(id) ? current : new Set([...current, id])));
  };
  if (reducedMotion && items.some((item) => !seenIds.has(item.id))) {
    setSeenIds(new Set([...seenIds, ...items.map((item) => item.id)]));
  }

  if (items.length === 0) return null;
  const { avatarCount, namedCount, hiddenCount } = getSubagentActivityDisplayBudget(items.length);

  return (
    <NodexHoverCardProvider>
      <div
        aria-label={`Subagents ${statusLabel}`}
        aria-live="polite"
        role="status"
        className="flex min-w-0 items-start gap-1.5 text-base leading-5 text-token-conversation-body select-none"
        data-testid={testId}
      >
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5">
          {items.slice(0, avatarCount).map((item, index) => {
            const animateEntrance = !reducedMotion && !seenIds.has(item.id);
            const avatarProps = {
              "aria-label": item.name,
              className:
                "subagent-activity-chip inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2",
              "data-animate-entrance": animateEntrance ? "" : undefined,
              onAnimationEnd: animateEntrance ? () => markSeen(item.id) : undefined,
            };
            const avatar = <SubagentAvatar seed={item.seed} className="size-4" />;
            return (
              <SubagentActivityHover key={item.id} item={item}>
                {index >= namedCount && item.onOpen ? (
                  <button
                    {...avatarProps}
                    type="button"
                    className={cn(avatarProps.className, "cursor-interaction")}
                    onClick={item.onOpen}
                  >
                    {avatar}
                  </button>
                ) : (
                  <span {...avatarProps} tabIndex={index < namedCount ? -1 : 0}>
                    {avatar}
                  </span>
                )}
              </SubagentActivityHover>
            );
          })}
        </span>
        <span className="min-w-0 break-words">
          {items.slice(0, namedCount).map((item, index) => {
            const separator =
              index === 0
                ? ""
                : items.length === 2 || (items.length === 3 && index === 2)
                  ? " and "
                  : ", ";
            return (
              <span key={item.id}>
                {separator}
                <SubagentActivityHover item={item}>
                  <span
                    role={item.onOpen ? "button" : undefined}
                    tabIndex={0}
                    className={cn(
                      nameClassName,
                      item.onOpen && "cursor-interaction hover:text-token-foreground",
                    )}
                    onClick={item.onOpen}
                    onKeyDown={(event) => {
                      if (!item.onOpen || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      if (event.key === "Enter") event.currentTarget.click();
                    }}
                    onKeyUp={(event) => {
                      if (!item.onOpen || event.key !== " ") return;
                      event.preventDefault();
                      event.currentTarget.click();
                    }}
                  >
                    {item.name}
                  </span>
                </SubagentActivityHover>
              </span>
            );
          })}
          {hiddenCount > 0 ? (
            <>
              {" and "}
              {onOpenAll ? (
                <button
                  type="button"
                  aria-label={`Show all ${items.length} subagents`}
                  className="inline cursor-interaction rounded-sm text-start hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-0"
                  onClick={() => void onOpenAll()}
                >
                  {hiddenCount} more
                </button>
              ) : (
                `${hiddenCount} more`
              )}
            </>
          ) : null}{" "}
          <span className={statusTone === "danger" ? "text-token-charts-red" : undefined}>
            {statusLabel}
          </span>
        </span>
      </div>
    </NodexHoverCardProvider>
  );
}
