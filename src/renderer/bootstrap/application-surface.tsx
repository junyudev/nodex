import {
  Component,
  Suspense,
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { NODEX_LOGO_GEOMETRY, NODEX_LOGO_VIEW_BOX } from "./nodex-logo-source";

interface ApplicationReadiness {
  readonly ready: Promise<void>;
  readonly mount: () => () => void;
  readonly content: () => () => void;
  readonly pending: () => () => void;
  readonly fail: (error: unknown) => void;
}

/** One mount's committed Workbench and visible Suspense fallbacks determine readiness. */
export function createApplicationReadiness(): ApplicationReadiness {
  const counts = { mount: 0, content: 0, pending: 0 };
  let settled = false;
  let scheduled = false;
  let resolveReady = (): void => undefined;
  let rejectReady = (_error: unknown): void => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A render can fail before the caller gets past flushSync to await this promise.
  void ready.catch(() => undefined);

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectReady(error);
  };
  const scheduleCheck = (): void => {
    if (settled || scheduled) return;
    scheduled = true;
    // Read the final commit, after nested fallbacks and StrictMode effect replay.
    queueMicrotask(() => {
      scheduled = false;
      if (settled) return;
      if (counts.mount === 0) {
        fail(new Error("Nodex renderer unmounted before opening"));
        return;
      }
      if (counts.content === 0 || counts.pending > 0) return;
      settled = true;
      resolveReady();
    });
  };
  const retain = (kind: keyof typeof counts): (() => void) => {
    if (settled) return () => undefined;
    counts[kind] += 1;
    scheduleCheck();
    return () => {
      counts[kind] -= 1;
      scheduleCheck();
    };
  };
  return {
    ready,
    mount: () => retain("mount"),
    content: () => retain("content"),
    pending: () => retain("pending"),
    fail,
  };
}

const ApplicationReadinessContext = createContext<ApplicationReadiness | null>(null);

class ApplicationErrorBoundary extends Component<
  { readonly children: ReactNode; readonly onError?: (error: unknown) => void },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-(--foreground-secondary)"
      >
        <svg
          aria-hidden="true"
          className="size-12 text-(--foreground)"
          viewBox={NODEX_LOGO_VIEW_BOX}
          fill="none"
          dangerouslySetInnerHTML={{ __html: NODEX_LOGO_GEOMETRY }}
        />
        <p>Nodex could not open this view.</p>
        <button
          type="button"
          className="rounded-md bg-(--background-secondary) px-3 py-1.5 text-(--foreground)"
          onClick={() => {
            void window.api?.restartApplication?.().catch(() => undefined);
          }}
        >
          Restart Nodex
        </button>
      </div>
    );
  }
}

export function ApplicationReadinessRoot({
  readiness,
  children,
}: {
  readonly readiness: ApplicationReadiness;
  readonly children: ReactNode;
}) {
  useLayoutEffect(() => readiness.mount(), [readiness]);
  return (
    <ApplicationReadinessContext value={readiness}>
      <ApplicationErrorBoundary onError={readiness.fail}>{children}</ApplicationErrorBoundary>
    </ApplicationReadinessContext>
  );
}

/** Mark a committed route once its initial scene selection has settled. */
export function useApplicationReady(ready: boolean): void {
  const readiness = useContext(ApplicationReadinessContext);
  useLayoutEffect(() => {
    if (!ready) return;
    return readiness?.content();
  }, [readiness, ready]);
}

function PendingSurface({ children }: { readonly children: ReactNode }) {
  const readiness = useContext(ApplicationReadinessContext);
  useLayoutEffect(() => readiness?.pending(), [readiness]);
  return children;
}

/** Keep normal React lazy/Suspense semantics while observing only the initial visible commit. */
export function ApplicationSurface({
  children,
  fallback = null,
}: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  const readiness = useContext(ApplicationReadinessContext);
  return (
    <ApplicationErrorBoundary onError={readiness?.fail}>
      <Suspense fallback={<PendingSurface>{fallback}</PendingSurface>}>{children}</Suspense>
    </ApplicationErrorBoundary>
  );
}
