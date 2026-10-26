import { getSelectedMessageText } from "./shared/message-clipboard";
import { useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import type { ThreadStageActions } from "../thread-stage-types";
import { useThreadTextSelectionDraft } from "../thread-text-selection-draft";
import {
  clampSelectionRange,
  createResponseTextAnnotation,
  readVisibleSelectionRect,
  resolveCommonSelectedTextTarget,
} from "./thread-text-selection-dom";
import { ResponseTextAnnotationLayer } from "./response-text-annotation-layer";

interface SelectedTextState {
  text: string;
  target: HTMLElement;
  range: Range;
  rect: DOMRect;
}

function readSelection(root: HTMLElement): SelectedTextState | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const target = resolveCommonSelectedTextTarget({
    rootElement: root,
    anchorNode: selection.anchorNode,
    focusNode: selection.focusNode,
    anchorOffset: selection.anchorOffset,
    focusOffset: selection.focusOffset,
  });
  if (!target) return null;
  const range = clampSelectionRange(selection.getRangeAt(0), target);
  const text = getSelectedMessageText(range);
  if (!text) return null;
  const footer = root.querySelector<HTMLElement>('[data-thread-scroll-footer="true"]');
  const rect = readVisibleSelectionRect(range, target, footer?.getBoundingClientRect().top);
  return rect ? { text, target, range, rect } : null;
}

/** Intrinsic width keeps the toolbar centered and clamped at every UI font size. */
export function selectionToolbarStyle(
  rect: Pick<DOMRect, "left" | "top" | "width">,
  viewportWidth: number,
): CSSProperties {
  const center = rect.left + rect.width / 2;
  return {
    left: center,
    top: rect.top - 8,
    maxWidth: viewportWidth - 16,
    transform: `translateX(clamp(${8 - center}px, -50%, calc(${viewportWidth - 8 - center}px - 100%))) translateY(-100%)`,
  };
}

export function SelectedTextActionsToolbar({
  style,
  containerRef,
  onAddToChat,
  onAskInSideChat,
}: {
  style: CSSProperties;
  containerRef?: Ref<HTMLDivElement>;
  onAddToChat?: () => void;
  onAskInSideChat?: () => void;
}) {
  const buttonClass =
    "no-drag flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap border border-transparent px-1.5 py-0 text-sm leading-[18px] text-default outline-hidden select-none hover:bg-primary-ghost-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0";
  return (
    <div
      ref={containerRef}
      data-selected-text-actions="true"
      className={`pointer-events-none fixed w-max ${APP_SHELL_FLOATING_UI_LAYER_CLASS}`}
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        role="presentation"
        className="pointer-events-auto flex w-fit max-w-full overflow-hidden rounded-lg border border-border/70 bg-surface-elevated-secondary font-sans shadow-lg"
        onMouseDown={(event) => event.preventDefault()}
      >
        {onAddToChat ? (
          <button type="button" className={buttonClass} onClick={onAddToChat}>
            Add to chat
          </button>
        ) : null}
        {onAddToChat && onAskInSideChat ? (
          <div aria-hidden="true" className="w-px shrink-0 self-stretch bg-border" />
        ) : null}
        {onAskInSideChat ? (
          <button type="button" className={buttonClass} onClick={onAskInSideChat}>
            Ask in side chat
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LocalConversationSelectedTextActions({
  enabled,
  hostId,
  threadId,
  scrollElement,
  onOpenSideChat,
}: {
  enabled: boolean;
  hostId?: string | null;
  threadId: string | null;
  scrollElement: HTMLElement | null;
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
}) {
  const [selection, setSelection] = useState<SelectedTextState | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const selections = useThreadTextSelectionDraft(hostId, threadId);

  useEffect(() => {
    if (!enabled || !scrollElement) return;
    let frame: number | null = null;
    let pointerDown = false;
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const measure = () => {
      cancel();
      if (pointerDown) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setSelection(readSelection(scrollElement));
      });
    };
    const down = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      pointerDown = true;
      cancel();
      setSelection(null);
    };
    const up = () => {
      pointerDown = false;
      measure();
    };
    measure();
    document.addEventListener("selectionchange", measure);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("dblclick", measure);
    window.addEventListener("keyup", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancel();
      document.removeEventListener("selectionchange", measure);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("dblclick", measure);
      window.removeEventListener("keyup", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [enabled, scrollElement, threadId]);

  const dismiss = () => {
    document.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  const canAnnotate = selection?.target.hasAttribute("data-response-annotation-target");
  return (
    <>
      {enabled && selection && (canAnnotate || onOpenSideChat)
        ? createPortal(
            <SelectedTextActionsToolbar
              containerRef={toolbarRef}
              style={selectionToolbarStyle(selection.rect, window.innerWidth)}
              onAddToChat={
                canAnnotate
                  ? () => {
                      const annotation = createResponseTextAnnotation(
                        selection.target,
                        selection.range,
                        selection.text,
                      );
                      dismiss();
                      if (annotation) selections.addAnnotation(annotation);
                    }
                  : undefined
              }
              onAskInSideChat={
                onOpenSideChat
                  ? () => {
                      const text = selection.text;
                      dismiss();
                      void onOpenSideChat({ kind: "selection", text });
                    }
                  : undefined
              }
            />,
            document.body,
          )
        : null}
      {enabled && scrollElement ? (
        <ResponseTextAnnotationLayer root={scrollElement} controller={selections} />
      ) : null}
    </>
  );
}
