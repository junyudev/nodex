/** A native menu intent, not a second history engine or a durable mutation. */
export type SurfaceHistoryDirection = "undo" | "redo";
export const EXECUTE_FOCUSED_HISTORY_CHANNEL = "execute-focused-history";

export interface SurfaceHistoryCapability {
  readonly status: "ready" | "waiting" | "blocked" | "empty";
  readonly label: string | null;
  readonly acceptsIntent: boolean;
  readonly reason: string | null;
  readonly recoveryActions: readonly ("retry" | "reset")[];
}

/** Observation only: neither a recipe nor authority to execute a stale menu item. */
export interface SurfaceHistorySnapshot {
  readonly ownerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly undo: SurfaceHistoryCapability;
  readonly redo: SurfaceHistoryCapability;
}

/** A renderer attachment and focus sequence fence an observation, never execution. */
export interface FocusedHistoryPublication {
  readonly generation: number;
  readonly sequence: number;
  readonly snapshot: SurfaceHistorySnapshot | null;
}
