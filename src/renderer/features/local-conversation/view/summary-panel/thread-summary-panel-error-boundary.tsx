import { Component, type ErrorInfo, type ReactNode } from "react";
import { CODEX_SUMMARY_PANEL_WIDTH } from "../../../../lib/codex-panel-motion";
import { cn } from "../../../../lib/utils";
import {
  REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
} from "../../../../../shared/remote-hosted-pip";

type ThreadSummaryPanelRenderBoundaryFallbackProps = {
  resetError: () => void;
};

type ThreadSummaryPanelRenderBoundaryProps = {
  children: ReactNode;
  renderFallback: (props: ThreadSummaryPanelRenderBoundaryFallbackProps) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKey: string | null;
};

type ThreadSummaryPanelRenderBoundaryState = {
  error: Error | null;
};

export class ThreadSummaryPanelRenderBoundary extends Component<
  ThreadSummaryPanelRenderBoundaryProps,
  ThreadSummaryPanelRenderBoundaryState
> {
  state: ThreadSummaryPanelRenderBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ThreadSummaryPanelRenderBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps: ThreadSummaryPanelRenderBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.resetError();
    }
  }

  resetError = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.renderFallback({ resetError: this.resetError });
    }

    return this.props.children;
  }
}

type ThreadSummaryPanelRenderErrorFallbackProps = {
  hideImmediately?: boolean;
  mounted: boolean;
  onRetry: () => void;
  open: boolean;
};

export function ThreadSummaryPanelRenderErrorFallback({
  hideImmediately = false,
  mounted,
  onRetry,
  open,
}: ThreadSummaryPanelRenderErrorFallbackProps) {
  if (!mounted || !open) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40">
      <div className="relative flex max-h-full">
        <div className={cn("max-h-full min-h-0 pe-4", hideImmediately && "invisible")}>
          <div
            {...{
              [REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE]: "thread-summary-panel",
              [REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE]: "thread-summary-panel",
            }}
            className="pointer-events-auto rounded-lg border border-token-border bg-token-main-surface-primary px-4 py-3 text-sm text-token-text-secondary shadow-lg"
            style={{ width: CODEX_SUMMARY_PANEL_WIDTH }}
          >
            <div className="mb-2 font-medium text-token-text-primary">
              Summary panel couldn&apos;t render
            </div>
            <button
              className="inline-flex h-8 items-center justify-center rounded-md border border-token-border px-2 text-sm text-token-text-secondary transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
              onClick={onRetry}
              type="button"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
