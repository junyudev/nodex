import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { PageEmptyState, PageSection } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import { ToolbarButton } from "@/components/ui/toolbar-button";

export const LOADING_PLUGINS_LABEL = "Loading plugins…";

/** A directory section: a heading without a divider, then its grid. */
export function PluginsSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <PageSection id={id} title={title} showDivider={false}>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </PageSection>
  );
}

/** One column, or two once the page is at least 581px wide. */
export function PluginGrid({ children }: { readonly children?: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[581px]/skills-grid:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

const SKELETON_ROWS = [
  { key: "first", descriptionWidth: "w-3/5", titleWidth: "w-20" },
  { key: "second", descriptionWidth: "w-1/2", titleWidth: "w-16" },
  { key: "third", descriptionWidth: "w-2/3", titleWidth: "w-24" },
  { key: "fourth", descriptionWidth: "w-2/5", titleWidth: "w-16" },
  { key: "fifth", descriptionWidth: "w-3/5", titleWidth: "w-20" },
  { key: "sixth", descriptionWidth: "w-1/2", titleWidth: "w-16" },
] as const;

/** Six pulsing placeholder rows. */
export function PluginGridLoading() {
  return (
    <div role="status">
      <span className="sr-only">{LOADING_PLUGINS_LABEL}</span>
      <PluginGrid>
        {SKELETON_ROWS.map((row) => (
          <div key={row.key} aria-hidden="true">
            <div className="pointer-events-none flex flex-col justify-center gap-2.5 rounded-2xl p-2 text-base motion-safe:animate-pulse">
              <div className="flex items-center gap-3">
                <span className="shrink-0">
                  <div className="size-9 shrink-0 rounded-lg bg-text/10" />
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                    <div className={cn("h-3 rounded bg-text/10", row.titleWidth)} />
                    <div className="flex flex-col gap-0.5 text-sm leading-relaxed">
                      <div className={cn("h-3 rounded bg-text/10", row.descriptionWidth)} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <div className="h-token-button-composer w-14 rounded-lg bg-text/10" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </PluginGrid>
    </div>
  );
}

/** Loads the next page once the trailing placeholder scrolls into view. */
export function LoadMoreSentinel({
  hasNextPage,
  isFetchingNextPage,
  isRefetching = false,
  onLoadNextPage,
}: {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly isRefetching?: boolean;
  readonly onLoadNextPage: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useEffectEvent(() => {
    if (hasNextPage && !isFetchingNextPage && !isRefetching) onLoadNextPage();
  });
  useEffect(() => {
    const element = ref.current;
    if (element == null || !hasNextPage || isFetchingNextPage || isRefetching) return;
    if (typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isRefetching]);
  if (!hasNextPage && !isFetchingNextPage) return null;
  return (
    <div ref={ref}>
      <PluginGridLoading />
    </div>
  );
}

export function PluginsLoadError({
  error,
  retrying,
  onRetry,
}: {
  readonly error: Error;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <PageEmptyState
      title="Failed to load plugins"
      description={error.message}
      actions={
        <ToolbarButton color="secondary" loading={retrying} onClick={onRetry}>
          Retry
        </ToolbarButton>
      }
    />
  );
}

export function NoPluginsFound() {
  return <PageEmptyState title="No plugins found" />;
}
