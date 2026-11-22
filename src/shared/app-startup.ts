import type { AppRuntimeCapabilities } from "./runtime-capabilities";
import type { SpaceConnectionSummary } from "./space-connection";
import type { DiagnosticsSettings } from "./types";
import type { WindowSessionRecord } from "./window-session";

export const APP_INITIALIZATION_STEP_CHANNEL = "app:init-step";
export const APP_RESTART_CHANNEL = "app:restart";

export const RENDERER_INITIALIZATION_PHASES = [
  "native",
  "modules",
  "diagnostics",
  "mount",
] as const;

export type RendererInitializationPhase = (typeof RENDERER_INITIALIZATION_PHASES)[number];

export interface RendererInitializationReport {
  readonly durationMs: number;
  readonly outcome: "ready" | "failed";
  readonly timingsMs?: Partial<Record<RendererInitializationPhase, number>>;
}

export type AppInitializationStep =
  | { phase: "opening" }
  | {
      completed?: number;
      fromVersion: number;
      phase: "migrating";
      toVersion: number;
      total?: number;
    }
  | { phase: "opening_workspace" }
  | { phase: "done" }
  | { phase: "failed" };

/**
 * Everything one window's renderer needs to start, returned once global initialization and that
 * window's activation gate are both ready. A snapshot at reply time: the renderer binds its Space
 * and Window Session from it once, and later changes reach it through their own owners.
 */
export interface WindowBootstrap {
  /** The Space this renderer document belongs to for its whole lifetime. */
  readonly space: SpaceConnectionSummary;
  readonly windowSession: WindowSessionRecord;
  readonly runtimeCapabilities: AppRuntimeCapabilities;
  /** Null when the Profile's diagnostics settings could not be read; diagnostics stay off. */
  readonly diagnostics: DiagnosticsSettings | null;
}

/** Profile-local diagnostic locator; available before Core initialization. */
export interface AppStartupFailureEvidence {
  readonly incidentId: string;
  readonly recordPath: string | null;
}
