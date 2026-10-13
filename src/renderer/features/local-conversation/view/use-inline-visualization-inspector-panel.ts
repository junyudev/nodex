import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  clampInspectorPosition,
  inspectorBoundsOverlap,
  inspectorKeyboardSize,
  inspectorMaximumSize,
  inspectorTopInset,
  placeInspector,
  resizeInspector,
  type InspectorBounds,
  type InspectorPosition,
  type InspectorResizeEdge,
  type InspectorSize,
} from "@/lib/inline-visualization/inline-visualization-inspector-geometry";

const readViewport = () => `${window.innerWidth}:${window.innerHeight}`;
const subscribeViewport = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
const noSubscription = () => () => {};
function obstacles(): InspectorBounds[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-pip-obstacle="quick-chat"]'))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}
interface Measurement {
  readonly bounds: InspectorBounds;
  readonly initial: InspectorSize;
  readonly current: InspectorSize;
  readonly scale: number;
}
interface Geometry {
  readonly position: InspectorPosition | null;
  readonly size: InspectorSize | null;
}
interface Gesture {
  readonly pointerId: number;
  readonly element: HTMLElement;
  readonly x: number;
  readonly y: number;
  readonly bounds: InspectorBounds;
  readonly scale: number;
  readonly initial: InspectorSize;
  readonly kind: "move" | InspectorResizeEdge;
  last: Geometry | null;
}
function releaseGesture(ref: { current: Gesture | null }) {
  const gesture = ref.current;
  ref.current = null;
  if (gesture?.element.hasPointerCapture?.(gesture.pointerId))
    gesture.element.releasePointerCapture(gesture.pointerId);
}

/** The floating panel owns geometry only; document declarations and drafts stay in the annotation owner. */
export function useInlineVisualizationInspectorPanel(open: boolean) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [geometry, setGeometry] = useState<Geometry>({ position: null, size: null });
  const gesture = useRef<Gesture | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setGeometry((previous) => ({ ...previous, position: null }));
  }
  const dimensions = useSyncExternalStore(
    open ? subscribeViewport : noSubscription,
    readViewport,
    () => "0:0",
  );
  const [width, height] = dimensions.split(":").map(Number);
  const viewport = { width: width!, height: height!, scale: measurement?.scale ?? 1 };
  const maximum = inspectorMaximumSize(viewport);
  const current = geometry.size ?? measurement?.current ?? { width: 0, height: 0 };
  const minimum = {
    width: Math.min(measurement?.initial.width ?? 0, maximum.width),
    height: Math.min(measurement?.initial.height ?? 0, maximum.height),
  };

  useEffect(() => {
    if (open) return;
    releaseGesture(gesture);
  }, [open]);
  useEffect(() => () => releaseGesture(gesture), []);
  useEffect(() => {
    if (!open || !panel) return;
    const measure = (entry?: ResizeObserverEntry) => {
      const bounds = panel.getBoundingClientRect();
      if (!(bounds.width > 0 && bounds.height > 0)) return;
      const scale = panel.offsetWidth > 0 ? bounds.width / panel.offsetWidth : 1;
      const border = Array.isArray(entry?.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry?.borderBoxSize;
      const current = border
        ? { width: border.inlineSize, height: border.blockSize }
        : { width: bounds.width / scale, height: bounds.height / scale };
      setMeasurement((previous) =>
        previous !== null &&
        previous.current.width === current.width &&
        previous.current.height === current.height &&
        previous.scale === scale
          ? previous
          : { bounds, current, initial: previous?.initial ?? current, scale },
      );
    };
    measure();
    const observer = new ResizeObserver((entries) => measure(entries[0]));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, panel]);

  useEffect(() => {
    if (!open || !panel || !measurement) return;
    const [width, height] = dimensions.split(":").map(Number);
    const viewport = { width: width!, height: height!, scale: measurement.scale };
    const frame = requestAnimationFrame(() => {
      if (
        gesture.current !== null ||
        !panel.isConnected ||
        getComputedStyle(panel).visibility === "hidden"
      )
        return;
      const bounds = panel.getBoundingClientRect();
      if (!(bounds.width > 0 && bounds.height > 0)) return;
      const blocked =
        bounds.left < 8 ||
        bounds.top < inspectorTopInset(viewport) ||
        bounds.left + bounds.width > viewport.width - 8 ||
        bounds.top + bounds.height > viewport.height - 8 ||
        obstacles().some((obstacle) => inspectorBoundsOverlap(bounds, obstacle));
      if (geometry.position !== null && !blocked) return;
      const position = placeInspector(
        bounds,
        viewport,
        obstacles(),
        geometry.position === null ? "default" : "nearest",
      );
      setGeometry((previous) =>
        previous.position?.left === position.left && previous.position.bottom === position.bottom
          ? previous
          : { ...previous, position },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [open, panel, measurement, dimensions, geometry.position]);

  const bounds = {
    left: measurement?.bounds.left ?? 0,
    top: measurement?.bounds.top ?? 0,
    width: Math.min(current.width, maximum.width) * viewport.scale,
    height: Math.min(current.height, maximum.height) * viewport.scale,
  };
  const requested = geometry.position ?? placeInspector(bounds, viewport, [], "default");
  const position = clampInspectorPosition(requested, bounds, viewport);

  const begin = (event: PointerEvent<HTMLElement>, kind: Gesture["kind"]) => {
    if (
      !panel ||
      !measurement ||
      event.button !== 0 ||
      event.isPrimary === false ||
      gesture.current !== null
    )
      return;
    if (kind === "move" && event.target instanceof Element && event.target.closest("button"))
      return;
    gesture.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      bounds: panel.getBoundingClientRect(),
      initial: minimum,
      scale: viewport.scale,
      kind,
      last: null,
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const captured = gesture.current;
    if (!captured || captured.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - captured.x,
      dy = event.clientY - captured.y;
    if (captured.kind === "move") {
      captured.last = {
        position: clampInspectorPosition(
          {
            left: captured.bounds.left + dx,
            bottom: captured.bounds.top + captured.bounds.height + dy,
          },
          captured.bounds,
          viewport,
        ),
        size: {
          width: captured.bounds.width / captured.scale,
          height: captured.bounds.height / captured.scale,
        },
      };
    } else {
      const desired = {
        width: captured.bounds.width / captured.scale,
        height: captured.bounds.height / captured.scale,
      };
      if (captured.kind !== "top")
        desired.width = Math.max(
          captured.initial.width,
          Math.min(
            maximum.width,
            desired.width + (dx / captured.scale) * (captured.kind.includes("left") ? -1 : 1),
          ),
        );
      if (captured.kind.startsWith("top"))
        desired.height = Math.max(
          captured.initial.height,
          Math.min(maximum.height, desired.height - dy / captured.scale),
        );
      captured.last = resizeInspector(captured.bounds, desired, captured.kind, viewport);
    }
    setGeometry(captured.last);
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    const captured = gesture.current;
    if (!captured || captured.pointerId !== event.pointerId) return;
    const last = captured.last;
    releaseGesture(gesture);
    if (!last?.position || !last.size) return;
    const physical = {
      left: last.position.left,
      top: last.position.bottom - last.size.height * captured.scale,
      width: last.size.width * captured.scale,
      height: last.size.height * captured.scale,
    };
    setGeometry({ ...last, position: placeInspector(physical, viewport, obstacles(), "nearest") });
  };
  const keyboardResize = (event: KeyboardEvent<HTMLElement>, edge: "left" | "right" | "top") => {
    if (!panel || event.nativeEvent.isComposing) return;
    const axis = edge === "top" ? "height" : "width";
    const next = inspectorKeyboardSize(
      current[axis],
      event.key,
      edge,
      minimum[axis],
      maximum[axis],
    );
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const resized = resizeInspector(
      panel.getBoundingClientRect(),
      { ...current, [axis]: next },
      edge,
      viewport,
    );
    const physical = {
      left: resized.position.left,
      top: resized.position.bottom - resized.size.height * viewport.scale,
      width: resized.size.width * viewport.scale,
      height: resized.size.height * viewport.scale,
    };
    setGeometry({
      ...resized,
      position: placeInspector(physical, viewport, obstacles(), "nearest"),
    });
  };
  const resizeProps = (edge: InspectorResizeEdge) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => begin(event, edge),
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (edge === "top" || edge === "left" || edge === "right") keyboardResize(event, edge);
    },
    onDoubleClick: () => {
      if (edge === "top-left" || edge === "top-right" || !panel || !measurement) return;
      releaseGesture(gesture);
      const resized = resizeInspector(
        panel.getBoundingClientRect(),
        {
          width: edge === "top" ? current.width : measurement.initial.width,
          height: edge === "left" || edge === "right" ? current.height : measurement.initial.height,
        },
        edge,
        viewport,
      );
      const physical = {
        left: resized.position.left,
        top: resized.position.bottom - resized.size.height * viewport.scale,
        width: resized.size.width * viewport.scale,
        height: resized.size.height * viewport.scale,
      };
      setGeometry({
        ...resized,
        position: placeInspector(physical, viewport, obstacles(), "nearest"),
      });
    },
  });
  return {
    setPanel,
    position,
    maximum,
    minimum,
    currentSize: current,
    style: {
      width: geometry.size ? Math.min(geometry.size.width, maximum.width) : undefined,
      height: geometry.size ? Math.min(geometry.size.height, maximum.height) : undefined,
      maxWidth: maximum.width,
      maxHeight: maximum.height,
    },
    headerProps: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => begin(event, "move"),
      onPointerMove: move,
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
    },
    leftResizeProps: resizeProps("left"),
    rightResizeProps: resizeProps("right"),
    topResizeProps: resizeProps("top"),
    topLeftResizeProps: resizeProps("top-left"),
    topRightResizeProps: resizeProps("top-right"),
  };
}
