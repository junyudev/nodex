import { useIntl, type IntlShape } from "@/lib/i18n";
import { useState } from "react";
import { EmojiFaceBadgePlus20Glyph } from "@/components/shared/icons/outline-glyphs";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  GITHUB_REACTIONS,
  type GitHubReactionContent,
  type GitHubReactions,
} from "../../../shared/github-thread";

const EMOJI: Record<GitHubReactionContent, string> = {
  thumbs_up: "👍",
  thumbs_down: "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

function reactionName(intl: IntlShape, content: GitHubReactionContent): string {
  return intl.formatMessage(
    {
      id: "githubThread.reactions.name",
      defaultMessage:
        "{content, select, thumbs_up {Thumbs up} thumbs_down {Thumbs down} laugh {Laugh} hooray {Hooray} confused {Confused} heart {Heart} rocket {Rocket} other {Eyes}}",
    },
    { content },
  );
}

export type GitHubReactionToggle = (content: GitHubReactionContent, reacted: boolean) => void;

/**
 * The reactions on a description, comment or review: what people chose, with counts, the
 * viewer's own pressed. Until someone reacts, the picker waits with the entry's other actions
 * (`GitHubReactionPicker`), so pointing at an entry never moves what is below it.
 */
export function GitHubReactionsBar({
  reactions,
  onToggle,
  className,
}: {
  readonly reactions: GitHubReactions;
  readonly onToggle: GitHubReactionToggle | null;
  readonly className?: string;
}) {
  const intl = useIntl();
  const canReact = reactions.viewerCanReact && onToggle !== null;
  if (reactions.groups.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {reactions.groups.map((group) => {
        const label = intl.formatMessage(
          {
            id: "githubThread.reactions.count",
            defaultMessage:
              "{name}: {count, plural, one {# person} other {# people}}{mine, select, true { including you} other {}}",
          },
          {
            name: reactionName(intl, group.content),
            count: group.count,
            mine: String(group.viewerReacted),
          },
        );
        return (
          <NodexTooltip key={group.content} tooltipContent={label} side="top" delayOpen>
            <button
              type="button"
              aria-label={label}
              aria-pressed={group.viewerReacted}
              disabled={!canReact}
              onClick={() => onToggle?.(group.content, !group.viewerReacted)}
              className={cn(
                "cursor-interaction inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs tabular-nums ring-[0.5px] ring-token-border ring-inset disabled:cursor-default",
                group.viewerReacted
                  ? "bg-token-charts-blue/10 text-token-text-primary ring-token-charts-blue/40"
                  : "text-token-text-secondary not-disabled:hover:bg-token-foreground/5",
              )}
            >
              <span aria-hidden className="text-[13px] leading-none">
                {EMOJI[group.content]}
              </span>
              {group.count}
            </button>
          </NodexTooltip>
        );
      })}
      {canReact ? <GitHubReactionPicker reactions={reactions} onToggle={onToggle} /> : null}
    </div>
  );
}

/** GitHub's eight reactions to choose from; a chosen one is taken back by choosing it again. */
export function GitHubReactionPicker({
  reactions,
  onToggle,
  compact = false,
}: {
  readonly reactions: GitHubReactions;
  readonly onToggle: GitHubReactionToggle;
  /** Sized as an icon button among an entry's hover actions. */
  readonly compact?: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({
    id: "githubThread.reactions.add",
    defaultMessage: "Add reaction",
  });
  const mine = new Set(
    reactions.groups.filter((group) => group.viewerReacted).map((group) => group.content),
  );
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent={label} side="top" disabled={open}>
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "cursor-interaction inline-flex items-center justify-center text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary aria-expanded:bg-token-foreground/5",
              compact
                ? "size-6 rounded-md"
                : "size-6 rounded-full ring-[0.5px] ring-token-border ring-inset",
            )}
          >
            <EmojiFaceBadgePlus20Glyph className="icon-xs" />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent side="top" align="start" className="w-auto flex-row gap-0.5 p-1">
        {GITHUB_REACTIONS.map((content) => (
          <button
            key={content}
            type="button"
            aria-label={reactionName(intl, content)}
            aria-pressed={mine.has(content)}
            onClick={() => {
              setOpen(false);
              onToggle(content, !mine.has(content));
            }}
            className={cn(
              "cursor-interaction flex size-8 items-center justify-center rounded-lg text-base leading-none hover:bg-token-foreground/5",
              mine.has(content) && "bg-token-charts-blue/10",
            )}
          >
            {EMOJI[content]}
          </button>
        ))}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
