/**
 * How a full-screen picture zooms and pans, the same on every platform. Offsets are measured from
 * the frame's centre, where the picture's transform is anchored. Each helper also runs as a worklet
 * on the UI thread, inside the gestures.
 */

export const MAX_ZOOM = 4;
/** Where a double tap takes a picture shown whole. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** A scale this close to 1 is a picture shown whole. */
const WHOLE = 1.01;

export type Size = { readonly width: number; readonly height: number };

/** A picture's drawn size when it fits its frame whole. Before it loads, it fills the frame. */
export const containedSize = (frame: Size, picture: Size | null): Size => {
  "worklet";
  if (!picture || picture.width <= 0 || picture.height <= 0) return frame;
  const fit = Math.min(frame.width / picture.width, frame.height / picture.height);
  return { width: picture.width * fit, height: picture.height * fit };
};

export const isZoomed = (scale: number): boolean => {
  "worklet";
  return scale > WHOLE;
};

/** A pinch ends between whole and the largest zoom. */
export const clampZoom = (scale: number): number => {
  "worklet";
  return Math.min(MAX_ZOOM, Math.max(1, scale));
};

/**
 * How far a picture zoomed to `scale` may move along one axis: until its edge meets the frame's.
 * A picture still narrower than its frame stays centred.
 */
export const panLimit = (frame: number, drawn: number, scale: number): number => {
  "worklet";
  return Math.max(0, (drawn * scale - frame) / 2);
};

export const clampPan = (offset: number, frame: number, drawn: number, scale: number): number => {
  "worklet";
  const limit = panLimit(frame, drawn, scale);
  return Math.min(limit, Math.max(-limit, offset));
};

/**
 * The offset that keeps the point first pinched under the fingers as they move and spread, so a
 * picture zooms about where it is held and follows a two-finger drag.
 */
export const pinchOffset = (
  start: { readonly focal: number; readonly offset: number; readonly scale: number },
  focal: number,
  scale: number,
): number => {
  "worklet";
  return focal - ((start.focal - start.offset) * scale) / start.scale;
};
