import { useIntl } from "@/lib/i18n";
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { snapshotLinkActivation } from "@/lib/link-activation";
import { openLink } from "@/lib/link-opening";
import { useLinkOpening } from "@/lib/web-link-navigation";
import { cn } from "@/lib/utils";
import { BudgetedMarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/budgeted-markdown-renderer";
import type {
  GitHubActor,
  GitHubLabel,
  GitHubThreadRef,
  GitHubThreadSummary,
} from "../../../shared/github-thread";
import { gitHubThreadLabel } from "../../../shared/github-thread";
import { linkGitHubReferences } from "./github-thread-model";
import { GitHubThreadStateIcon, gitHubThreadSummaryState } from "./github-thread-state";

type LinkEvent = Pick<
  MouseEvent,
  "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault"
>;

/**
 * Opens a link the way any link in Nodex opens: a GitHub issue or pull request becomes its own
 * tab, everything else follows the person's link settings.
 */
export function useGitHubLinkOpener() {
  const router = useLinkOpening();
  return (url: string, event?: LinkEvent) => {
    event?.preventDefault();
    const request = {
      url,
      initiator: "github_thread_link",
      ...(event ? { activation: snapshotLinkActivation(event) } : {}),
    };
    void (router ?? { openLink }).openLink(request);
  };
}

/** Opens the thread's own page on GitHub, never another GitHub tab. */
export function useOpenOnGitHub() {
  const router = useLinkOpening();
  return (url: string, event?: LinkEvent) => {
    event?.preventDefault();
    void (router ?? { openLink }).openLink({
      url,
      initiator: "github_thread_open_on_github",
      webOnly: true,
      ...(event ? { activation: snapshotLinkActivation(event) } : {}),
    });
  };
}

function avatarSource(url: string, size: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("s", String(size * 2));
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A person's GitHub picture, or their initial while it has none. */
export function GitHubAvatar({
  actor,
  size = 16,
  className,
}: {
  readonly actor: GitHubActor | null;
  readonly size?: 16 | 20;
  readonly className?: string;
}) {
  const box = size === 20 ? "size-5" : "size-4";
  const [failed, setFailed] = useState<string | null>(null);
  const source = actor?.avatarUrl ? avatarSource(actor.avatarUrl, size) : null;
  if (source && failed !== source)
    return (
      <img
        src={source}
        alt=""
        aria-hidden
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setFailed(source)}
        className={cn(
          box,
          "shrink-0 bg-token-foreground/5",
          actor?.isBot ? "rounded-[4px]" : "rounded-full",
          className,
        )}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        box,
        "flex shrink-0 items-center justify-center rounded-full bg-token-foreground/10 text-[9px] font-medium text-token-description-foreground uppercase",
        className,
      )}
    >
      {actor?.login.slice(0, 1) ?? "?"}
    </span>
  );
}

/** Avatar and login; the login is where a reader looks for who did it. */
export function GitHubActorName({
  actor,
  avatar = true,
  className,
}: {
  readonly actor: GitHubActor | null;
  readonly avatar?: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  const login =
    actor?.login ??
    intl.formatMessage({ id: "githubThread.actor.ghost", defaultMessage: "Deleted account" });
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {avatar ? <GitHubAvatar actor={actor} /> : null}
      <span className="min-w-0 truncate font-medium text-token-text-primary">{login}</span>
    </span>
  );
}

/** A compact age that names the exact moment on hover. */
export function GitHubRelativeTime({
  at,
  href,
  className,
}: {
  readonly at: string;
  readonly href?: string | null;
  readonly className?: string;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const label = formatCompactRelativeTime(ms);
  const exact = intl.formatDate(ms, { dateStyle: "medium", timeStyle: "short" });
  const classes = cn("shrink-0 text-token-description-foreground tabular-nums", className);
  return (
    <NodexTooltip tooltipContent={exact} delayOpen>
      {href ? (
        <a
          href={href}
          className={cn(classes, "hover:text-token-text-primary hover:underline")}
          onClick={(event) => openOnGitHub(href, event)}
        >
          <time dateTime={at}>{label}</time>
        </a>
      ) : (
        <time dateTime={at} className={classes}>
          {label}
        </time>
      )}
    </NodexTooltip>
  );
}

/** A GitHub label in its own color: its color is the category. */
export function GitHubLabelChip({ label }: { readonly label: GitHubLabel }) {
  const color = /^[0-9a-f]{6}$/iu.test(label.color)
    ? `#${label.color}`
    : "var(--color-token-foreground)";
  const chip = (
    <span
      style={{ "--github-label": color } as CSSProperties}
      className="inline-flex h-5 max-w-48 shrink-0 items-center rounded-full bg-[color-mix(in_srgb,var(--github-label)_16%,transparent)] px-2 text-xs text-[color-mix(in_srgb,var(--github-label)_55%,var(--color-token-foreground))]"
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
  return label.description ? (
    <NodexTooltip tooltipContent={label.description} delayOpen>
      {chip}
    </NodexTooltip>
  ) : (
    chip
  );
}

/** Another issue or pull request, by its state, number and title. Opens as its own tab. */
export function GitHubThreadReferenceChip({
  thread,
  from,
}: {
  readonly thread: GitHubThreadSummary;
  /** The thread being read; a reference into the same repository drops the repository name. */
  readonly from: GitHubThreadRef;
}) {
  const openLinkFromThread = useGitHubLinkOpener();
  const sameRepository =
    thread.ref.host === from.host &&
    thread.ref.owner.toLowerCase() === from.owner.toLowerCase() &&
    thread.ref.repo.toLowerCase() === from.repo.toLowerCase();
  return (
    <NodexTooltip tooltipContent={`${gitHubThreadLabel(thread.ref)} · ${thread.title}`} delayOpen>
      <a
        href={thread.url}
        onClick={(event) => openLinkFromThread(thread.url, event)}
        onAuxClick={(event) => {
          if (event.button === 1) openLinkFromThread(thread.url, event);
        }}
        className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm ring-[0.5px] ring-token-border ring-inset hover:bg-token-foreground/5"
      >
        <GitHubThreadStateIcon state={gitHubThreadSummaryState(thread)} className="icon-2xs" />
        <span className="shrink-0 text-token-description-foreground tabular-nums">
          {sameRepository ? `#${thread.ref.number}` : gitHubThreadLabel(thread.ref)}
        </span>
        <span className="min-w-0 truncate">{thread.title}</span>
      </a>
    </NodexTooltip>
  );
}

/** GitHub Markdown read in Nodex's prose, with GitHub's references made links. */
export function GitHubMarkdown({
  markdown,
  thread,
  className,
}: {
  readonly markdown: string;
  readonly thread: GitHubThreadRef;
  readonly className?: string;
}) {
  const intl = useIntl();
  return (
    <BudgetedMarkdownRenderer
      dialect="document"
      content={linkGitHubReferences(markdown, thread)}
      className={cn("text-size-chat font-content", className)}
      sourceAriaLabel={intl.formatMessage({
        id: "githubThread.markdown.source",
        defaultMessage: "GitHub Markdown",
      })}
    />
  );
}

/** A quiet section heading inside the thread's body. */
export function GitHubSectionHeading({
  children,
  trailing,
}: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-2 text-sm font-medium text-token-text-secondary">
      <span className="min-w-0 truncate">{children}</span>
      {trailing ? <span className="ml-auto flex items-center gap-1">{trailing}</span> : null}
    </div>
  );
}
