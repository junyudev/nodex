import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import {
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  clampPan,
  clampZoom,
  containedSize,
  isZoomed,
  panLimit,
  pinchOffset,
  type Size,
} from "./zoom";

/**
 * One picture, whole, that a pinch zooms about the fingers and a drag then pans, up to its edges.
 * A double tap zooms in where it lands, or back out. It reports whether it is zoomed, so the gallery
 * holds still while a zoomed picture pans. Leaving the picture shows it whole again.
 */
export const ZoomableImage = ({
  uri,
  label,
  frame,
  active,
  onZoomChange,
}: {
  readonly uri: string;
  readonly label: string;
  readonly frame: Size;
  /** The gallery is showing this picture. */
  readonly active: boolean;
  readonly onZoomChange: (zoomed: boolean) => void;
}) => {
  const [picture, setPicture] = useState<Size | null>(null);
  const bounds = useSharedValue({ frame, drawn: containedSize(frame, picture) });
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const zoomed = useSharedValue(false);
  const pinchStart = useSharedValue({ scale: 1, x: 0, y: 0, focalX: 0, focalY: 0 });
  const panStart = useSharedValue({ x: 0, y: 0 });

  useEffect(() => {
    bounds.set({ frame, drawn: containedSize(frame, picture) });
  }, [bounds, frame, picture]);

  const report = (next: boolean) => {
    "worklet";
    if (zoomed.get() === next) return;
    zoomed.set(next);
    scheduleOnRN(onZoomChange, next);
  };
  const showWhole = () => {
    "worklet";
    scale.set(withTiming(1));
    x.set(withTiming(0));
    y.set(withTiming(0));
    report(false);
  };
  const settle = () => {
    "worklet";
    const { frame: view, drawn } = bounds.get();
    const settled = clampZoom(scale.get());
    if (!isZoomed(settled)) return showWhole();
    scale.set(withTiming(settled));
    x.set(withTiming(clampPan(x.get(), view.width, drawn.width, settled)));
    y.set(withTiming(clampPan(y.get(), view.height, drawn.height, settled)));
    report(true);
  };

  useEffect(() => {
    if (active) return;
    scale.set(1);
    x.set(0);
    y.set(0);
    zoomed.set(false);
  }, [active, scale, x, y, zoomed]);

  const pinch = usePinchGesture({
    onActivate: (event) => {
      "worklet";
      const { frame: view } = bounds.get();
      pinchStart.set({
        scale: scale.get(),
        x: x.get(),
        y: y.get(),
        focalX: event.focalX - view.width / 2,
        focalY: event.focalY - view.height / 2,
      });
    },
    onUpdate: (event) => {
      "worklet";
      const { frame: view } = bounds.get();
      const start = pinchStart.get();
      // A pinch may overshoot a little while held; it settles inside the limits on release.
      const next = Math.min(MAX_ZOOM * 1.25, Math.max(0.75, start.scale * event.scale));
      scale.set(next);
      x.set(
        pinchOffset(
          { focal: start.focalX, offset: start.x, scale: start.scale },
          event.focalX - view.width / 2,
          next,
        ),
      );
      y.set(
        pinchOffset(
          { focal: start.focalY, offset: start.y, scale: start.scale },
          event.focalY - view.height / 2,
          next,
        ),
      );
    },
    onDeactivate: () => {
      "worklet";
      settle();
    },
  });

  const pan = usePanGesture({
    // Whole, a drag belongs to the gallery, which moves to the next picture.
    enabled: zoomed,
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      panStart.set({ x: x.get(), y: y.get() });
    },
    onUpdate: (event) => {
      "worklet";
      const { frame: view, drawn } = bounds.get();
      const start = panStart.get();
      const current = scale.get();
      x.set(clampPan(start.x + event.translationX, view.width, drawn.width, current));
      y.set(clampPan(start.y + event.translationY, view.height, drawn.height, current));
    },
    onDeactivate: (event) => {
      "worklet";
      const { frame: view, drawn } = bounds.get();
      const current = scale.get();
      const limitX = panLimit(view.width, drawn.width, current);
      const limitY = panLimit(view.height, drawn.height, current);
      x.set(withDecay({ velocity: event.velocityX, clamp: [-limitX, limitX] }));
      y.set(withDecay({ velocity: event.velocityY, clamp: [-limitY, limitY] }));
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      "worklet";
      if (isZoomed(scale.get())) return showWhole();
      const { frame: view, drawn } = bounds.get();
      const focalX = event.x - view.width / 2;
      const focalY = event.y - view.height / 2;
      const whole = { offset: 0, scale: 1 };
      scale.set(withTiming(DOUBLE_TAP_ZOOM));
      x.set(
        withTiming(
          clampPan(
            pinchOffset({ ...whole, focal: focalX }, focalX, DOUBLE_TAP_ZOOM),
            view.width,
            drawn.width,
            DOUBLE_TAP_ZOOM,
          ),
        ),
      );
      y.set(
        withTiming(
          clampPan(
            pinchOffset({ ...whole, focal: focalY }, focalY, DOUBLE_TAP_ZOOM),
            view.height,
            drawn.height,
            DOUBLE_TAP_ZOOM,
          ),
        ),
      );
      report(true);
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);
  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={frame}>
        <Animated.View style={[frame, transform]}>
          <Image
            accessibilityLabel={label}
            contentFit="contain"
            onLoad={({ source }) => setPicture({ width: source.width, height: source.height })}
            source={{ uri }}
            style={frame}
            transition={0}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
};
