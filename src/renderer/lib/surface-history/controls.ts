import type { SurfaceHistorySnapshot } from "../../../shared/surface-history";

/** Presentation can observe and request recovery, but cannot edit the timeline. */
export interface SurfaceHistoryControls {
  snapshot(): SurfaceHistorySnapshot;
  subscribe(listener: () => void): () => void;
  recover(): unknown;
  reset(): void;
}
