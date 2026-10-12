import { useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import {
  NodexSlider,
  NodexSliderRange,
  NodexSliderThumb,
  NodexSliderTrack,
} from "@/components/ui/slider";
import { CloseIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import type {
  VisualizationAnnotationControl,
  VisualizationAnnotationValue,
} from "../../../../shared/codex-visualization-annotations";
import type { InlineVisualizationAnnotations } from "../../../lib/inline-visualization/inline-visualization-annotations";

function AnnotationControl({
  control,
  value,
  disabled,
  change,
}: {
  control: VisualizationAnnotationControl;
  value: VisualizationAnnotationValue;
  disabled: boolean;
  change: (value: unknown) => void;
}) {
  const [colorText, setColorText] = useState(String(value));
  const previousColor = useRef(value);
  if (previousColor.current !== value) {
    previousColor.current = value;
    setColorText(String(value));
  }
  if (control.type === "toggle")
    return (
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">{control.label}</span>
        <input
          type="checkbox"
          aria-label={control.label}
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => change(event.target.checked)}
        />
      </label>
    );
  if (control.type === "select")
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">{control.label}</span>
        <NodexOptionPicker
          search="none"
          value={String(value)}
          options={control.options}
          disabled={disabled}
          onValueChange={change}
          triggerButton={
            <button
              type="button"
              aria-label={control.label}
              className="truncate rounded-md px-2 py-1 hover:bg-token-foreground/5"
            >
              {control.options.find((option) => option.value === value)?.label}
            </button>
          }
        />
      </div>
    );
  if (control.type === "color")
    return (
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">{control.label}</span>
        <input
          type="text"
          aria-label={control.label}
          value={colorText}
          disabled={disabled}
          className="w-24 rounded-md bg-transparent px-2 py-1 font-mono text-xs ring-[0.5px] ring-token-border"
          onChange={(event) => {
            setColorText(event.target.value);
            change(event.target.value);
          }}
          onBlur={() => setColorText(String(value))}
        />
      </label>
    );
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">{control.label}</span>
        <output className="text-xs tabular-nums text-token-text-secondary">{String(value)}</output>
      </div>
      <NodexSlider
        min={control.min}
        max={control.max}
        step={control.step}
        value={Number(value)}
        disabled={disabled}
        onValueChange={(next) => change(Array.isArray(next) ? next[0] : next)}
      >
        <NodexSliderTrack>
          <NodexSliderRange />
        </NodexSliderTrack>
        <NodexSliderThumb aria-label={control.label} />
      </NodexSlider>
    </div>
  );
}

/** Host controls remain nonmodal; choosing an authored target previews its object bindings in the same guest. */
export function InlineVisualizationAnnotationControls({
  owner,
}: {
  readonly owner: InlineVisualizationAnnotations;
}) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const initialSize = useRef<{ width: number; height: number } | null>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    rect: DOMRect;
    offset: typeof offset;
    kind: "move" | "width" | "height";
  } | null>(null);
  const begin = (event: PointerEvent<HTMLElement>, kind: "move" | "width" | "height") => {
    if (
      !panel ||
      event.button !== 0 ||
      (kind === "move" && (event.target as Element).closest("button"))
    )
      return;
    const rect = panel.getBoundingClientRect();
    initialSize.current ??= { width: rect.width, height: rect.height };
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect,
      offset,
      kind,
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    if (current.kind === "move") {
      const x = Math.max(8, Math.min(innerWidth - current.rect.width - 8, current.rect.left + dx));
      const y = Math.max(0, Math.min(innerHeight - current.rect.height - 8, current.rect.top + dy));
      setOffset({
        x: current.offset.x + x - current.rect.left,
        y: current.offset.y + y - current.rect.top,
      });
      return;
    }
    setSize({
      width:
        current.kind === "width"
          ? Math.max(
              Math.min(initialSize.current!.width, innerWidth - 16),
              Math.min(innerWidth - 16, current.rect.width + dx),
            )
          : current.rect.width,
      height:
        current.kind === "height"
          ? Math.max(
              Math.min(initialSize.current!.height, innerHeight - 16),
              Math.min(innerHeight - 16, current.rect.height + dy),
            )
          : current.rect.height,
    });
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!snapshot.visible) return null;
  return (
    <div data-testid="visualization-annotation-ui" className="absolute bottom-2 right-2 z-10">
      <NodexPopover
        open={snapshot.open}
        modal={false}
        onOpenChange={(open) => (open ? owner.open() : owner.close())}
      >
        <NodexPopoverTrigger>
          <button
            type="button"
            className="rounded-full bg-token-main-surface-primary/90 px-3 py-1 text-xs text-token-text-secondary shadow-sm"
          >
            Adjust visualization
          </button>
        </NodexPopoverTrigger>
        <NodexPopoverContent
          ref={setPanel}
          side="top"
          align="end"
          aria-label="Design controls"
          initialFocus={false}
          className="relative w-80 overflow-hidden p-0"
          style={{ translate: `${offset.x}px ${offset.y}px`, ...(size ?? {}) }}
        >
          <header
            className="flex shrink-0 cursor-move items-center justify-between px-3 py-2"
            onPointerDown={(event) => begin(event, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <span className="text-sm text-token-text-secondary">Design controls</span>
            <button
              type="button"
              aria-label="Close design controls"
              className="grid size-6 place-items-center rounded-md hover:bg-token-foreground/5"
              onClick={owner.close}
            >
              <CloseIcon className="size-3" />
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-3">
            {snapshot.rows.filter((row) => row.visible).length > 1 ? (
              <NodexOptionPicker
                search="none"
                value={JSON.stringify([
                  snapshot.selected?.registrationId,
                  snapshot.selected?.targetId,
                ])}
                options={snapshot.rows
                  .filter((row) => row.visible)
                  .map((row) => ({
                    value: JSON.stringify([row.registrationId, row.targetId]),
                    label: row.label,
                  }))}
                onValueChange={(value) => {
                  const [registrationId, targetId] = JSON.parse(value) as [string, string];
                  owner.select(registrationId, targetId);
                }}
                triggerButton={
                  <button
                    type="button"
                    aria-label="Visualization component"
                    className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-token-foreground/5"
                  >
                    {snapshot.selected?.label}
                  </button>
                }
              />
            ) : null}
            {snapshot.selected?.controls.controls.map((control) => (
              <AnnotationControl
                key={`${snapshot.selected!.registrationId}:${control.callback}`}
                control={control}
                value={
                  snapshot.selected!.changes.find((change) => change.callback === control.callback)!
                    .value
                }
                disabled={snapshot.submitting}
                change={(value) => owner.change(control.callback, value)}
              />
            ))}
            <button
              type="button"
              disabled={snapshot.submitting || !snapshot.hasEdits}
              className="text-xs text-token-text-secondary disabled:opacity-40"
              onClick={owner.reset}
            >
              Reset all
            </button>
            <textarea
              aria-label="Request changes"
              value={snapshot.body}
              disabled={snapshot.submitting}
              onChange={(event) => owner.setBody(event.target.value)}
              className="min-h-16 w-full resize-none rounded-md bg-transparent px-2 py-1 text-sm ring-[0.5px] ring-token-border"
            />
          </div>
          <footer className="flex shrink-0 justify-end px-3 pb-3">
            <button
              type="button"
              disabled={
                !snapshot.canSubmit ||
                snapshot.submitting ||
                (!snapshot.hasEdits && !snapshot.body.trim())
              }
              className="rounded-full bg-token-foreground px-3 py-1 text-xs text-token-main-surface-primary disabled:opacity-40"
              onClick={() => {
                void owner.submit().catch(() => toast.danger("Unable to send changes"));
              }}
            >
              Send changes
            </button>
          </footer>
          <button
            type="button"
            aria-label="Resize design controls width"
            className="absolute inset-y-2 right-0 w-1 cursor-ew-resize"
            onPointerDown={(event) => begin(event, "width")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={() => setSize(null)}
          />
          <button
            type="button"
            aria-label="Resize design controls height"
            className="absolute inset-x-2 bottom-0 h-1 cursor-ns-resize"
            onPointerDown={(event) => begin(event, "height")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={() => setSize(null)}
          />
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}
