import type { WorkbenchLayoutSnapshot } from "./workbench-layout";

export type WindowRestorePolicy = "all" | "last-window" | "none";

export interface WindowRestoreSettings {
  policy: WindowRestorePolicy;
}

export interface UpdateWindowRestoreSettingsInput {
  policy: WindowRestorePolicy;
}

export interface WindowSessionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "normal" | "maximized" | "fullscreen";
}

export type WindowSessionLifecycle = { state: "open" } | { state: "closed"; closedAt: string };

export interface WindowSessionRecord {
  id: string;
  lifecycle: WindowSessionLifecycle;
  layoutRevision: number;
  layout: WorkbenchLayoutSnapshot;
  createdAt: string;
  updatedAt: string;
  focusedAt: string;
  bounds?: WindowSessionBounds;
}

export interface WindowSessionCatalog {
  version: 3;
  lastActiveSessionId: string;
  sessions: WindowSessionRecord[];
}

export interface WindowSessionBootstrap {
  session: WindowSessionRecord;
}

export interface WindowSessionNewWindowRequest {
  activeProjectSessionId?: string | null;
  activeProjectId?: string | null;
  browserUrl?: string;
}

export interface WindowSessionSaveLayoutInput {
  sessionId: string;
  revision: number;
  layout: WorkbenchLayoutSnapshot;
}
