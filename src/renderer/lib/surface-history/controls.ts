import type {
  SurfaceHistoryDirection,
  SurfaceHistorySnapshot,
} from "../../../shared/surface-history";

/** Presentation can observe and request recovery, but cannot edit the timeline. */
export interface SurfaceHistoryControls {
  snapshot(): SurfaceHistorySnapshot;
  subscribe(listener: () => void): () => void;
  request?(direction: SurfaceHistoryDirection): unknown;
  recover(): unknown;
  reset(): void;
}
