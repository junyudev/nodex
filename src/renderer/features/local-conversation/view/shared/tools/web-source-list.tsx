import { useRoutedWebLink } from "@/lib/web-link-navigation";
import { NodexTooltip } from "@/components/ui/tooltip";
import { SiteIcon } from "@/components/shared/site-icon";
import type { WebSource } from "../../../../../../shared/codex-web-search";

/** Pages a web search returned, as compact chips that open the page. */
export function WebSourceList({ sources }: { sources: readonly WebSource[] }) {
  return (
    <ul className="flex min-w-0 flex-wrap gap-2" data-testid="web-search-sources">
      {sources.map((source) => (
        <li key={source.url} className="max-w-full min-w-0">
          <WebSourceChip source={source} />
        </li>
      ))}
    </ul>
  );
}

function WebSourceChip({ source }: { source: WebSource }) {
  const routeLink = useRoutedWebLink();
  const name = source.title ?? source.label;
  return (
    <NodexTooltip
      delayOpen
      tooltipContent={
        <span className="flex flex-col">
          <span>{name}</span>
          {source.title == null ? null : (
            <span className="truncate text-(--color-text-tertiary)">{source.label}</span>
          )}
        </span>
      }
    >
      <a
        href={source.url}
        {...routeLink({ url: source.url, initiator: "web_source_chip" })}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-6 max-w-40 cursor-interaction items-center gap-2 rounded-full bg-(--color-background-secondary-soft) py-1 ps-1 pe-2 text-xs text-(--color-text-secondary) no-underline select-none hover:bg-(--color-background-secondary-ghost-hover) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
      >
        <SiteIcon className="icon-sm" compactGlobe href={source.url} />
        <span className="truncate">{name}</span>
      </a>
    </NodexTooltip>
  );
}
