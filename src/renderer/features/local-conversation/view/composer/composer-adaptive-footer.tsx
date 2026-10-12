import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ComposerAdaptiveLayout = "single-line" | "multiline";

const COMPOSER_FIT_TOLERANCE_PX = 0.5;

export function resolveComposerAdaptiveLayout({
  isFloatingComposer,
  hasAttachments,
  hasExplicitLineBreak,
  promptIntrinsicWidthPx,
  compactInputWidthPx,
  hasError,
  isDictating,
}: {
  isFloatingComposer: boolean;
  hasAttachments: boolean;
  hasExplicitLineBreak: boolean;
  promptIntrinsicWidthPx: number | null;
  compactInputWidthPx: number | null;
  hasError: boolean;
  isDictating: boolean;
}): ComposerAdaptiveLayout {
  if (!isFloatingComposer) return "multiline";
  if (hasAttachments || hasExplicitLineBreak || hasError || isDictating) {
    return "multiline";
  }
  if (
    promptIntrinsicWidthPx !== null &&
    compactInputWidthPx !== null &&
    promptIntrinsicWidthPx > compactInputWidthPx + COMPOSER_FIT_TOLERANCE_PX
  ) {
    return "multiline";
  }
  return "single-line";
}

interface ComposerInputProps {
  children: ReactNode;
  layout: ComposerAdaptiveLayout;
}

export function ComposerInput({ children, layout }: ComposerInputProps) {
  return (
    <div
      data-composer-input="true"
      className={layout === "single-line" ? "min-w-0" : "mb-1 flex-grow overflow-y-auto px-3"}
    >
      {children}
    </div>
  );
}

interface ComposerAdaptiveFooterProps {
  input: ReactNode;
  layout: ComposerAdaptiveLayout;
  leadingControls: ReactNode;
  trailingControls: ReactNode;
  onCompactInputWidthChange?: (widthPx: number | null) => void;
}

export function ComposerAdaptiveFooter({
  input,
  layout,
  leadingControls,
  trailingControls,
  onCompactInputWidthChange,
}: ComposerAdaptiveFooterProps) {
  const multiline = layout === "multiline";
  const row = multiline ? "controls" : "single-line";
  const footerRef = useRef<HTMLDivElement | null>(null);
  const leadingRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
  const compactChromeWidthPxRef = useRef<number | null>(null);
  const multilineControlsWidthPxRef = useRef<number | null>(null);

  const measureCompactInputWidth = useCallback(() => {
    if (!onCompactInputWidthChange) return;
    const footer = footerRef.current;
    const leading = leadingRef.current;
    const inputSlot = inputRef.current;
    const trailing = trailingRef.current;
    if (!footer || !leading || !inputSlot || !trailing) return;

    const footerWidthPx = footer.getBoundingClientRect().width;
    const leadingWidthPx = leading.getBoundingClientRect().width;
    const trailingWidthPx = trailing.getBoundingClientRect().width;
    if (footerWidthPx <= 0) return;

    if (!multiline) {
      const inputWidthPx = inputSlot.getBoundingClientRect().width;
      if (inputWidthPx <= 0) return;
      compactChromeWidthPxRef.current = Math.max(0, footerWidthPx - inputWidthPx);
      multilineControlsWidthPxRef.current = null;
      onCompactInputWidthChange(inputWidthPx);
      return;
    }

    const compactChromeWidthPx = compactChromeWidthPxRef.current;
    if (compactChromeWidthPx === null) return;
    const multilineControlsWidthPx = leadingWidthPx + trailingWidthPx;
    const previousControlsWidthPx = multilineControlsWidthPxRef.current;
    multilineControlsWidthPxRef.current = multilineControlsWidthPx;
    if (
      previousControlsWidthPx !== null &&
      Math.abs(previousControlsWidthPx - multilineControlsWidthPx) > COMPOSER_FIT_TOLERANCE_PX
    ) {
      onCompactInputWidthChange(null);
      return;
    }
    onCompactInputWidthChange(Math.max(0, footerWidthPx - compactChromeWidthPx));
  }, [multiline, onCompactInputWidthChange]);

  useLayoutEffect(() => {
    if (!onCompactInputWidthChange) return undefined;
    measureCompactInputWidth();

    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measureCompactInputWidth();
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureCompactInputWidth);
      return () => {
        active = false;
        window.removeEventListener("resize", measureCompactInputWidth);
      };
    }

    const observer = new ResizeObserver(measureCompactInputWidth);
    const elements = [footerRef.current, leadingRef.current, inputRef.current, trailingRef.current];
    for (const element of elements) {
      if (element) observer.observe(element);
    }
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [measureCompactInputWidth, onCompactInputWidthChange]);

  return (
    <div
      ref={footerRef}
      data-composer-form-footer="true"
      data-composer-layout={layout}
      className={cn(
        "composer-footer grid items-center select-none",
        multiline
          ? "mb-2 grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] gap-x-[5px] px-2"
          : "grid-cols-[auto_minmax(0,1fr)_auto] gap-2 px-2 py-1",
      )}
    >
      <div
        ref={leadingRef}
        data-composer-footer-leading="true"
        data-composer-footer-row={row}
        className={cn("min-w-0", multiline && "col-start-1 row-start-2")}
      >
        {leadingControls}
      </div>
      <div
        ref={inputRef}
        data-composer-input-slot="true"
        data-composer-footer-row={multiline ? "prompt" : row}
        className={cn("min-w-0", multiline && "col-span-full row-start-1 -mx-2")}
      >
        {input}
      </div>
      <div
        ref={trailingRef}
        data-composer-footer-trailing="true"
        data-composer-footer-row={row}
        className={cn("min-w-0", multiline && "col-start-3 row-start-2")}
      >
        {trailingControls}
      </div>
    </div>
  );
}
