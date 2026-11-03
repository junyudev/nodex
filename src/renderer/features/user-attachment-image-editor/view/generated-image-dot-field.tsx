import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { useTheme } from "@/lib/use-theme";
import {
  createGeneratedImageDotFieldConfig,
  createStableGeneratedImageRandom,
  DOT_FIELD_FIRST_WEIGHT,
  DOT_FIELD_OPACITY_CUTOFF,
  DOT_FIELD_OPACITY_DURATION_MS,
  DOT_FIELD_OPACITY_POWER,
  DOT_FIELD_SECOND_WEIGHT,
  generatedImageDotFieldSmoothStep,
  resolveGeneratedImageDotFieldFrame,
  resolveGeneratedImageDotFieldGridSpacing,
  resolveGeneratedImageDotFieldPresentation,
  type GeneratedImageLoadingPresentation,
} from "../model/generated-image-loading-presentation";
import { getGeneratedImageAnimationClock } from "./generated-image-animation-clock";
import "./generated-image-dot-field.css";

interface DotFieldGrid {
  readonly dpr: number;
  readonly height: number;
  readonly spacing: number;
  readonly width: number;
  readonly xNormals: Float32Array;
  readonly xPositions: Float32Array;
  readonly yNormals: Float32Array;
  readonly yPositions: Float32Array;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const subscribeDocumentVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

function useElementIntersection(ref: RefObject<Element | null>): boolean {
  const [intersecting, setIntersecting] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      setIntersecting(entries[0]?.isIntersecting === true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return intersecting;
}

export function GeneratedImageDotField({
  active = true,
  presentation = "default",
  seed = "generated-image",
}: {
  active?: boolean;
  presentation?: GeneratedImageLoadingPresentation;
  seed?: string;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const { resolved: theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const configKey = `${presentation}:${seed}`;
  const config = createGeneratedImageDotFieldConfig(createStableGeneratedImageRandom(configKey));
  const dotPresentation = resolveGeneratedImageDotFieldPresentation(presentation);
  const clock = getGeneratedImageAnimationClock();
  const [mountedAt] = useState(() => clock.now());
  useLayoutEffect(() => {
    containerRef.current?.style.setProperty(
      "--generated-image-dot-field-delay",
      `${-(Math.max(0, clock.now() - mountedAt) % DOT_FIELD_OPACITY_DURATION_MS)}ms`,
    );
  });
  const documentVisible = useDocumentVisible();
  const intersecting = useElementIntersection(containerRef);
  const animationActive = active && intersecting && documentVisible && !reducedMotion;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!container || !canvas || !context) return;
    const fullCircle = Math.PI * 2;
    const color = getComputedStyle(container).color || (theme === "dark" ? "white" : "black");
    let lastFrameAt = 0;
    let grid: DotFieldGrid | null = null;
    let gridInvalidated = true;

    const rebuildGrid = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      if (width === 0 || height === 0) {
        grid = null;
        gridInvalidated = false;
        return;
      }
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const canvasWidth = Math.floor(width * dpr);
      const canvasHeight = Math.floor(height * dpr);
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      const spacing = resolveGeneratedImageDotFieldGridSpacing(presentation, dpr);
      const columnCount = Math.max(1, Math.floor(width / spacing));
      const rowCount = Math.max(1, Math.floor(height / spacing));
      const startX = (width - (columnCount - 1) * spacing) * 0.5;
      const startY = (height - (rowCount - 1) * spacing) * 0.5;
      const xPositions = new Float32Array(columnCount);
      const yPositions = new Float32Array(rowCount);
      const xNormals = new Float32Array(columnCount);
      const yNormals = new Float32Array(rowCount);
      for (let index = 0; index < columnCount; index += 1) {
        xPositions[index] = startX + index * spacing;
        xNormals[index] = columnCount === 1 ? 0.5 : index / (columnCount - 1);
      }
      for (let index = 0; index < rowCount; index += 1) {
        yPositions[index] = startY + index * spacing;
        yNormals[index] = rowCount === 1 ? 0.5 : index / (rowCount - 1);
      }
      grid = {
        dpr,
        height,
        spacing,
        width,
        xNormals,
        xPositions,
        yNormals,
        yPositions,
      };
      gridInvalidated = false;
    };

    const draw = (timestamp: number, force = false) => {
      if (!force && lastFrameAt !== 0 && timestamp - lastFrameAt < 1_000 / 30) {
        return;
      }
      lastFrameAt = timestamp;
      if (gridInvalidated || !grid) rebuildGrid();
      if (!grid) return;
      const frame = resolveGeneratedImageDotFieldFrame(
        reducedMotion ? 0 : timestamp - mountedAt,
        config,
      );
      context.save();
      context.setTransform(grid.dpr, 0, 0, grid.dpr, 0, 0);
      context.clearRect(0, 0, grid.width, grid.height);
      context.fillStyle = color;
      const radius =
        dotPresentation.radius ?? Math.max(0.55, grid.spacing * 0.5 * dotPresentation.radiusFactor);
      for (let rowIndex = 0; rowIndex < grid.yPositions.length; rowIndex += 1) {
        const y = grid.yPositions[rowIndex] ?? 0;
        const normalizedY = grid.yNormals[rowIndex] ?? 0;
        for (let columnIndex = 0; columnIndex < grid.xPositions.length; columnIndex += 1) {
          const x = grid.xPositions[columnIndex] ?? 0;
          const normalizedX = grid.xNormals[columnIndex] ?? 0;
          const firstDistance = Math.hypot(normalizedX - frame.firstX, normalizedY - frame.firstY);
          const secondDistance = Math.hypot(
            normalizedX - frame.secondX,
            normalizedY - frame.secondY,
          );
          const firstField = 1 - generatedImageDotFieldSmoothStep(firstDistance / frame.firstSize);
          const secondField =
            1 - generatedImageDotFieldSmoothStep(secondDistance / frame.secondSize);
          const opacity =
            clampUnit(
              firstField * DOT_FIELD_FIRST_WEIGHT + secondField * DOT_FIELD_SECOND_WEIGHT,
            ) ** DOT_FIELD_OPACITY_POWER;
          if (opacity <= DOT_FIELD_OPACITY_CUTOFF) continue;
          context.globalAlpha = opacity;
          context.beginPath();
          context.moveTo(x + radius, y);
          context.arc(x, y, radius, 0, fullCircle);
          context.fill();
        }
      }
      context.restore();
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            gridInvalidated = true;
            if (!animationActive) draw(clock.now(), true);
          });
    resizeObserver?.observe(container);
    draw(clock.now(), true);
    const unsubscribe = animationActive ? clock.subscribe(draw) : undefined;
    return () => {
      unsubscribe?.();
      resizeObserver?.disconnect();
    };
  }, [
    animationActive,
    clock,
    config,
    dotPresentation,
    mountedAt,
    presentation,
    reducedMotion,
    theme,
  ]);

  return (
    <div
      ref={containerRef}
      className="nodex-generated-image-dot-field absolute inset-0 overflow-hidden"
      data-animate={animationActive ? "true" : undefined}
      data-generated-image-dot-field="true"
      data-presentation={presentation}
      style={{
        maskImage: "linear-gradient(to top left, transparent 0%, black 30% 70%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to top left, transparent 0%, black 30% 70%, transparent 100%)",
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
    </div>
  );
}

export function GeneratedImagePlaceholder({ hidden, seed }: { hidden: boolean; seed: string }) {
  return (
    <div
      aria-busy="true"
      aria-hidden={hidden || undefined}
      aria-label={hidden ? undefined : "Generating image..."}
      aria-live={hidden ? undefined : "polite"}
      className="electron-dark:text-white/70 relative aspect-square w-full max-w-[400px] overflow-clip rounded-2xl bg-token-bg-tertiary/70 text-token-text-secondary dark:text-white/70"
      role={hidden ? undefined : "status"}
    >
      <GeneratedImageDotField active={!hidden} seed={seed} />
    </div>
  );
}
