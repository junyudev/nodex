export const APP_INITIALIZATION_STEP_CHANNEL = "app:init-step";
export const APP_RESTART_CHANNEL = "app:restart";

export const RENDERER_INITIALIZATION_PHASES = [
  "native",
  "bootstrap",
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
