export interface Point {
  readonly x: number;
  readonly y: number;
}

interface TargetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A stable lane edge predicts where a moving button will land, rather than chasing its path. */
export function cursorTargetPoint(
  origin: Point,
  rect: TargetRect,
  scale: number,
  bottom?: number,
): Point {
  return {
    x: (rect.left - origin.x + rect.width * 0.42) / scale,
    y:
      ((bottom === undefined ? rect.top + rect.height * 0.55 : bottom - rect.height * 0.45) -
        origin.y) /
      scale,
  };
}
