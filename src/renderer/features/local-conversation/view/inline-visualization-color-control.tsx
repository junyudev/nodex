import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Pipette } from "@/components/shared/icons/generic-icons";
import { motion, useReducedMotionConfig } from "motion/react";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  inspectorPickerColor,
  normalizeInspectorPopupHex,
} from "@/lib/inline-visualization/inline-visualization-inspector-geometry";

const AnimatedColorPopup = motion.create(NodexPopoverContent);

// Escaped underscores keep the library's documented selectors intact in arbitrary variants.
const COLOR_PICKER_CLASS = String.raw`h-auto! w-full! [&_.react-colorful\_\_saturation]:aspect-[16/9]! [&_.react-colorful\_\_saturation]:border! [&_.react-colorful\_\_saturation]:border-default! [&_.react-colorful\_\_saturation]:bg-clip-padding! [&_.react-colorful\_\_saturation]:shadow-none! [&_.react-colorful\_\_saturation]:shrink-0! [&_.react-colorful\_\_saturation]:rounded-md! [&_.react-colorful\_\_hue]:mt-3! [&_.react-colorful\_\_hue]:h-4.25! [&_.react-colorful\_\_hue]:mr-16! [&_.react-colorful\_\_hue]:mb-2! [&_.react-colorful\_\_pointer]:size-5.5! [&_.react-colorful\_\_pointer]:border-token-main-surface-primary! [&_.react-colorful\_\_hue]:rounded-full!`;
const COLLAPSED_PICKER_CLASS = String.raw`[&_.react-colorful\_\_hue]:hidden!`;

interface ColorControlProps {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly change: (value: string) => void;
}
type ScreenColorPicker = new () => {
  open(input: { signal: AbortSignal }): Promise<{ sRGBHex: string }>;
};
function screenColorPicker(): ScreenColorPicker | undefined {
  const candidate = (window as Window & { EyeDropper?: ScreenColorPicker }).EyeDropper;
  return typeof candidate === "function" ? candidate : undefined;
}

async function requestScreenColor(
  Picker: ScreenColorPicker,
  signal: AbortSignal,
): Promise<
  { readonly kind: "picked"; readonly value: string } | { readonly kind: "cancelled" | "failed" }
> {
  try {
    const result = await new Picker().open({ signal });
    return { kind: "picked", value: result.sRGBHex };
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
      return { kind: "cancelled" };
    return { kind: "failed" };
  }
}

function releaseColorPointer(ref: { current: { element: HTMLElement; pointerId: number } | null }) {
  const current = ref.current;
  ref.current = null;
  if (current?.element.hasPointerCapture?.(current.pointerId))
    current.element.releasePointerCapture(current.pointerId);
}
function cancelScreenPicker(ref: { current: AbortController | null }) {
  const current = ref.current;
  ref.current = null;
  current?.abort();
}

/** Inline edits preserve authored alpha; the popup's opaque picker previews through the same control. */
export function InlineVisualizationColorControl({
  label,
  value,
  disabled,
  change,
}: ColorControlProps) {
  const [open, setOpen] = useState(false);
  const [inlineDraft, setInlineDraft] = useState<{ base: string; text: string } | null>(null);
  const [hexDraft, setHexDraft] = useState<{ base: string; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState<{
    anchor: DOMRect;
    height: number;
    expandedHeight: number;
    dragging: boolean;
  } | null>(null);
  const reducedMotion = useReducedMotionConfig();
  const [screenError, setScreenError] = useState(false);
  const [screenActive, setScreenActive] = useState(false);
  const screenRequest = useRef<AbortController | null>(null);
  const capture = useRef<{ element: HTMLElement; pointerId: number } | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const opaque = inspectorPickerColor(value);
  const inlineText = inlineDraft?.base === value ? inlineDraft.text : value;
  const hexText = hexDraft?.base === value ? hexDraft.text : opaque;

  const [previousInput, setPreviousInput] = useState({ value, disabled, open });
  if (
    previousInput.value !== value ||
    previousInput.disabled !== disabled ||
    previousInput.open !== open
  ) {
    setPreviousInput({ value, disabled, open });
    if (previousInput.value !== value) {
      setInlineDraft(null);
      setHexDraft(null);
    }
    if (disabled || !open) {
      setCollapsed(null);
      setHexDraft(null);
      setScreenActive(false);
    }
  }
  if (disabled && open) setOpen(false);
  useEffect(() => {
    if (open && !disabled) return;
    cancelScreenPicker(screenRequest);
    releaseColorPointer(capture);
  }, [open, disabled]);
  useEffect(
    () => () => {
      cancelScreenPicker(screenRequest);
      releaseColorPointer(capture);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const stopDrag = () => {
      releaseColorPointer(capture);
      setCollapsed((previous) =>
        previous && !reducedMotion ? { ...previous, dragging: false } : null,
      );
    };
    window.addEventListener("blur", stopDrag);
    return () => window.removeEventListener("blur", stopDrag);
  }, [open, reducedMotion]);

  const commitHex = (text: string) => {
    const normalized = normalizeInspectorPopupHex(text);
    setHexDraft(null);
    if (normalized !== null && normalized !== opaque) change(normalized);
  };
  const endDrag = () => {
    releaseColorPointer(capture);
    setCollapsed((previous) =>
      previous && !reducedMotion ? { ...previous, dragging: false } : null,
    );
    setHexDraft(null);
  };
  const pickScreen = () => {
    const Picker = screenColorPicker();
    if (!Picker || disabled) return;
    cancelScreenPicker(screenRequest);
    const controller = new AbortController();
    screenRequest.current = controller;
    setScreenError(false);
    setScreenActive(true);
    void requestScreenColor(Picker, controller.signal).then((result) => {
      if (controller.signal.aborted || screenRequest.current !== controller) return;
      screenRequest.current = null;
      setScreenActive(false);
      if (result.kind === "picked") commitHex(result.value);
      else if (result.kind === "failed") setScreenError(true);
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate">{label}</span>
      <NodexPopover
        open={open}
        onOpenChange={(next, details) => {
          if (!next && screenRequest.current !== null && details.reason === "focus-out") {
            details.cancel();
            return;
          }
          setOpen(next);
        }}
      >
        <div className="flex h-7 w-32 min-w-0 items-center gap-2 rounded-md border border-default px-2 focus-within:ring-1 focus-within:ring-ring">
          <NodexPopoverTrigger>
            <button
              type="button"
              aria-label={`Choose ${label.toLowerCase()}`}
              disabled={disabled}
              className="size-5 shrink-0 rounded-md border border-default"
              style={{ backgroundColor: opaque }}
            />
          </NodexPopoverTrigger>
          <input
            type="text"
            aria-label={label}
            value={inlineText}
            disabled={disabled}
            spellCheck={false}
            maxLength={512}
            className="h-7 w-full min-w-0 bg-transparent font-mono text-xs outline-none"
            onChange={(event) => {
              const text = event.currentTarget.value;
              if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) {
                setInlineDraft({ base: value, text });
                return;
              }
              setInlineDraft(null);
              change(text);
            }}
            onBlur={() => setInlineDraft(null)}
          />
        </div>
        <AnimatedColorPopup
          ref={popup}
          align={collapsed ? "start" : "end"}
          anchor={collapsed ? { getBoundingClientRect: () => collapsed.anchor } : undefined}
          side="bottom"
          sideOffset={collapsed ? 0 : 4}
          arrowPadding={collapsed ? 0 : undefined}
          collisionAvoidance={collapsed ? { side: "none", align: "none" } : undefined}
          className="w-62 gap-3 p-2"
          style={collapsed ? { height: collapsed.expandedHeight, overflow: "hidden" } : undefined}
          initial={false}
          animate={{
            height: collapsed
              ? collapsed.dragging
                ? collapsed.height
                : collapsed.expandedHeight
              : "auto",
          }}
          transition={{ duration: reducedMotion ? 0 : 0.15, ease: [0.2, 0.8, 0.2, 1] }}
          onAnimationComplete={() =>
            setCollapsed((previous) => (previous?.dragging === false ? null : previous))
          }
        >
          <div className="relative">
            <div
              role="group"
              aria-label={label}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.isPrimary === false) return;
                releaseColorPointer(capture);
                capture.current = { element: event.currentTarget, pointerId: event.pointerId };
                event.currentTarget.setPointerCapture?.(event.pointerId);
                if (event.target instanceof Element && event.target.closest(".react-colorful__hue"))
                  return;
                const panel = popup.current;
                const saturation = event.currentTarget.querySelector<HTMLElement>(
                  ".react-colorful__saturation",
                );
                if (!panel || !saturation) return;
                const bounds = panel.getBoundingClientRect();
                const square = saturation.getBoundingClientRect();
                const scale = panel.offsetHeight > 0 ? bounds.height / panel.offsetHeight : 1;
                setCollapsed({
                  anchor: new DOMRect(bounds.left, bounds.top, bounds.width, 0),
                  height: (square.height + 2 * (square.left - bounds.left)) / scale,
                  expandedHeight: panel.offsetHeight,
                  dragging: true,
                });
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            >
              <HexColorPicker
                color={opaque}
                onChange={change}
                onChangeEnd={(next) => commitHex(next)}
                className={`${COLOR_PICKER_CLASS} ${collapsed?.dragging ? COLLAPSED_PICKER_CLASS : ""}`}
              />
            </div>
            <button
              type="button"
              aria-label="Pick color from screen"
              hidden={collapsed?.dragging === true}
              disabled={screenColorPicker() === undefined || screenActive}
              onClick={() => {
                void pickScreen();
              }}
              className="absolute right-0 bottom-0 grid h-7 w-12.5 place-items-center rounded-md border border-default text-secondary hover:bg-token-foreground/5 disabled:opacity-40"
            >
              <Pipette aria-hidden="true" className="size-4" />
            </button>
          </div>
          <label
            className="grid gap-1.5 text-xs text-secondary"
            hidden={collapsed?.dragging === true}
          >
            HEX
            <input
              aria-label={`${label} HEX`}
              value={hexText}
              disabled={disabled}
              spellCheck={false}
              className="h-7 min-w-0 rounded-md border border-default bg-transparent px-2 font-mono text-xs"
              onChange={(event) => setHexDraft({ base: value, text: event.currentTarget.value })}
              onBlur={() => commitHex(hexText)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") setHexDraft(null);
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          {screenError ? (
            <p role="alert" className="text-sm text-danger">
              Could not pick a screen color
            </p>
          ) : null}
        </AnimatedColorPopup>
      </NodexPopover>
    </div>
  );
}
