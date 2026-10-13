import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { NodexRetainedModalFocusBoundary } from "@/components/ui/retained-modal-focus-boundary";
import { Maximize2 } from "@/components/shared/icons/generic-icons";
import { CloseIcon, CopyIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  createInlineVisualizationRuntime,
  type InlineVisualizationRuntime,
} from "../../../lib/inline-visualization/inline-visualization-runtime";
import { INLINE_VISUALIZATION_INITIAL_HEIGHT } from "../../../lib/inline-visualization/inline-visualization-document";
import { INLINE_VISUALIZATION_PAINT_GUTTER } from "../../../lib/inline-visualization/inline-visualization-presentation";
import type { InlineVisualizationFollowUpMessage } from "../../../lib/inline-visualization/inline-visualization-follow-up-context";
import type {
  InlineVisualizationFrameOwner,
  InlineVisualizationFrameSnapshot,
} from "../../../lib/inline-visualization/inline-visualization-frame-owner";
import {
  InlineVisualizationFollowUpReview,
  useInlineVisualizationFollowUpReview,
} from "./inline-visualization-follow-up-review";
import { createInlineVisualizationWidgetStateOwner } from "../../../lib/inline-visualization/inline-visualization-widget-state";
import { InlineVisualizationAnnotationControls } from "./inline-visualization-annotation-controls";
const INITIAL = {
  status: "loading" as const,
  height: INLINE_VISUALIZATION_INITIAL_HEIGHT,
  fullscreenHeight: null,
  displayMode: "inline" as const,
  error: null,
};
const subscribeNothing = () => () => {};
const readInitial = () => INITIAL;
const PAINT_STYLE: CSSProperties = {
  "--visualize-paint-gutter": `${INLINE_VISUALIZATION_PAINT_GUTTER / 2}px`,
} as CSSProperties;
export function InlineVisualizationFrameView({
  owner,
  id,
}: {
  readonly owner: InlineVisualizationFrameOwner;
  readonly id: string;
}) {
  const frame = useSyncExternalStore(
    (listener) => owner.subscribeFrame(id, listener),
    () => owner.readFrame(id),
  );
  if (!frame) return null;
  return <VisualizationFrame owner={owner} record={frame} />;
}
function VisualizationFrame({
  owner,
  record,
}: {
  owner: InlineVisualizationFrameOwner;
  record: InlineVisualizationFrameSnapshot;
}) {
  const { id, fragment, stateIdentity, documentRevision, active } = record;
  const html = fragment.contents;
  const scopeId = JSON.stringify([id, documentRevision]);
  const canExpand = active && record.canExpand;
  const retry = () => owner.retry(id);
  const followUpReview = useInlineVisualizationFollowUpReview();
  const reviewFollowUp = followUpReview.review;
  const settleReview = followUpReview.settle;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<InlineVisualizationRuntime | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const [expandButton, setExpandButton] = useState<HTMLButtonElement | null>(null);
  // Conversation lifecycle changes update actions without replacing the retained document.
  const callbacks = useRef({ reviewFollowUp, canExpand });
  useLayoutEffect(() => {
    callbacks.current = { reviewFollowUp, canExpand };
  });
  const stateHostId = stateIdentity?.hostId;
  const stateThreadId = stateIdentity?.threadId;
  const statePath = stateIdentity?.path;
  useLayoutEffect(() => {
    if (!surface) return;
    const value = createInlineVisualizationRuntime({
      scopeId,
      html,
      initialHeight: owner.readFrame(id)?.initialHeight,
      active: owner.isActive(id),
      onInlineHeight: (height) => owner.acceptHeight(id, documentRevision, height),
      ...(stateHostId && stateThreadId && statePath
        ? {
            widgetState: createInlineVisualizationWidgetStateOwner({
              hostId: stateHostId,
              threadId: stateThreadId,
              path: statePath,
            }),
          }
        : {}),
      canExpand: () => callbacks.current.canExpand,
      onSubmitAnnotations: async (message) => owner.submitAnnotations(id, message),
      followUp: async (message: InlineVisualizationFollowUpMessage) => owner.followUp(id, message),
      reviewFollowUp: (message, signal) => callbacks.current.reviewFollowUp(message, signal),
    });
    surface.append(value.element);
    setRuntime(value);
    return owner.attachRuntime(id, value);
  }, [surface, scopeId, html, owner, id, documentRevision, stateHostId, stateThreadId, statePath]);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? subscribeNothing,
    runtime?.getSnapshot ?? readInitial,
    readInitial,
  );
  const expanded = snapshot.displayMode === "fullscreen";
  const nativeHeight =
    (expanded ? (snapshot.fullscreenHeight ?? snapshot.height) : snapshot.height) +
    INLINE_VISUALIZATION_PAINT_GUTTER;
  useLayoutEffect(() => {
    runtime?.setDisplayMode("inline");
  }, [runtime, canExpand]);
  useLayoutEffect(() => {
    if (!active) settleReview(null);
  }, [active, settleReview]);
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
  const copyAsImage = async () => {
    if (!runtime || !owner.isActive(id) || snapshot.status !== "ready") return;
    try {
      await runtime.copyAsImage();
      if (!owner.isActive(id)) return;
      toast.success("Response copied as image");
    } catch {
      if (!owner.isActive(id)) return;
      toast.danger("Unable to copy response as image");
    }
  };
  return (
    <div
      ref={setBoundary}
      data-inline-visualization="true"
      data-visualization-frame-id={id}
      data-visualization-active={active ? "true" : "false"}
      data-content-search-skip="true"
      data-visualization-status={snapshot.status}
      style={{ ...PAINT_STYLE, height: snapshot.height }}
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
              className={`group relative overflow-hidden rounded-lg ${expanded ? "w-full" : "-m-[var(--visualize-paint-gutter)] w-[calc(100%+var(--visualize-paint-gutter)*2)]"}`}
              style={{ height: nativeHeight }}
            >
              {snapshot.status === "ready" ? (
                <button
                  type="button"
                  aria-label="Copy as image"
                  className={`absolute ${canExpand && !expanded ? "right-12" : "right-2"} top-2 z-10 grid size-9 place-items-center rounded-md bg-token-main-surface-primary/90 text-token-text-secondary ${expanded ? "" : "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"}`}
                  onClick={() => {
                    void copyAsImage();
                  }}
                >
                  <CopyIcon className="size-4" />
                </button>
              ) : null}
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
              {runtime ? (
                <InlineVisualizationAnnotationControls owner={runtime.annotations} />
              ) : null}
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
