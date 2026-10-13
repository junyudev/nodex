import { useSyncExternalStore } from "react";
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
import { InlineVisualizationColorControl } from "./inline-visualization-color-control";
import { useInlineVisualizationInspectorPanel } from "./use-inline-visualization-inspector-panel";

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
      <InlineVisualizationColorControl
        label={control.label}
        value={String(value)}
        disabled={disabled}
        change={change}
      />
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
  const {
    setPanel,
    position,
    maximum,
    minimum,
    currentSize,
    style,
    headerProps,
    leftResizeProps,
    rightResizeProps,
    topResizeProps,
    topLeftResizeProps,
    topRightResizeProps,
  } = useInlineVisualizationInspectorPanel(snapshot.open && snapshot.visible);
  if (!snapshot.visible) return null;
  return (
    <div data-testid="visualization-annotation-ui" className="absolute bottom-2 right-2 z-10">
      <NodexPopover
        open={snapshot.open}
        modal={false}
        onOpenChange={(open, details) => {
          if (
            details.reason === "focus-out" ||
            (details.reason === "escape" &&
              details.event instanceof KeyboardEvent &&
              details.event.isComposing)
          ) {
            details.cancel();
            return;
          }
          if (open) owner.open();
          else owner.close();
        }}
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
          anchor={{
            getBoundingClientRect: () => new DOMRect(position.left, position.bottom, 0, 0),
          }}
          positionMethod="fixed"
          side="top"
          sideOffset={0}
          align="start"
          collisionPadding={0}
          arrowPadding={0}
          collisionAvoidance={{ side: "none", align: "none" }}
          aria-label="Design controls"
          initialFocus={false}
          finalFocus={() => document.activeElement === document.body}
          className="relative w-92 overflow-hidden p-0"
          style={style}
        >
          <header
            className="flex shrink-0 cursor-grab touch-none select-none items-center justify-between px-3 py-2 active:cursor-grabbing"
            {...headerProps}
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
                key={`${snapshot.selected!.registrationId}:${snapshot.selected!.targetId}:${control.callback}`}
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
          {(["left", "right"] as const).map((edge) => (
            <div
              key={edge}
              role="separator"
              tabIndex={0}
              aria-label="Resize design controls width"
              aria-orientation="vertical"
              aria-valuenow={currentSize.width}
              aria-valuemin={minimum.width}
              aria-valuemax={maximum.width}
              className={`absolute inset-y-2 w-1 touch-none cursor-ew-resize ${edge === "left" ? "left-0" : "right-0"}`}
              {...(edge === "left" ? leftResizeProps : rightResizeProps)}
            />
          ))}
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize design controls height"
            aria-orientation="horizontal"
            aria-valuenow={currentSize.height}
            aria-valuemin={minimum.height}
            aria-valuemax={maximum.height}
            className="absolute inset-x-2 top-0 h-1 touch-none cursor-ns-resize"
            {...topResizeProps}
          />
          {(["top-left", "top-right"] as const).map((edge) => (
            <div
              key={edge}
              aria-hidden="true"
              className={`absolute top-0 size-4 touch-none ${edge === "top-left" ? "left-0 cursor-nwse-resize" : "right-0 cursor-nesw-resize"}`}
              {...(edge === "top-left" ? topLeftResizeProps : topRightResizeProps)}
            />
          ))}
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}
