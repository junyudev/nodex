import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { AgentProviderIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { formatDate } from "@/lib/file-metadata-format";
import type { PageFileTreeProvenance } from "@/lib/page-file-tree";
import { parsePageFileSourceKey, type PageFileSource } from "@/lib/page-file-provenance";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { cn } from "@/lib/utils";

export interface PageFileSourcePresentation {
  readonly source: PageFileSource;
  /** The chat's current title, `You`, or the command line. */
  readonly label: string;
  /** Present for a chat that still exists and can be opened. */
  readonly sessionId: string | null;
}

/** Resolves each distinct attaching chat once, through the shared Session detail cache. */
export function usePageFileSources(
  sourceKeys: readonly string[],
): (sourceKey: string) => PageFileSourcePresentation | null {
  const sources = [...new Set(sourceKeys)].flatMap((key) => {
    const source = parsePageFileSourceKey(key);
    return source ? [[key, source] as const] : [];
  });
  const sessionIds = [
    ...new Set(
      sources.flatMap(([, source]) => (source.kind === "agent" ? [source.sessionId] : [])),
    ),
  ];
  const sessions = useQueries({
    queries: sessionIds.map((sessionId) => projectSessionDetailQueryOptions(sessionId)),
  });
  const titles = new Map(
    sessionIds.map((sessionId, index) => [sessionId, sessions[index]?.data] as const),
  );
  return (sourceKey) => {
    const source = parsePageFileSourceKey(sourceKey);
    if (!source) return null;
    if (source.kind === "person") return { source, label: "You", sessionId: null };
    if (source.kind === "external") return { source, label: "Command line", sessionId: null };
    const session = titles.get(source.sessionId);
    if (session === undefined) return { source, label: "Chat", sessionId: source.sessionId };
    if (session === null) return { source, label: "Deleted chat", sessionId: null };
    return { source, label: session.displayTitle, sessionId: source.sessionId };
  };
}

const attachedAtLabel = (provenance: PageFileTreeProvenance): string | null =>
  provenance.latestAttachedAtMs === null
    ? null
    : formatCompactRelativeTime(provenance.latestAttachedAtMs);

const attachedTooltip = (
  presentation: PageFileSourcePresentation,
  provenance: PageFileTreeProvenance,
): string => {
  const who =
    presentation.source.kind === "agent"
      ? `Attached by ${presentation.label}`
      : presentation.source.kind === "person"
        ? "Attached by you"
        : "Attached from the command line";
  return provenance.latestAttachedAtMs === null
    ? who
    : `${who} · ${formatDate(new Date(provenance.latestAttachedAtMs).toISOString())}`;
};

/**
 * Where Files came from: the attaching chat with its provider mark, you, or the command line,
 * and how long ago. A chat opens on click.
 */
export function PageFileSourceLabel({
  provenance,
  presentation,
  onOpenChat,
  className,
}: {
  readonly provenance: PageFileTreeProvenance;
  readonly presentation: PageFileSourcePresentation;
  readonly onOpenChat?: (sessionId: string) => void;
  readonly className?: string;
}): ReactNode {
  const time = attachedAtLabel(provenance);
  const { source, sessionId } = presentation;
  const label = (
    <>
      {source.kind === "agent" ? (
        <AgentProviderIcon kind={source.backendKind} className="size-3 shrink-0" />
      ) : null}
      <span className="min-w-0 truncate">{presentation.label}</span>
    </>
  );
  return (
    <NodexTooltip tooltipContent={attachedTooltip(presentation, provenance)} delayOpen>
      <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
        {sessionId && onOpenChat ? (
          <button
            type="button"
            className="inline-flex min-w-0 cursor-interaction items-center gap-1 rounded-sm hover:text-(--foreground-secondary) hover:underline focus-visible:outline-2 focus-visible:outline-token-focus-border"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChat(sessionId);
            }}
          >
            {label}
          </button>
        ) : (
          label
        )}
        {time ? <span className="shrink-0 tabular-nums">· {time}</span> : null}
      </span>
    </NodexTooltip>
  );
}
