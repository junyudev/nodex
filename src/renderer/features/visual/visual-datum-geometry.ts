import type { VisualDatumGeometry } from "../../../shared/visual/bridge";
import type { VisualKey } from "../../../shared/visual/contract";

interface MountedVisual {
  readonly element: HTMLElement;
  readonly datum: readonly VisualDatumGeometry[];
}

const mounted = new Map<string, MountedVisual>();
const listeners = new Set<() => void>();

/** Records where a Visual's data points are, so Discussions on them can align in the margin. */
export function publishVisualDatumGeometry(blockId: string, visual: MountedVisual | null): void {
  if (visual) mounted.set(blockId, visual);
  else mounted.delete(blockId);
  for (const listener of listeners) listener();
}

export function subscribeVisualDatumGeometry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface DatumAnchor {
  readonly source: string;
  readonly key: unknown;
  readonly field?: string | null;
}

/** The rendered mark a data-point Discussion is anchored to, if the Visual still draws it. */
export function findAnchoredDatum(
  datum: readonly VisualDatumGeometry[],
  anchor: DatumAnchor,
): VisualDatumGeometry | undefined {
  const key = JSON.stringify(anchor.key as VisualKey);
  return datum.find(
    (candidate) =>
      candidate.source === anchor.source &&
      JSON.stringify(candidate.key) === key &&
      (anchor.field ? candidate.field === anchor.field : true),
  );
}

/** The viewport top of one data point, or null when its Visual or point is not rendered. */
export function visualDatumTop(blockId: string, anchor: DatumAnchor): number | null {
  const visual = mounted.get(blockId);
  const match = visual && findAnchoredDatum(visual.datum, anchor);
  if (!visual || !match) return null;
  return visual.element.getBoundingClientRect().top + match.rect.y;
}
