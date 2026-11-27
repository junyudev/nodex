import { useIntl } from "@/lib/i18n";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { InlineReferenceVisual } from "@/components/board/inline-reference-visual";
import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  gitHubThreadLabel,
  type GitHubThreadLink,
  type GitHubThreadSummary,
} from "../../../shared/github-thread";
import { gitHubThreadStateLabel } from "./github-thread-copy";
import { GitHubThreadStateIcon, gitHubThreadSummaryState } from "./github-thread-state";
import { useGitHubThreadSummary } from "./use-github-thread";

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "children" | "className">;

/** Starts reading a thread only once its link has come near the screen, then stays settled. */
function useSeenOnce() {
  const [seen, setSeen] = useState(false);
  const attach = (element: HTMLElement | null) => {
    if (!element || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setSeen(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  };
  return [attach, seen] as const;
}

function ThreadGlyph({ summary }: { readonly summary: GitHubThreadSummary | null }) {
  return summary ? (
    <GitHubThreadStateIcon state={gitHubThreadSummaryState(summary)} className="size-full" />
  ) : (
    <WebsiteGitHubIcon aria-hidden className="size-full" />
  );
}

/** A thread's state glyph alone, read once it comes near the screen, as editors draw it. */
export function GitHubThreadGlyph({ thread }: { readonly thread: GitHubThreadLink["ref"] }) {
  const [attach, seen] = useSeenOnce();
  const summary = useGitHubThreadSummary(thread, seen);
  return (
    <span ref={attach} className="inline-flex size-full">
      <ThreadGlyph summary={summary} />
    </span>
  );
}

/**
 * A link to a GitHub issue or pull request, read inline. Written as its own URL it names the
 * thread, as a mention does: its state glyph, number and live title. Written with words it keeps
 * them and gains the state glyph. Either way it opens and offers what any web link does.
 */
export function GitHubThreadInlineLink({
  link,
  bare,
  anchor,
  className,
  children,
}: {
  readonly link: GitHubThreadLink;
  /** The link's words are its own URL. */
  readonly bare: boolean;
  readonly anchor: AnchorProps;
  /** Styles a link written with words; a mention keeps its own look. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  const [attach, seen] = useSeenOnce();
  const summary = useGitHubThreadSummary(link.ref, seen);
  const location = gitHubThreadLabel(summary?.ref ?? link.ref);
  const tooltip = (
    <span className="flex max-w-80 min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-token-description-foreground">
        <span className="inline-flex size-3.5 shrink-0">
          <ThreadGlyph summary={summary} />
        </span>
        <span className="min-w-0 truncate">
          {location}
          {summary ? ` · ${gitHubThreadStateLabel(intl, gitHubThreadSummaryState(summary))}` : null}
        </span>
      </span>
      {summary ? <span className="text-sm text-token-text-primary">{summary.title}</span> : null}
    </span>
  );
  const trigger = bare ? (
    <InlineReferenceVisual
      as="a"
      {...anchor}
      ref={attach}
      data-github-thread-link="mention"
      icon={<ThreadGlyph summary={summary} />}
      iconClassName="text-token-description-foreground select-none"
      label={
        summary ? (
          <>
            <span className="font-normal text-token-description-foreground tabular-nums">
              #{summary.ref.number}
            </span>{" "}
            {summary.title}
          </>
        ) : (
          location
        )
      }
      // Named like a mention, it reads like one wherever it appears, not like the text's links.
      className="max-w-[26rem] cursor-interaction align-baseline select-text"
    />
  ) : (
    <a
      {...anchor}
      ref={attach}
      data-github-thread-link="link"
      className={cn(
        "cursor-interaction break-words whitespace-normal text-token-text-link-foreground hover:underline",
        className,
      )}
    >
      <span
        aria-hidden
        className="relative top-[0.14em] me-[0.25em] inline-flex size-[1em] shrink-0 select-none"
      >
        <ThreadGlyph summary={summary} />
      </span>
      {children}
    </a>
  );
  return (
    <NodexTooltip
      tooltipContent={tooltip}
      side="top"
      align="start"
      sideOffset={4}
      delay={300}
      surface="rich"
      tooltipClassName="px-2.5 py-2"
    >
      {trigger}
    </NodexTooltip>
  );
}
