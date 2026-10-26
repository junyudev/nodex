import { dictationErrorMessage } from "@/features/dictation/dictation-errors";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckmarkIcon, DictationMicrophoneIcon, DeleteIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import type { ResponseTextAnnotation } from "../../../../shared/thread-text-selection";
import type { useThreadTextSelectionDraft } from "../thread-text-selection-draft";
import {
  readVisibleSelectionRect,
  readSelectionVisibleBounds,
  resolveResponseAnnotationRange,
} from "./thread-text-selection-dom";
import { useComposerDictation } from "./composer/use-composer-dictation";

type Controller = ReturnType<typeof useThreadTextSelectionDraft>;
interface LocatedAnnotation {
  annotation: ResponseTextAnnotation;
  index: number;
  rect: DOMRect;
  bounds: DOMRect;
  fallback?: boolean;
}

export function ResponseTextAnnotationLayer({
  root,
  controller,
}: {
  root: HTMLElement;
  controller: Controller;
}) {
  const [locations, setLocations] = useState<readonly LocatedAnnotation[]>([]);
  const highlightId = `response-annotation-${useId().replaceAll(":", "")}`;
  const { responseTextAnnotations: annotations, activeAnnotationId } = controller.draft;
  useEffect(() => {
    const annotation = annotations.find((entry) => entry.id === activeAnnotationId);
    if (!annotation) return;
    const range = resolveResponseAnnotationRange(root, annotation);
    const element =
      range?.startContainer instanceof Element
        ? range.startContainer
        : range?.startContainer.parentElement;
    if (
      !range ||
      !(element instanceof HTMLElement) ||
      readVisibleSelectionRect(
        range,
        element,
        root.querySelector('[data-thread-scroll-footer="true"]')?.getBoundingClientRect().top,
      )
    )
      return;
    element.scrollIntoView({ block: "center", behavior: "instant" });
  }, [activeAnnotationId, annotations, root]);
  useEffect(() => {
    if (annotations.length === 0) {
      setLocations((current) => (current.length ? [] : current));
      return;
    }
    let frame: number | null = null;
    const sheet = document.createElement("style");
    sheet.textContent = `::highlight(${highlightId}) { background-color: #128dff66; }`;
    document.head.append(sheet);
    const measure = () => {
      frame = null;
      const ranges: Range[] = [];
      const footerTop = root
        .querySelector('[data-thread-scroll-footer="true"]')
        ?.getBoundingClientRect().top;
      const next = annotations.flatMap((annotation, index): LocatedAnnotation[] => {
        const range = resolveResponseAnnotationRange(root, annotation);
        if (!range) return [];
        ranges.push(range);
        const element =
          range.commonAncestorContainer instanceof HTMLElement
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (!element) return [];
        const rect = readVisibleSelectionRect(range, element, footerTop);
        const bounds = readSelectionVisibleBounds(element, footerTop);
        return rect && bounds ? [{ annotation, index, rect, bounds }] : [];
      });
      // An unloaded or changed source must not make an authored comment impossible to edit.
      const unresolved = annotations.find(
        (entry) =>
          entry.id === activeAnnotationId &&
          !next.some(({ annotation }) => annotation.id === entry.id),
      );
      const viewport = root.getBoundingClientRect();
      if (unresolved && viewport.width > 16 && viewport.height > 0) {
        next.push({
          annotation: unresolved,
          index: annotations.indexOf(unresolved),
          rect: new DOMRect(
            viewport.left + viewport.width / 2,
            Math.min(footerTop ?? viewport.bottom, viewport.bottom),
            0,
            0,
          ),
          bounds: viewport,
          fallback: true,
        });
      }
      if (typeof Highlight !== "undefined")
        CSS.highlights.set(highlightId, new Highlight(...ranges));
      setLocations(next);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      globalThis.CSS?.highlights?.delete(highlightId);
      sheet.remove();
    };
  }, [annotations, activeAnnotationId, highlightId, root]);

  const active = locations.find(({ annotation }) => annotation.id === activeAnnotationId);
  return createPortal(
    <>
      {locations
        .filter((location) => !location.fallback)
        .map(({ annotation, index, rect }) => (
          <button
            key={annotation.id}
            type="button"
            aria-label={`Response annotation ${index + 1}`}
            data-response-text-annotation-id={annotation.id}
            className={`fixed size-[25px] origin-bottom-left rounded-[50%_50%_50%_3px] bg-background-info-solid p-0 font-sans text-[11px] font-bold text-white shadow-[0_0_0_1px_white] outline-hidden hover:scale-[1.08] focus-visible:ring-2 focus-visible:ring-ring ${APP_SHELL_FLOATING_UI_LAYER_CLASS}`}
            style={{ left: rect.right, top: rect.top - 12.5, transform: "translate(-50%, -50%)" }}
            onClick={() => controller.editAnnotation(annotation.id)}
          >
            {index + 1}
          </button>
        ))}
      {active ? (
        <AnnotationCommentEditor
          key={active.annotation.id}
          location={active}
          controller={controller}
        />
      ) : null}
    </>,
    document.body,
  );
}

function AnnotationCommentEditor({
  location,
  controller,
}: {
  location: LocatedAnnotation;
  controller: Controller;
}) {
  const { annotation, rect, bounds } = location;
  const [height, setHeight] = useState(43);
  const ref = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const beforeDictation = useRef("");
  const blurFrame = useRef<number | null>(null);
  const onDismiss = () => {
    if (
      dictation.isDictating ||
      dictation.isStarting ||
      dictation.isTranscribing ||
      (controller.draft.annotationMode === "create" && controller.draft.annotationDraft.trim())
    ) {
      input.current?.focus();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        ref.current?.animate(
          [{ translate: "0" }, { translate: "-3px" }, { translate: "3px" }, { translate: "0" }],
          { duration: 160 },
        );
      return;
    }
    controller.editAnnotation(null);
  };
  const dismissFromOutside = useEffectEvent(onDismiss);
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() =>
      setHeight(ref.current?.getBoundingClientRect().height ?? 43),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-response-text-annotation-id]")
      )
        return;
      dismissFromOutside();
    };
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("pointerdown", outside);
      if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current);
    };
  }, []);
  const insertTranscript = (text: string) => {
    controller.updateAnnotation(
      annotation.id,
      [beforeDictation.current, text].filter(Boolean).join(" "),
    );
    input.current?.focus();
  };
  const dictation = useComposerDictation({
    enabled: true,
    globalTarget: {
      id: `response-annotation:${annotation.id}`,
      priority: 20,
      admission: () => (input.current === document.activeElement ? null : "unavailable"),
    },
    transcript: {
      start: () => {
        beforeDictation.current = controller.draft.annotationDraft;
      },
      update: insertTranscript,
      preserve: () => {},
      cancel: () => controller.updateAnnotation(annotation.id, beforeDictation.current),
    },
    onTranscriptInsert: insertTranscript,
    onTranscriptAppend: insertTranscript,
    onTranscriptSend: (text) => {
      insertTranscript(text);
      controller.finishAnnotation(true);
    },
    onStartError: (error) => toast.danger(dictationErrorMessage(error)),
    onTranscribeError: (error) => toast.danger(dictationErrorMessage(error)),
    onUnsupported: () => toast.danger("Dictation is unavailable"),
  });
  const width = Math.min(294, bounds.width - 16);
  const left = Math.max(
    bounds.left + 8,
    Math.min(rect.left + rect.width / 2 - width / 2, bounds.right - 8 - width),
  );
  const overlapsMarker =
    !location.fallback && left < rect.right + 12.5 && left + width > rect.right - 12.5;
  const above = rect.top - (overlapsMarker ? 25 : 0) - height - 8;
  const top = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
  return (
    <form
      ref={ref}
      aria-label="Response annotation comment"
      className={`fixed flex max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-[22px] border border-default bg-surface-elevated-secondary font-sans shadow-sm ${APP_SHELL_FLOATING_UI_LAYER_CLASS}`}
      style={{ left, top, width }}
      onFocusCapture={() => {
        if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current);
        blurFrame.current = null;
      }}
      onBlurCapture={() => {
        if (blurFrame.current !== null) cancelAnimationFrame(blurFrame.current);
        blurFrame.current = requestAnimationFrame(() => {
          blurFrame.current = null;
          if (!ref.current?.isConnected || !document.hasFocus()) return;
          if (ref.current.contains(document.activeElement)) return;
          onDismiss();
        });
      }}
      onSubmit={(event) => {
        event.preventDefault();
        controller.finishAnnotation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          controller.escapeAnnotation();
        }
      }}
    >
      {controller.draft.annotationMode === "edit" ? (
        <div className="flex w-full items-start gap-2 border-b border-default px-4 py-3 text-sm">
          <p className="line-clamp-3 min-w-0 flex-1 text-tertiary">{annotation.text}</p>
          <button
            type="button"
            aria-label="Delete annotation"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-primary-ghost-hover"
            onClick={() => controller.removeAnnotation(annotation.id)}
          >
            <DeleteIcon className="icon-xs" />
          </button>
        </div>
      ) : null}
      <div className="flex w-full items-center gap-2 py-[7px] pr-2 pl-4">
        <textarea
          ref={input}
          aria-label="Note"
          rows={1}
          placeholder="Add an optional comment…"
          value={controller.draft.annotationDraft}
          className="max-h-40 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0 text-sm leading-6 [field-sizing:content] text-default outline-none placeholder:text-tertiary"
          onChange={(event) => {
            controller.updateAnnotation(annotation.id, event.target.value);
            event.target.style.height = "24px";
            event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            controller.finishAnnotation(event.metaKey || event.ctrlKey);
          }}
        />
        <button
          type="button"
          aria-label={dictation.isDictating ? "Stop dictation" : "Dictate"}
          disabled={dictation.isStarting || dictation.isTranscribing}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-default hover:bg-primary-ghost-hover disabled:opacity-40"
          onClick={() =>
            dictation.isDictating
              ? dictation.stopDictation("insert")
              : void dictation.startDictation()
          }
        >
          <DictationMicrophoneIcon className="icon-xs" />
        </button>
        <button
          type="submit"
          aria-label="Comment"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-solid text-primary-solid hover:opacity-80"
        >
          <CheckmarkIcon className="icon-xs" />
        </button>
      </div>
    </form>
  );
}
