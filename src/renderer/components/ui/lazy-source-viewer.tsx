import { useIntl } from "@/lib/i18n";
import { lazy, Suspense } from "react";
import type { SourceViewerProps } from "./source-viewer";
import { LoadingResultsShimmer } from "./loading-results-shimmer";

const loadSourceViewer = () => import("./source-viewer");
const SourceViewerLazy = lazy(async () => ({
  default: (await loadSourceViewer()).SourceViewer,
}));

export function preloadSourceViewer(): void {
  void loadSourceViewer();
}

export function LazySourceViewer(props: SourceViewerProps) {
  const intl = useIntl();
  return (
    <Suspense
      fallback={
        <div
          aria-label={intl.formatMessage(
            { id: "ui.lazySourceViewer.loading", defaultMessage: "Loading {label}" },
            { label: props.ariaLabel },
          )}
          aria-live="polite"
          className="flex h-full min-h-24 items-start px-4 py-5"
          role="status"
        >
          <LoadingResultsShimmer
            lines={3}
            maxWidth={88}
            minWidth={58}
            seed={`source-viewer:${props.ariaLabel}`}
            size="sm"
          />
        </div>
      }
    >
      <SourceViewerLazy {...props} />
    </Suspense>
  );
}
