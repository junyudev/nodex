import { Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isSpaceShortcut } from "./image-preview-shortcut";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

interface ImagePreviewDialogProps {
  open: boolean;
  source: string;
  alt: string;
  onOpenChange: (open: boolean) => void;
}

export function ImagePreviewDialog({
  open,
  source,
  alt,
  onOpenChange,
}: ImagePreviewDialogProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
  }, [open, source]);

  const zoomLabel = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom]);

  const zoomIn = useCallback(() => {
    setZoom((currentZoom) => clampZoom(currentZoom + ZOOM_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((currentZoom) => clampZoom(currentZoom - ZOOM_STEP));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (isSpaceShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          onOpenChange(false);
        }
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomIn();
        return;
      }

      if (event.key === "-") {
        event.preventDefault();
        zoomOut();
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onOpenChange, open, resetZoom, zoomIn, zoomOut]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-none bg-transparent p-0 shadow-none sm:max-w-none"
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        <div
          className="relative flex h-full w-full items-center justify-center bg-black/45 p-4"
          onClick={() => onOpenChange(false)}
        >
          <img
            src={source}
            alt={alt}
            className="max-h-[92vh] max-w-[96vw] rounded-lg object-contain transition-transform duration-150 ease-out select-none"
            style={{ transform: `scale(${zoom})` }}
            onClick={(event) => event.stopPropagation()}
          />
          <div
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md bg-black/62 p-1 text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20 hover:text-white"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (-)"
            >
              <Minus className="size-4" />
            </Button>
            <span className="min-w-14 text-center text-sm tabular-nums">
              {zoomLabel}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20 hover:text-white"
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              <Plus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20 hover:text-white"
              onClick={resetZoom}
              aria-label="Reset zoom"
              title="Reset zoom (0)"
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
