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
 * Returned after global initialization and any Window Session activation gate. The renderer
 * binds its Space and, for a primary window, its Window Session from this startup snapshot.
 */
interface AppRendererBootstrapBase {
  /** The Space this renderer document belongs to for its whole lifetime. */
  readonly space: SpaceConnectionSummary;
  readonly runtimeCapabilities: AppRuntimeCapabilities;
  /** Null when the Profile's diagnostics settings could not be read; diagnostics stay off. */
  readonly diagnostics: DiagnosticsSettings | null;
}

export interface WindowBootstrap extends AppRendererBootstrapBase {
  readonly kind: "window-session";
  readonly windowSession: WindowSessionRecord;
}

export interface MiniBootstrap extends AppRendererBootstrapBase {
  readonly kind: "mini";
}

export type AppRendererBootstrap = WindowBootstrap | MiniBootstrap;

/** Profile-local diagnostic locator; available before Core initialization. */
export interface AppStartupFailureEvidence {
  readonly incidentId: string;
  readonly recordPath: string | null;
}
