import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  AvatarOverlayLayout,
  AvatarOverlayNativeLayoutState,
  AvatarOverlayRendererCommand,
  AvatarOverlayRendererEvent,
} from "../../../shared/avatar-overlay";
import {
  collectAvatarOverlayPointerRegions,
  DEFAULT_AVATAR_OVERLAY_LAYOUT,
  measureAvatarOverlayElement,
  pointIntersectsAvatarOverlayRegions,
  resolveAvatarOverlayStackReserve,
  resolveAvatarOverlayTrayPosition,
} from "./avatar-overlay-geometry";

const DEFAULT_NATIVE_LAYOUT: AvatarOverlayNativeLayoutState = {
  currentHostID: null,
  stackDisplayHeight: 0,
};

const sendEvent = (event: AvatarOverlayRendererEvent): Promise<boolean> =>
  window.avatarOverlay?.sendEvent(event) ?? Promise.resolve(false);

function reportEvent(event: AvatarOverlayRendererEvent): void {
  void sendEvent(event).catch(() => undefined);
}

function useAvatarOverlayGeometry(
  frameRef: React.RefObject<HTMLElement | null>,
  layout: AvatarOverlayLayout,
  controlsVisible: boolean,
): void {
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let frameRequest: number | null = null;
    let previousSize = "";
    let previousRegions = "";

    const publish = (): void => {
      frameRequest = null;
      const mascot = measureAvatarOverlayElement(
        frame.querySelector("[data-avatar-overlay-size='mascot']"),
      );
      if (mascot) {
        const tray = measureAvatarOverlayElement(
          frame.querySelector("[data-avatar-overlay-size='notification-tray']"),
        );
        const serialized = JSON.stringify({ mascot, tray });
        if (serialized !== previousSize) {
          previousSize = serialized;
          reportEvent({ mascot, tray, type: "element-size-changed" });
        }
      }
      const regions = collectAvatarOverlayPointerRegions(frame);
      const serializedRegions = JSON.stringify(regions);
      if (serializedRegions === previousRegions) return;
      previousRegions = serializedRegions;
      reportEvent({ regions, type: "pointer-regions-changed" });
    };
    const schedule = (): void => {
      frameRequest ??= window.requestAnimationFrame(publish);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const observeGeometry = (): void => {
      resizeObserver.disconnect();
      resizeObserver.observe(frame);
      for (const element of frame.querySelectorAll(
        "[data-avatar-overlay-hit-region], [data-avatar-overlay-size]",
      )) {
        resizeObserver.observe(element);
      }
    };
    const mutationObserver = new MutationObserver(() => {
      observeGeometry();
      schedule();
    });
    observeGeometry();
    mutationObserver.observe(frame, {
      attributeFilter: ["aria-hidden", "class", "hidden", "inert", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    frame.addEventListener("transitionend", schedule);
    frame.addEventListener("animationend", schedule);
    schedule();
    return () => {
      if (frameRequest !== null) window.cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      frame.removeEventListener("transitionend", schedule);
      frame.removeEventListener("animationend", schedule);
    };
  }, [controlsVisible, frameRef, layout]);
}

function useAvatarOverlayPointerInteractivity(frameRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let published: boolean | null = null;
    const publish = (isInteractive: boolean): void => {
      if (published === isInteractive) return;
      published = isInteractive;
      reportEvent({ isInteractive, type: "pointer-interaction-changed" });
    };
    const onMouseMove = (event: MouseEvent): void => {
      publish(
        pointIntersectsAvatarOverlayRegions(
          { x: event.clientX, y: event.clientY },
          collectAvatarOverlayPointerRegions(frameRef.current),
        ),
      );
    };
    const onMouseLeave = (): void => publish(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
      publish(false);
    };
  }, [frameRef]);
}

interface AvatarDragState {
  readonly pointerId: number;
  readonly startScreenX: number;
  readonly startScreenY: number;
  lastScreenX: number;
  lastScreenY: number;
  moved: boolean;
}

function PetGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-full overflow-visible drop-shadow-[0_9px_14px_rgba(0,0,0,0.22)] transition-transform duration-300 ease-out group-hover/mascot:-translate-y-1 group-hover/mascot:scale-[1.025] motion-reduce:transition-none"
      data-avatar-mascot="true"
      viewBox="0 0 112 121"
    >
      <defs>
        <linearGradient id="avatar-shell" x1="18" y1="9" x2="94" y2="111">
          <stop stopColor="#343743" />
          <stop offset="0.5" stopColor="#171921" />
          <stop offset="1" stopColor="#090A0E" />
        </linearGradient>
        <radialGradient id="avatar-face" cx="40%" cy="26%" r="78%">
          <stop stopColor="#FCFCF8" />
          <stop offset="1" stopColor="#DADDD5" />
        </radialGradient>
      </defs>
      <path
        d="M31 21C37 11 46 6 56 6s19 5 25 15c14 4 23 17 23 32v24c0 22-18 40-40 40H48C26 117 8 99 8 77V53c0-15 9-28 23-32Z"
        fill="url(#avatar-shell)"
        stroke="rgba(255,255,255,0.18)"
      />
      <path
        d="M24 58c0-18 14-32 32-32s32 14 32 32v10c0 18-14 32-32 32S24 86 24 68V58Z"
        fill="url(#avatar-face)"
      />
      <path
        d="M40 60c0-4 2-7 6-7s6 3 6 7-2 7-6 7-6-3-6-7Zm20 0c0-4 2-7 6-7s6 3 6 7-2 7-6 7-6-3-6-7Z"
        fill="#171921"
      />
      <path
        d="M48 80c5 4 11 4 16 0"
        fill="none"
        stroke="#4B4E58"
        strokeLinecap="round"
        strokeWidth="3"
      />
      <circle cx="91" cy="29" r="8" fill="#C8F07A" stroke="#111319" strokeWidth="4" />
      <circle cx="91" cy="29" r="2.5" fill="#31420E" />
    </svg>
  );
}

function HideIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" viewBox="0 0 16 16" fill="none">
      <path d="M3 5.5 8 10l5-4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" viewBox="0 0 16 16" fill="none">
      <path
        d="m4.5 4.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function AvatarOverlayRoot() {
  const frameRef = useRef<HTMLElement>(null);
  const dragRef = useRef<AvatarDragState | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const [layout, setLayout] = useState(DEFAULT_AVATAR_OVERLAY_LAYOUT);
  const [nativeLayout, setNativeLayout] = useState(DEFAULT_NATIVE_LAYOUT);
  const [cursor, setCursor] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);

  useAvatarOverlayGeometry(frameRef, layout, controlsVisible);
  useAvatarOverlayPointerInteractivity(frameRef);

  useEffect(() => {
    const bridge = window.avatarOverlay;
    if (!bridge) return;
    const removeCommandListener = bridge.onCommand((command: AvatarOverlayRendererCommand) => {
      switch (command.type) {
        case "layout-changed":
          setLayout(command.layout);
          setVisible(command.isVisible);
          return;
        case "native-layout-state-changed":
          setNativeLayout(command.state);
          return;
        case "computer-use-cursor-changed":
          setCursor(command.point);
          return;
      }
    });
    reportEvent({ type: "ready" });
    return removeCommandListener;
  }, []);

  useEffect(
    () => () => {
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    },
    [],
  );

  const showControls = (): void => {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
    setControlsVisible(true);
  };
  const scheduleControlsCollapse = (): void => {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setControlsVisible(false);
    }, 100);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    reportEvent({
      pointerScreenX: event.screenX,
      pointerScreenY: event.screenY,
      type: "drag-end",
    });
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || event.ctrlKey) return;
    if (event.target instanceof Element && event.target.closest(".no-drag")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      moved: false,
    };
    reportEvent({
      pointerScreenX: event.screenX,
      pointerScreenY: event.screenY,
      pointerWindowX: event.clientX,
      pointerWindowY: event.clientY,
      type: "drag-start",
    });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const movedPastThreshold =
      Math.abs(event.screenX - drag.startScreenX) >= 4 ||
      Math.abs(event.screenY - drag.startScreenY) >= 4;
    if (!drag.moved && !movedPastThreshold) return;
    if (event.screenX === drag.lastScreenX && event.screenY === drag.lastScreenY) return;
    drag.moved = true;
    drag.lastScreenX = event.screenX;
    drag.lastScreenY = event.screenY;
    reportEvent({
      pointerScreenX: event.screenX,
      pointerScreenY: event.screenY,
      type: "drag-move",
    });
  };
  const onMascotKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setControlsVisible((current) => !current);
  };

  const trayPosition = resolveAvatarOverlayTrayPosition(layout, nativeLayout);
  const stackReserve = resolveAvatarOverlayStackReserve(layout, nativeLayout);
  const mascotStyle = {
    height: layout.mascot.height,
    left: layout.mascot.x,
    top: layout.mascot.y,
    width: layout.mascot.width,
  };

  return (
    <main
      aria-hidden={!visible}
      className={`fixed inset-0 overflow-hidden bg-transparent transition-opacity duration-200 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}
      inert={!visible}
    >
      <section
        ref={frameRef}
        className="relative size-full select-none"
        data-avatar-overlay-content-frame="true"
      >
        <div
          aria-hidden={!controlsVisible}
          className={`no-drag absolute z-20 h-[58px] w-[184px] overflow-hidden rounded-[18px] border border-white/20 bg-neutral-950/76 text-white shadow-[0_12px_32px_rgba(0,0,0,0.26)] backdrop-blur-xl transition-[opacity,transform,left,top] duration-200 ease-out motion-reduce:transition-none ${controlsVisible ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-1.5 opacity-0"}`}
          data-avatar-overlay-hit-region="notification-tray"
          data-avatar-overlay-native-corner-radius="18"
          data-avatar-overlay-native-glass-group="pet-controls"
          data-avatar-overlay-native-surface-id="pet-controls"
          data-avatar-overlay-size="notification-tray"
          data-avatar-overlay-stack-reserve={stackReserve}
          inert={!controlsVisible}
          onFocus={showControls}
          onMouseEnter={showControls}
          onMouseLeave={scheduleControlsCollapse}
          style={trayPosition}
        >
          <div
            className="flex h-7 items-center justify-between px-3"
            data-avatar-overlay-size="notification-tray-header"
          >
            <span className="text-[11px] font-medium tracking-[0.01em] text-white/72">Nodex</span>
            <span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_8px_rgba(190,242,100,0.7)]" />
          </div>
          <div
            className="flex h-[30px] items-start justify-between gap-2 px-2.5"
            data-avatar-overlay-size="notification-tray-list"
          >
            <span className="min-w-0 flex-1 truncate pl-0.5 pt-1 text-[11px] text-white/48">
              Ready nearby
            </span>
            <div className="flex items-center gap-1">
              <button
                aria-label="Hide desktop pet"
                className="flex size-6 items-center justify-center rounded-full text-white/58 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:outline-none"
                onClick={() => reportEvent({ type: "hide" })}
                type="button"
              >
                <HideIcon />
              </button>
              <button
                aria-label="Close desktop pet"
                className="flex size-6 items-center justify-center rounded-full text-white/58 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:outline-none"
                onClick={() => reportEvent({ type: "close" })}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          </div>
        </div>

        <div
          aria-label="Nodex desktop pet"
          className="group/mascot absolute z-10 cursor-grab touch-none rounded-[32px] focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:outline-none active:cursor-grabbing"
          data-avatar-overlay-hit-region="mascot"
          onBlur={scheduleControlsCollapse}
          onFocus={showControls}
          onKeyDown={onMascotKeyDown}
          onLostPointerCapture={finishDrag}
          onMouseEnter={showControls}
          onMouseLeave={scheduleControlsCollapse}
          onPointerCancel={finishDrag}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          role="button"
          style={mascotStyle}
          tabIndex={0}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[12%] bottom-[2%] h-[15%] rounded-full bg-black/30 blur-md transition-transform duration-300 group-hover/mascot:scale-90 motion-reduce:transition-none"
          />
          <div
            className="pointer-events-none absolute inset-0 motion-safe:animate-[bounce_5s_ease-in-out_infinite]"
            data-avatar-overlay-size="mascot"
          >
            <PetGlyph />
          </div>
        </div>

        {cursor ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-50 size-5 -translate-x-1/2 -translate-y-1/2 transition-[left,top] duration-75 ease-linear motion-reduce:transition-none"
            data-avatar-overlay-computer-use-cursor="true"
            style={{ left: cursor.x, top: cursor.y }}
          >
            <span className="absolute inset-0 animate-ping rounded-full border border-sky-300/55 motion-reduce:animate-none" />
            <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80 bg-sky-500 shadow-[0_1px_5px_rgba(14,165,233,0.65)]" />
          </div>
        ) : null}
      </section>
    </main>
  );
}
