import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CloseIcon,
  ImageRedoIcon,
  ImageRemoveBrushTrackShape,
  ImageUndoIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexSlider, NodexSliderThumb, NodexSliderTrack } from "@/components/ui/slider";
import { normalizeImagePoint } from "../model/image-geometry";
import {
  appendRemoveStrokePoint,
  buildRemoveMaskDrawingPlan,
  canSubmitRemoveMask,
  commitRemoveStroke,
  computeRemoveBrushCssPixels,
  computeRemoveBrushNaturalPixels,
  createRemoveHistory,
  createRemoveStroke,
  IMAGE_REMOVE_BRUSH_DEFAULT,
  IMAGE_REMOVE_BRUSH_MAX,
  IMAGE_REMOVE_BRUSH_MIN,
  IMAGE_REMOVE_BRUSH_STEP,
  redoRemoveStroke,
  undoRemoveStroke,
} from "../model/remove-mask";
import type { ImagePoint, ImageSize, RemoveHistory, RemoveStroke } from "../model/types";
import type { ImageReferrerPolicy } from "@/lib/content-image";
import { ImageEditorToolbarPill } from "./image-editor-toolbar";

export interface ImageRemoveEditorProps {
  alt: string;
  isSubmitting?: boolean;
  referrerPolicy?: ImageReferrerPolicy;
  src: string;
  onCancel: () => void;
  onSubmit: (maskDataUrl: string) => void | Promise<void>;
}

function drawStrokeSegment(
  canvas: HTMLCanvasElement,
  naturalImageSize: ImageSize,
  from: ImagePoint,
  to: ImagePoint,
  brushSize: number,
  color: string,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const fromX = from.x * naturalImageSize.width;
  const fromY = from.y * naturalImageSize.height;
  const toX = to.x * naturalImageSize.width;
  const toY = to.y * naturalImageSize.height;
  const lineWidth = computeRemoveBrushNaturalPixels({ brushSize, naturalImageSize });
  if (fromX === toX && fromY === toY) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(fromX, fromY, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.strokeStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(toX, toY);
  context.stroke();
}

function repaintSelectionCanvas(
  canvas: HTMLCanvasElement,
  naturalImageSize: ImageSize,
  strokes: readonly RemoveStroke[],
) {
  canvas.width = naturalImageSize.width;
  canvas.height = naturalImageSize.height;
  const color = getComputedStyle(canvas).color;
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.points.length; index += 1) {
      const to = stroke.points[index];
      if (!to) continue;
      drawStrokeSegment(
        canvas,
        naturalImageSize,
        stroke.points[index - 1] ?? to,
        to,
        stroke.brushSize,
        color,
      );
    }
  }
}

function rasterizeRemoveMask(
  naturalImageSize: ImageSize,
  strokes: readonly RemoveStroke[],
): string {
  const plan = buildRemoveMaskDrawingPlan({ naturalImageSize, strokes });
  if (!plan) return "";
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = plan.background;
  context.fillRect(0, 0, plan.width, plan.height);
  context.fillStyle = plan.strokeColor;
  context.strokeStyle = plan.strokeColor;
  for (const command of plan.commands) {
    if (command.kind === "circle") {
      context.beginPath();
      context.arc(command.center.x, command.center.y, command.diameter / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineCap = command.lineCap;
    context.lineJoin = command.lineJoin;
    context.lineWidth = command.lineWidth;
    context.beginPath();
    context.moveTo(command.from.x, command.from.y);
    context.lineTo(command.to.x, command.to.y);
    context.stroke();
  }
  return canvas.toDataURL(plan.mimeType);
}

function pointFromCanvasEvent(event: ReactPointerEvent<HTMLCanvasElement>): ImagePoint | null {
  const rect = event.currentTarget.getBoundingClientRect();
  return normalizeImagePoint({
    clientPoint: { x: event.clientX, y: event.clientY },
    rect: {
      height: rect.height,
      left: rect.left,
      top: rect.top,
      width: rect.width,
    },
  });
}

export function ImageRemoveEditor({
  alt,
  isSubmitting = false,
  referrerPolicy,
  src,
  onCancel,
  onSubmit,
}: ImageRemoveEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const activeStrokeRef = useRef<RemoveStroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [naturalImageSize, setNaturalImageSize] = useState<ImageSize | null>(null);
  const [brushSize, setBrushSize] = useState(IMAGE_REMOVE_BRUSH_DEFAULT);
  const [history, setHistory] = useState<RemoveHistory>(createRemoveHistory);
  const hasHistory = history.committed.length > 0 || history.redo.length > 0;
  const canSubmit = canSubmitRemoveMask({ history, isLoading: isSubmitting, naturalImageSize });

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalImageSize) return;
    repaintSelectionCanvas(canvas, naturalImageSize, history.committed);
  }, [history, naturalImageSize]);

  const hideCursor = () => {
    if (cursorRef.current) cursorRef.current.style.display = "none";
  };

  const updateCursor = (canvas: HTMLCanvasElement, point: ImagePoint | null) => {
    const cursor = cursorRef.current;
    if (!cursor || !point || !naturalImageSize) {
      hideCursor();
      return;
    }
    const displayedImageWidth = canvas.getBoundingClientRect().width;
    const size = computeRemoveBrushCssPixels({
      brushSize,
      displayedImageWidth,
      naturalImageSize,
    });
    cursor.style.display = "block";
    cursor.style.height = `${size}px`;
    cursor.style.left = `${point.x * 100}%`;
    cursor.style.top = `${point.y * 100}%`;
    cursor.style.width = `${size}px`;
  };

  const releasePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="flex h-0 min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-center px-4 pt-2">
        <ImageEditorToolbarPill>
          {!hasHistory ? (
            <span className="min-w-0 truncate px-1.5 text-base leading-[18px] text-token-text-tertiary">
              Brush over what you want to remove
            </span>
          ) : null}
          {hasHistory ? (
            <>
              <NodexButton
                variant="ghost"
                size="icon-xs"
                aria-label="Undo"
                disabled={history.committed.length === 0}
                className="!size-7 rounded-full"
                onClick={() => setHistory(undoRemoveStroke)}
              >
                <ImageUndoIcon aria-hidden="true" className="icon-xs" />
              </NodexButton>
              <NodexButton
                variant="ghost"
                size="icon-xs"
                aria-label="Redo"
                disabled={history.redo.length === 0}
                className="!size-7 rounded-full"
                onClick={() => setHistory(redoRemoveStroke)}
              >
                <ImageRedoIcon aria-hidden="true" className="icon-xs" />
              </NodexButton>
            </>
          ) : null}
          <NodexButton
            variant="accentAction"
            size="composer"
            disabled={!canSubmit}
            aria-busy={isSubmitting || undefined}
            className="!h-token-button-composer-sm !px-2 !text-base"
            onClick={() => {
              if (!naturalImageSize || history.committed.length === 0) return;
              const mask = rasterizeRemoveMask(naturalImageSize, history.committed);
              if (mask.length > 0) void onSubmit(mask);
            }}
          >
            Send
          </NodexButton>
          <NodexButton
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel"
            className="!size-7 rounded-full text-token-text-tertiary"
            onClick={onCancel}
          >
            <CloseIcon aria-hidden="true" className="icon-2xs" />
          </NodexButton>
        </ImageEditorToolbarPill>
      </div>
      <div className="[container-type:size] relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 ps-14">
        <div className="relative max-h-[100cqh] max-w-full">
          <img
            ref={imageRef}
            alt={alt}
            className="block max-h-[100cqh] max-w-full rounded-xl object-contain"
            referrerPolicy={referrerPolicy}
            src={src}
            onLoad={(event) => {
              const { naturalHeight, naturalWidth } = event.currentTarget;
              if (naturalHeight <= 0 || naturalWidth <= 0) return;
              setNaturalImageSize({ height: naturalHeight, width: naturalWidth });
            }}
          />
          {naturalImageSize ? (
            <canvas
              ref={canvasRef}
              aria-label="Mark areas to remove"
              className="absolute inset-0 h-full w-full cursor-none touch-none rounded-xl text-token-image-remove-brush opacity-50"
              height={naturalImageSize.height}
              width={naturalImageSize.width}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const point = pointFromCanvasEvent(event);
                if (!point) return;
                updateCursor(event.currentTarget, point);
                const stroke = createRemoveStroke({ brushSize, point });
                activeStrokeRef.current = stroke;
                activePointerIdRef.current = event.pointerId;
                event.currentTarget.setPointerCapture(event.pointerId);
                drawStrokeSegment(
                  event.currentTarget,
                  naturalImageSize,
                  point,
                  point,
                  brushSize,
                  getComputedStyle(event.currentTarget).color,
                );
              }}
              onPointerMove={(event) => {
                const point = pointFromCanvasEvent(event);
                updateCursor(event.currentTarget, point);
                const stroke = activeStrokeRef.current;
                if (!stroke || !point || activePointerIdRef.current !== event.pointerId) return;
                const previousPoint = stroke.points.at(-1);
                if (!previousPoint) return;
                const nextStroke = appendRemoveStrokePoint(stroke, point);
                activeStrokeRef.current = nextStroke;
                drawStrokeSegment(
                  event.currentTarget,
                  naturalImageSize,
                  previousPoint,
                  point,
                  nextStroke.brushSize,
                  getComputedStyle(event.currentTarget).color,
                );
              }}
              onPointerUp={(event) => {
                const stroke = activeStrokeRef.current;
                activeStrokeRef.current = null;
                releasePointer(event);
                if (stroke) setHistory((current) => commitRemoveStroke(current, stroke));
              }}
              onPointerCancel={(event) => {
                activeStrokeRef.current = null;
                releasePointer(event);
                repaintSelectionCanvas(event.currentTarget, naturalImageSize, history.committed);
              }}
              onPointerLeave={hideCursor}
            />
          ) : null}
          <div
            ref={cursorRef}
            aria-hidden="true"
            className="pointer-events-none absolute hidden -translate-x-1/2 -translate-y-1/2 rounded-full bg-token-foreground/20"
          />
        </div>
        <div className="absolute top-1/2 left-4 flex -translate-y-1/2 items-center">
          <NodexSlider
            className="relative flex h-40 w-5 touch-none items-center justify-center select-none"
            max={IMAGE_REMOVE_BRUSH_MAX}
            min={IMAGE_REMOVE_BRUSH_MIN}
            orientation="vertical"
            step={IMAGE_REMOVE_BRUSH_STEP}
            value={[brushSize]}
            onValueChange={(value) => {
              const nextBrushSize = typeof value === "number" ? value : value[0];
              if (nextBrushSize === undefined) return;
              hideCursor();
              setBrushSize(nextBrushSize);
            }}
          >
            <NodexSliderTrack className="relative h-full w-3 overflow-visible bg-transparent text-token-foreground/30">
              <ImageRemoveBrushTrackShape className="absolute inset-0 h-full w-full" />
              <NodexSliderThumb
                aria-label="Brush size"
                className="block h-4 w-4 cursor-interaction rounded-full border border-token-border bg-token-editor-background shadow-md focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
              />
            </NodexSliderTrack>
          </NodexSlider>
        </div>
      </div>
    </div>
  );
}
