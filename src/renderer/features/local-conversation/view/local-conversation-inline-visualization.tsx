import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { NodexRetainedModalFocusBoundary } from "@/components/ui/retained-modal-focus-boundary";
import { Maximize2 } from "@/components/shared/icons/generic-icons";
import { CloseIcon } from "@/components/shared/icons";
import { codexVisualizationQueryOptions } from "../../../lib/codex-visualizations";
import {
  createInlineVisualizationRuntime,
  type InlineVisualizationRuntime,
} from "../../../lib/inline-visualization/inline-visualization-runtime";
import { INLINE_VISUALIZATION_INITIAL_HEIGHT } from "../../../lib/inline-visualization/inline-visualization-document";
import { resolveInlineVisualizationSourceThreadId } from "../../../lib/inline-visualization/inline-visualization-directives";
import {
  canExpandInlineVisualization,
  type InlineVisualizationMode,
} from "../../../lib/inline-visualization/inline-visualization-presentation";
import {
  useInlineVisualizationFollowUpHandler,
  type InlineVisualizationFollowUpMessage,
} from "../../../lib/inline-visualization/inline-visualization-follow-up-context";
import {
  InlineVisualizationFollowUpReview,
  useInlineVisualizationFollowUpReview,
} from "./inline-visualization-follow-up-review";
import { ConversationVisualizationContext } from "./inline-visualization-context";

const INITIAL = {
  status: "loading" as const,
  height: INLINE_VISUALIZATION_INITIAL_HEIGHT,
  displayMode: "inline" as const,
  error: null,
};
const subscribeNothing = () => () => {};
const readInitial = () => INITIAL;

function VisualizationFrame({
  html,
  scopeId,
  retry,
  canExpand,
}: {
  html: string;
  scopeId: string;
  retry: () => void;
  canExpand: boolean;
}) {
  const followUp = useInlineVisualizationFollowUpHandler();
  const followUpReview = useInlineVisualizationFollowUpReview();
  const reviewFollowUp = followUpReview.review;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<InlineVisualizationRuntime | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const [expandButton, setExpandButton] = useState<HTMLButtonElement | null>(null);
  // Conversation lifecycle changes update actions without replacing the retained document.
  const callbacks = useRef({ followUp, reviewFollowUp, canExpand });
  useLayoutEffect(() => {
    callbacks.current = { followUp, reviewFollowUp, canExpand };
  });
  const canSendFollowUp = followUp !== null;
  useLayoutEffect(() => {
    if (!surface) return;
    const value = createInlineVisualizationRuntime({
      scopeId,
      html,
      canExpand: () => callbacks.current.canExpand,
      ...(canSendFollowUp
        ? {
            followUp: async (message: InlineVisualizationFollowUpMessage) => {
              const send = callbacks.current.followUp;
              if (!send) throw new Error("The conversation is unavailable");
              await send(message);
            },
          }
        : {}),
      reviewFollowUp: (message, signal) => callbacks.current.reviewFollowUp(message, signal),
    });
    surface.append(value.element);
    setRuntime(value);
    return () => {
      void value.dispose();
    };
  }, [surface, scopeId, html, canSendFollowUp]);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? subscribeNothing,
    runtime?.getSnapshot ?? readInitial,
    readInitial,
  );
  const expanded = snapshot.displayMode === "fullscreen";
  useLayoutEffect(() => {
    runtime?.setDisplayMode("inline");
  }, [runtime, canExpand]);
  // The top layer escapes transformed transcript ancestors without reparenting the guest.
  useLayoutEffect(() => {
    const element = frame;
    if (!element || !expanded) return;
    element.showPopover();
    return () => {
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [expanded, frame]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (followUpReview.request) return;
      if (event.key !== "Escape" || event.defaultPrevented) return;
      runtime?.setDisplayMode("inline");
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [expanded, runtime, followUpReview.request]);
  const setMode = (mode: "inline" | "fullscreen") => {
    runtime?.setDisplayMode(mode);
  };
  return (
    <div
      ref={setBoundary}
      data-inline-visualization="true"
      data-content-search-skip="true"
      data-visualization-status={snapshot.status}
      style={{ height: snapshot.height }}
    >
      <NodexRetainedModalFocusBoundary
        open={expanded}
        modalElement={frame}
        boundaryElement={boundary}
        triggerElement={expandButton}
        onClose={() => setMode("inline")}
      >
        <div
          ref={setFrame}
          popover={expanded ? "manual" : undefined}
          role={expanded ? "dialog" : undefined}
          aria-label={expanded ? "Interactive response" : undefined}
          aria-modal={expanded ? true : undefined}
          tabIndex={-1}
          onPointerDown={(event) => {
            if (!expanded || event.target !== event.currentTarget) return;
            event.preventDefault();
            setMode("inline");
          }}
          className={
            expanded
              ? "fixed inset-0 z-50 m-0 flex h-auto w-auto overflow-auto border-0 bg-token-main-surface-primary/90 p-8"
              : "relative h-full"
          }
        >
          {expanded ? (
            <button
              type="button"
              aria-label="Exit fullscreen"
              className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-md bg-token-main-surface-primary/90 text-token-text-secondary"
              onClick={() => setMode("inline")}
            >
              <CloseIcon className="size-4" />
            </button>
          ) : null}
          <div
            data-visualization-preview-content={expanded ? "true" : undefined}
            className={
              expanded
                ? "m-auto w-full max-w-[80%] shrink-0 overflow-x-auto rounded-2xl border border-token-border-light bg-token-main-surface-primary p-8 shadow-2xl"
                : "h-full"
            }
          >
            <div
              className="group relative w-full overflow-hidden rounded-lg"
              style={{ height: snapshot.height }}
            >
              {canExpand ? (
                <button
                  ref={setExpandButton}
                  type="button"
                  aria-label="Open fullscreen"
                  hidden={expanded}
                  className="absolute right-2 top-2 z-10 grid size-9 place-items-center rounded-md bg-token-main-surface-primary/90 text-token-text-secondary opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  onClick={() => setMode("fullscreen")}
                >
                  <Maximize2 className="size-4" />
                </button>
              ) : null}
              {snapshot.status === "loading" ? (
                <div
                  role="status"
                  aria-label="Loading interactive response"
                  className="absolute inset-0 animate-pulse bg-token-foreground/5"
                />
              ) : null}
              {snapshot.status === "error" ? (
                <div
                  role="alert"
                  className="absolute inset-0 z-10 flex items-center justify-center gap-3 bg-token-main-surface-primary text-sm text-token-text-secondary"
                >
                  <span>This response couldn’t load</span>
                  <button type="button" onClick={retry}>
                    Retry
                  </button>
                </div>
              ) : null}
              <div ref={setSurface} className="h-full w-full" />
            </div>
          </div>
          <InlineVisualizationFollowUpReview
            request={followUpReview.request}
            settle={followUpReview.settle}
            portalContainer={expanded ? frame : undefined}
          />
        </div>
      </NodexRetainedModalFocusBoundary>
    </div>
  );
}

/** File reads and execution share the native source identity, independent of the visible Thread's cwd. */
export function LocalConversationInlineVisualization({
  file,
  sourceThreadId,
  cacheKey,
  mode = "narrow",
}: {
  readonly file: string;
  readonly sourceThreadId?: string | null;
  readonly cacheKey?: string;
  readonly mode?: InlineVisualizationMode;
}) {
  const context = useContext(ConversationVisualizationContext);
  const instanceId = useId();
  const [attempt, setAttempt] = useState(0);
  if (!context) return null;
  return (
    <LoadedVisualization
      file={file}
      sourceThreadId={resolveInlineVisualizationSourceThreadId({
        file,
        declaredSourceThreadId: sourceThreadId,
        threadId: context.threadId,
        changedFilePaths: sourceThreadId ? [] : context.readChangedFilePaths(),
      })}
      context={context}
      cacheKey={cacheKey ?? instanceId}
      attempt={attempt}
      mode={mode}
      retry={() => setAttempt((value) => value + 1)}
    />
  );
}

function LoadedVisualization({
  file,
  sourceThreadId,
  context,
  cacheKey,
  attempt,
  retry,
  mode,
}: {
  file: string;
  sourceThreadId: string;
  context: ConversationVisualizationContext;
  cacheKey: string;
  attempt: number;
  retry: () => void;
  mode: InlineVisualizationMode;
}) {
  const query = useQuery(
    codexVisualizationQueryOptions(
      {
        hostId: context.hostId,
        sourceThreadId,
        file,
        ...(context.turnId ? { turnId: context.turnId } : {}),
      },
      cacheKey,
      context.live,
    ),
  );
  const scopeId = JSON.stringify([
    context.hostId,
    context.threadId,
    sourceThreadId,
    file,
    context.turnId,
    cacheKey,
    attempt,
  ]);
  const retryResource = () => {
    retry();
    void query.refetch();
  };
  if (query.isError || (query.isSuccess && query.data.contents === null))
    return (
      <div
        role="alert"
        data-content-search-skip="true"
        className="flex h-60 items-center justify-center gap-3 text-sm text-token-text-secondary"
      >
        <span>This response couldn’t load</span>
        <button type="button" onClick={retryResource}>
          Retry
        </button>
      </div>
    );
  if (!query.data || query.data.contents === null)
    return (
      <div
        role="status"
        data-content-search-skip="true"
        aria-label="Loading interactive response"
        className="h-60 animate-pulse rounded-lg bg-token-foreground/5"
      />
    );
  return (
    <VisualizationFrame
      key={scopeId}
      html={query.data.contents}
      scopeId={scopeId}
      retry={retryResource}
      canExpand={canExpandInlineVisualization({ mode, isStreaming: context.live })}
    />
  );
}
