import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WindowRestorePolicy,
  WindowSessionBounds,
  WindowSessionCatalog,
  WindowSessionNewWindowRequest,
  WindowSessionRecord,
  WindowSessionSaveLayoutInput,
} from "../shared/window-session";
import {
  createDefaultWorkbenchLayoutSnapshot,
  getWorkbenchSceneReturnLocation,
  type WorkbenchLayoutSnapshot,
} from "../shared/workbench-layout";
import type { InitialProjectPresentation } from "../shared/initial-project-welcome";
import {
  LegacyWindowSessionCatalogV1Schema,
  LegacyWindowSessionCatalogV2Schema,
  WindowSessionCatalogSchema,
} from "../shared/schemas/window-session";
import { WorkbenchLayoutSnapshotSchema } from "../shared/schemas/workbench-layout";
import {
  cloneWorkbenchSceneLayoutForNewWindow,
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialProjectWelcomeScene,
  materializeInitialWorkbenchScene,
  type WorkbenchSurfaceDescriptor,
} from "../shared/workbench-scene";
import { resolveBrowserTabTitle } from "../shared/browser-url";
import { createSecureRuntimeId } from "../shared/secure-runtime-id";
import { getLogger } from "./logging/logger";

const WINDOW_SESSIONS_V3_FILE_NAME = "window-sessions-v3.json";
const WINDOW_SESSIONS_V2_FILE_NAME = "window-sessions-v2.json";
const WINDOW_SESSIONS_V1_FILE_NAME = "window-sessions-v1.json";
const WINDOW_SESSION_VERSION = 3;
const MAX_WINDOW_SESSION_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CLOSED_WINDOW_SESSIONS = 20;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;
const logger = getLogger({ module: "window-session-state" });

type ClosedWindowSessionRecord = WindowSessionRecord & {
  lifecycle: { state: "closed"; closedAt: string };
};

export type WindowSessionCloseDisposition = "user-close" | "app-quit" | "unexpected";

export interface ReopenedWindowSession {
  session: WindowSessionRecord;
  previousRecord: ClosedWindowSessionRecord;
}

export type AcquiredWindowSession =
  | ({ kind: "reopened" } & ReopenedWindowSession)
  | { kind: "cloned" | "fresh"; session: WindowSessionRecord };

interface WindowSessionStateOptions {
  now?: () => Date;
  maxClosedSessions?: number;
  maxFileBytes?: number;
}

interface PreparedCatalog {
  catalog: WindowSessionCatalog;
  serialized: string;
}

function normalizeLayout(
  value: unknown,
  fallback: WorkbenchLayoutSnapshot,
): WorkbenchLayoutSnapshot {
  const parsed = WorkbenchLayoutSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function openBrowserInClonedLayout(
  layout: WorkbenchLayoutSnapshot,
  browserUrl: string,
): WorkbenchLayoutSnapshot {
  const location = getWorkbenchSceneReturnLocation(layout.location);
  if (location.kind !== "project" && location.kind !== "session") {
    throw new Error("Opening a Browser window requires a Project or Session Scene");
  }
  const owner =
    location.kind === "project"
      ? location
      : { kind: "session" as const, sessionId: location.sessionId };
  const sceneKey = makeWorkbenchSceneKey(owner);
  const scene = layout.scenesByOwnerKey[sceneKey] ?? materializeInitialWorkbenchScene(owner);
  const surfaceId = createSecureRuntimeId("surface");
  const nextScene = createWorkbenchSceneSurface(scene, {
    panelId: "right",
    surface: {
      id: surfaceId,
      kind: "browser",
      titleSnapshot: resolveBrowserTabTitle(browserUrl, undefined),
      config: {
        browserTabId: createSecureRuntimeId("browser"),
        browserStorageId: createSecureRuntimeId("browser"),
        url: browserUrl,
      },
      stateKey: 0,
      state: null,
    },
  });
  if (!nextScene.panelSurfacesById[surfaceId]) {
    throw new Error("The Scene has reached its surface limit");
  }
  return {
    ...layout,
    location,
    scenesByOwnerKey: { ...layout.scenesByOwnerKey, [sceneKey]: nextScene },
  };
}

function browserStorageIdForLegacyTab(
  windowSessionId: string,
  projectSessionId: string,
  browserTabId: string,
): string {
  const digest = createHash("sha256")
    .update(windowSessionId)
    .update("\0")
    .update(projectSessionId)
    .update("\0")
    .update(browserTabId)
    .digest("hex");
  return `browser:migrated:${digest}`;
}

function ensureBrowserStorageIdentities(
  layout: WorkbenchLayoutSnapshot,
  windowSessionId: string,
): WorkbenchLayoutSnapshot {
  return {
    ...layout,
    scenesByOwnerKey: Object.fromEntries(
      Object.entries(layout.scenesByOwnerKey).map(([sceneKey, scene]) => {
        const ensureSurface = (surface: WorkbenchSurfaceDescriptor): WorkbenchSurfaceDescriptor => {
          if (surface.kind !== "browser" || surface.config.browserStorageId) {
            return surface;
          }
          return {
            ...surface,
            config: {
              ...surface.config,
              browserStorageId: browserStorageIdForLegacyTab(
                windowSessionId,
                sceneKey,
                surface.config.browserTabId,
              ),
            },
          };
        };
        return [
          sceneKey,
          {
            ...scene,
            primary: scene.primary ? ensureSurface(scene.primary) : null,
            panelSurfacesById: Object.fromEntries(
              Object.entries(scene.panelSurfacesById).map(([surfaceId, surface]) => [
                surfaceId,
                ensureSurface(surface),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function normalizeSessionBounds(
  value: WindowSessionBounds | undefined,
): WindowSessionBounds | undefined {
  if (!value) return undefined;
  if (value.width < MIN_WINDOW_WIDTH || value.height < MIN_WINDOW_HEIGHT) {
    return undefined;
  }
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height),
    mode: value.mode,
  };
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function compareTimestampsDescending(left: string, right: string): number {
  const difference = timestampValue(right) - timestampValue(left);
  if (difference !== 0) return difference;
  return right.localeCompare(left);
}

function serializeCatalog(catalog: WindowSessionCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export function isWindowSessionBoundsVisible(
  bounds: WindowSessionBounds | undefined,
  displays: Array<{ bounds: { x: number; y: number; width: number; height: number } }>,
): boolean {
  if (!bounds) return false;
  if (bounds.width < MIN_WINDOW_WIDTH || bounds.height < MIN_WINDOW_HEIGHT) {
    return false;
  }

  return displays.some((display) => {
    const displayBounds = display.bounds;
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, displayBounds.x + displayBounds.width) -
        Math.max(bounds.x, displayBounds.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, displayBounds.y + displayBounds.height) -
        Math.max(bounds.y, displayBounds.y),
    );
    return overlapX >= 120 && overlapY >= 120;
  });
}

export class WindowSessionState {
  private readonly statePath: string;
  private readonly legacyV2StatePath: string;
  private readonly legacyV1StatePath: string;
  private readonly webContentsToSessionId = new Map<number, string>();
  private readonly now: () => Date;
  private readonly maxClosedSessions: number;
  private readonly maxFileBytes: number;

  constructor(userDataPath: string, options: WindowSessionStateOptions = {}) {
    const maxClosedSessions = options.maxClosedSessions ?? MAX_CLOSED_WINDOW_SESSIONS;
    const maxFileBytes = options.maxFileBytes ?? MAX_WINDOW_SESSION_FILE_BYTES;
    if (!Number.isInteger(maxClosedSessions) || maxClosedSessions < 1) {
      throw new Error("Window Session closed-history limit must be a positive integer");
    }
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new Error("Window Session file-size limit must be a positive integer");
    }

    this.statePath = path.join(userDataPath, WINDOW_SESSIONS_V3_FILE_NAME);
    this.legacyV2StatePath = path.join(userDataPath, WINDOW_SESSIONS_V2_FILE_NAME);
    this.legacyV1StatePath = path.join(userDataPath, WINDOW_SESSIONS_V1_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.maxClosedSessions = maxClosedSessions;
    this.maxFileBytes = maxFileBytes;
  }

  createFreshSession(): WindowSessionRecord {
    const catalog = this.readCatalog() ?? this.emptyCatalog();
    const session = this.createSessionRecord(createDefaultWorkbenchLayoutSnapshot());
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: session.id,
      sessions: [...catalog.sessions, session],
    });
    return this.requireSession(written, session.id);
  }

  cloneSessionForWindow(
    sourceWebContentsId: number,
    override: WindowSessionNewWindowRequest = {},
  ): WindowSessionRecord {
    const sourceSession = this.getSessionForWindow(sourceWebContentsId);
    if (!sourceSession) {
      throw new Error("The requesting window has no assigned Window Session");
    }

    const layout = cloneWorkbenchSceneLayoutForNewWindow(sourceSession.layout);
    const returnLocation = getWorkbenchSceneReturnLocation(layout.location);
    if (
      override.browserUrl !== undefined &&
      returnLocation.kind !== "project" &&
      returnLocation.kind !== "session"
    ) {
      throw new Error("Opening a Browser window requires a Project or Session Scene");
    }
    const currentProjectContextId =
      returnLocation.kind === "project"
        ? returnLocation.projectId
        : returnLocation.kind === "session"
          ? returnLocation.projectContextId
          : null;
    const overrideProjectId = override.activeProjectId ?? currentProjectContextId;
    const location =
      override.activeProjectSessionId === undefined
        ? layout.location
        : override.activeProjectSessionId === null
          ? overrideProjectId
            ? { kind: "project" as const, projectId: overrideProjectId }
            : { kind: "empty" as const }
          : {
              kind: "session" as const,
              sessionId: override.activeProjectSessionId,
              projectContextId: overrideProjectId,
            };
    const requestedLayout = {
      ...layout,
      location,
    };
    const session = this.createSessionRecord(
      override.browserUrl === undefined
        ? requestedLayout
        : openBrowserInClonedLayout(requestedLayout, override.browserUrl),
    );
    const catalog = this.readOrCreateCatalog();
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: session.id,
      sessions: [...catalog.sessions, session],
    });
    return this.requireSession(written, session.id);
  }

  acquireSessionForNewWindow(sourceWebContentsId?: number): AcquiredWindowSession {
    const reopened = this.reopenMostRecentlyClosedSession();
    if (reopened) return { kind: "reopened", ...reopened };
    if (sourceWebContentsId !== undefined) {
      return {
        kind: "cloned",
        session: this.cloneSessionForWindow(sourceWebContentsId),
      };
    }
    return {
      kind: "fresh",
      session: this.createFreshSession(),
    };
  }

  selectStartupSessions(policy: WindowRestorePolicy): WindowSessionRecord[] {
    const catalog = this.readCatalog() ?? this.emptyCatalog();
    if (policy === "none") {
      return this.startFreshAndCloseOpenSessions(catalog);
    }

    const openSessions = catalog.sessions.filter((session) => session.lifecycle.state === "open");
    if (openSessions.length === 0) {
      return this.reopenClosedOrCreateFresh(catalog);
    }
    if (policy === "all") {
      const primaryIndex = openSessions.findIndex(
        (session) => session.id === catalog.lastActiveSessionId,
      );
      if (primaryIndex <= 0) return openSessions;
      const primary = openSessions[primaryIndex];
      if (!primary) return openSessions;
      return [
        primary,
        ...openSessions.slice(0, primaryIndex),
        ...openSessions.slice(primaryIndex + 1),
      ];
    }

    const selected =
      openSessions.find((session) => session.id === catalog.lastActiveSessionId) ??
      this.mostRecentlyFocusedSession(openSessions);
    if (!selected) return this.reopenClosedOrCreateFresh(catalog);

    const timestamp = this.nowIso();
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: selected.id,
      sessions: catalog.sessions.map((session) => {
        if (session.lifecycle.state !== "open" || session.id === selected.id) {
          return session;
        }
        return {
          ...session,
          lifecycle: { state: "closed", closedAt: timestamp },
          updatedAt: timestamp,
        };
      }),
    });
    return [this.requireSession(written, selected.id)];
  }

  attachWindow(webContentsId: number, sessionId: string): WindowSessionRecord {
    const assignedSessionId = this.webContentsToSessionId.get(webContentsId);
    if (assignedSessionId && assignedSessionId !== sessionId) {
      throw new Error("The requesting window already owns another Window Session");
    }
    if (assignedSessionId === sessionId) {
      const assigned = this.getSessionForWindow(webContentsId);
      if (!assigned) {
        throw new Error("Assigned Window Session is unavailable");
      }
      return assigned;
    }

    const conflictingWindow = [...this.webContentsToSessionId.entries()].find(
      ([candidateWebContentsId, candidateSessionId]) =>
        candidateWebContentsId !== webContentsId && candidateSessionId === sessionId,
    );
    if (conflictingWindow) {
      throw new Error("Window Session is already attached to another window");
    }

    const catalog = this.readOrCreateCatalog();
    const session = catalog.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      throw new Error("Window Session is unavailable");
    }
    if (session.lifecycle.state === "open") {
      this.webContentsToSessionId.set(webContentsId, sessionId);
      return session;
    }

    const timestamp = this.nowIso();
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: sessionId,
      sessions: catalog.sessions.map((entry) =>
        entry.id === sessionId
          ? {
              ...entry,
              lifecycle: { state: "open" },
              updatedAt: timestamp,
            }
          : entry,
      ),
    });
    this.webContentsToSessionId.set(webContentsId, sessionId);
    return this.requireSession(written, sessionId);
  }

  detachWindow(
    webContentsId: number,
    input: {
      disposition: WindowSessionCloseDisposition;
      bounds?: WindowSessionBounds;
    },
  ): WindowSessionRecord | null {
    const sessionId = this.webContentsToSessionId.get(webContentsId);
    if (!sessionId) return null;

    try {
      const catalog = this.readCatalog();
      if (!catalog) return null;
      const session = catalog.sessions.find((entry) => entry.id === sessionId);
      if (!session) return null;

      const timestamp = this.nowIso();
      const normalizedBounds = normalizeSessionBounds(input.bounds);
      const nextSession: WindowSessionRecord = {
        ...session,
        lifecycle:
          input.disposition === "user-close"
            ? { state: "closed", closedAt: timestamp }
            : { state: "open" },
        ...(input.disposition === "user-close" || normalizedBounds ? { updatedAt: timestamp } : {}),
        ...(normalizedBounds ? { bounds: normalizedBounds } : {}),
      };
      const written = this.writeCatalog({
        version: WINDOW_SESSION_VERSION,
        lastActiveSessionId: catalog.lastActiveSessionId,
        sessions: catalog.sessions.map((entry) => (entry.id === sessionId ? nextSession : entry)),
      });
      return written.sessions.find((entry) => entry.id === sessionId) ?? null;
    } finally {
      this.webContentsToSessionId.delete(webContentsId);
    }
  }

  reopenMostRecentlyClosedSession(): ReopenedWindowSession | null {
    const catalog = this.readCatalog();
    if (!catalog) return null;
    const previousRecord = this.mostRecentlyClosedSession(catalog.sessions);
    if (!previousRecord) return null;
    if ([...this.webContentsToSessionId.values()].includes(previousRecord.id)) {
      throw new Error("A closed Window Session is still attached to a window");
    }

    const timestamp = this.nowIso();
    const nextSession: WindowSessionRecord = {
      ...previousRecord,
      lifecycle: { state: "open" },
      updatedAt: timestamp,
    };
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: nextSession.id,
      sessions: catalog.sessions.map((session) =>
        session.id === nextSession.id ? nextSession : session,
      ),
    });
    return {
      session: this.requireSession(written, nextSession.id),
      previousRecord,
    };
  }

  rollbackReopenSession(previousRecord: ClosedWindowSessionRecord): WindowSessionRecord | null {
    if ([...this.webContentsToSessionId.values()].includes(previousRecord.id)) {
      throw new Error("Cannot roll back an attached Window Session");
    }

    const catalog = this.readCatalog();
    if (!catalog) return null;
    const current = catalog.sessions.find((session) => session.id === previousRecord.id);
    if (!current || current.lifecycle.state !== "open") return null;

    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: catalog.lastActiveSessionId,
      sessions: catalog.sessions.map((session) =>
        session.id === previousRecord.id ? previousRecord : session,
      ),
    });
    return written.sessions.find((session) => session.id === previousRecord.id) ?? null;
  }

  hasClosedSessionAvailable(): boolean {
    return (
      this.readCatalog()?.sessions.some((session) => session.lifecycle.state === "closed") ?? false
    );
  }

  bootstrap(webContentsId: number): WindowSessionRecord {
    const assignedSessionId = this.webContentsToSessionId.get(webContentsId);
    const catalog = this.readOrCreateCatalog();
    const assignedSession = assignedSessionId
      ? catalog.sessions.find((session) => session.id === assignedSessionId)
      : undefined;
    if (assignedSession) return assignedSession;

    const session = this.createFreshSession();
    return this.attachWindow(webContentsId, session.id);
  }

  markFocused(webContentsId: number): void {
    const sessionId = this.webContentsToSessionId.get(webContentsId);
    if (!sessionId) return;
    const catalog = this.readCatalog();
    if (!catalog) return;

    const timestamp = this.nowIso();
    this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: sessionId,
      sessions: catalog.sessions.map((session) =>
        session.id === sessionId ? { ...session, focusedAt: timestamp } : session,
      ),
    });
  }

  saveLayout(
    webContentsId: number,
    input: WindowSessionSaveLayoutInput,
    bounds?: WindowSessionBounds,
  ): WindowSessionRecord {
    const assignedSessionId = this.webContentsToSessionId.get(webContentsId);
    if (!assignedSessionId || assignedSessionId !== input.sessionId) {
      throw new Error("Window Session save does not match the requesting window");
    }

    const catalog = this.readOrCreateCatalog();
    const session = catalog.sessions.find((entry) => entry.id === assignedSessionId);
    if (!session) {
      throw new Error("Assigned Window Session is unavailable");
    }
    if (input.revision <= session.layoutRevision) return session;

    const parsedLayout = WorkbenchLayoutSnapshotSchema.safeParse(input.layout);
    if (!parsedLayout.success) {
      throw new Error("Window Session layout is invalid");
    }

    const timestamp = this.nowIso();
    const normalizedBounds = normalizeSessionBounds(bounds);
    const nextSession: WindowSessionRecord = {
      ...session,
      layoutRevision: input.revision,
      layout: parsedLayout.data,
      updatedAt: timestamp,
      ...(normalizedBounds ? { bounds: normalizedBounds } : {}),
    };
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: nextSession.id,
      sessions: catalog.sessions.map((entry) =>
        entry.id === nextSession.id ? nextSession : entry,
      ),
    });
    return this.requireSession(written, nextSession.id);
  }

  updateBounds(webContentsId: number, bounds: WindowSessionBounds): void {
    const sessionId = this.webContentsToSessionId.get(webContentsId);
    if (!sessionId) return;
    const catalog = this.readCatalog();
    if (!catalog) return;
    const normalizedBounds = normalizeSessionBounds(bounds);
    if (!normalizedBounds) return;

    const timestamp = this.nowIso();
    this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: sessionId,
      sessions: catalog.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, bounds: normalizedBounds, updatedAt: timestamp }
          : session,
      ),
    });
  }

  getSessionIdForWindow(webContentsId: number): string | null {
    return this.webContentsToSessionId.get(webContentsId) ?? null;
  }

  getSessionForWindow(webContentsId: number): WindowSessionRecord | null {
    const sessionId = this.webContentsToSessionId.get(webContentsId);
    if (!sessionId) return null;
    const catalog = this.readCatalog();
    if (!catalog) return null;
    return catalog.sessions.find((session) => session.id === sessionId) ?? null;
  }

  readCatalog(): WindowSessionCatalog | null {
    const current = this.readCurrentCatalog();
    if (current) return current;
    if (fs.existsSync(this.statePath)) return null;
    return this.migrateLegacyCatalog();
  }

  readOrCreateCatalog(): WindowSessionCatalog {
    const existing = this.readCatalog();
    if (existing) return existing;

    const session = this.createSessionRecord(createDefaultWorkbenchLayoutSnapshot());
    return this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: session.id,
      sessions: [session],
    });
  }

  seedInitialProjectPresentation(presentation: InitialProjectPresentation): WindowSessionRecord {
    const catalog = this.readOrCreateCatalog();
    const target =
      catalog.sessions.find((session) => session.id === catalog.lastActiveSessionId) ??
      catalog.sessions[0];
    if (!target) {
      throw new Error("Initial Project has no Window Session presentation target");
    }

    const currentLocation = getWorkbenchSceneReturnLocation(target.layout.location);
    const sceneKey = makeWorkbenchSceneKey({
      kind: "project",
      projectId: presentation.projectId,
    });
    const currentScene = target.layout.scenesByOwnerKey[sceneKey];
    const alreadySeeded =
      currentLocation.kind === "project" &&
      currentLocation.projectId === presentation.projectId &&
      Object.values(currentScene?.panelSurfacesById ?? {}).some(
        (surface) =>
          surface.kind === "page_stage" &&
          surface.config.routingContext.kind === "project" &&
          surface.config.routingContext.projectId === presentation.projectId &&
          surface.config.pageId === presentation.starterPageId,
      );
    if (alreadySeeded) return target;

    const timestamp = this.nowIso();
    const scene = materializeInitialProjectWelcomeScene(presentation, { touchedAt: timestamp });
    const next: WindowSessionRecord = {
      ...target,
      layoutRevision: target.layoutRevision + 1,
      layout: {
        ...target.layout,
        location: {
          kind: "project",
          projectId: presentation.projectId,
        },
        scenesByOwnerKey: {
          ...target.layout.scenesByOwnerKey,
          [sceneKey]: scene,
        },
      },
      updatedAt: timestamp,
    };
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: target.id,
      sessions: catalog.sessions.map((session) => (session.id === target.id ? next : session)),
    });
    return this.requireSession(written, target.id);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private emptyCatalog(): WindowSessionCatalog {
    return {
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: "",
      sessions: [],
    };
  }

  private createSessionRecord(layout: WorkbenchLayoutSnapshot): WindowSessionRecord {
    const timestamp = this.nowIso();
    return {
      id: `window-${randomUUID()}`,
      lifecycle: { state: "open" },
      layoutRevision: 0,
      layout,
      createdAt: timestamp,
      updatedAt: timestamp,
      focusedAt: timestamp,
    };
  }

  private startFreshAndCloseOpenSessions(catalog: WindowSessionCatalog): WindowSessionRecord[] {
    const timestamp = this.nowIso();
    const fresh = this.createSessionRecord(createDefaultWorkbenchLayoutSnapshot());
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: fresh.id,
      sessions: [
        ...catalog.sessions.map((session): WindowSessionRecord => {
          if (session.lifecycle.state === "closed") return session;
          return {
            ...session,
            lifecycle: { state: "closed", closedAt: timestamp },
            updatedAt: timestamp,
          };
        }),
        fresh,
      ],
    });
    return [this.requireSession(written, fresh.id)];
  }

  private reopenClosedOrCreateFresh(catalog: WindowSessionCatalog): WindowSessionRecord[] {
    const previousRecord = this.mostRecentlyClosedSession(catalog.sessions);
    if (!previousRecord) {
      const fresh = this.createSessionRecord(createDefaultWorkbenchLayoutSnapshot());
      const written = this.writeCatalog({
        version: WINDOW_SESSION_VERSION,
        lastActiveSessionId: fresh.id,
        sessions: [...catalog.sessions, fresh],
      });
      return [this.requireSession(written, fresh.id)];
    }

    const timestamp = this.nowIso();
    const nextSession: WindowSessionRecord = {
      ...previousRecord,
      lifecycle: { state: "open" },
      updatedAt: timestamp,
    };
    const written = this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: nextSession.id,
      sessions: catalog.sessions.map((session) =>
        session.id === nextSession.id ? nextSession : session,
      ),
    });
    return [this.requireSession(written, nextSession.id)];
  }

  private readCurrentCatalog(): WindowSessionCatalog | null {
    let raw: string;
    try {
      const stats = fs.lstatSync(this.statePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Window Session catalog path is unsafe");
      }
      if (stats.size > this.maxFileBytes) {
        throw new Error("Window Session catalog exceeds its size bound");
      }
      raw = fs.readFileSync(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.preserveCorruptCatalog(error);
      return null;
    }

    try {
      const parsed = WindowSessionCatalogSchema.parse(JSON.parse(raw));
      return this.normalizeCatalog(parsed);
    } catch (error) {
      this.preserveCorruptCatalog(error);
      return null;
    }
  }

  private migrateLegacyCatalog(): WindowSessionCatalog | null {
    const legacyV2 = this.readLegacyJson(this.legacyV2StatePath);
    const parsedV2 = LegacyWindowSessionCatalogV2Schema.safeParse(legacyV2);
    if (parsedV2.success) {
      return this.writeCatalog({
        version: WINDOW_SESSION_VERSION,
        lastActiveSessionId: parsedV2.data.lastActiveSessionId,
        sessions: parsedV2.data.sessions.map((session) => ({
          ...session,
          lifecycle: { state: "open" },
        })),
      });
    }

    const legacyV1 = this.readLegacyJson(this.legacyV1StatePath);
    const parsedV1 = LegacyWindowSessionCatalogV1Schema.safeParse(legacyV1);
    if (!parsedV1.success) return null;
    return this.writeCatalog({
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: parsedV1.data.lastActiveSessionId,
      sessions: parsedV1.data.sessions.map((session) => ({
        ...session,
        lifecycle: { state: "open" },
        layoutRevision: 0,
      })),
    });
  }

  private readLegacyJson(filePath: string): unknown {
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) return null;
      if (stats.size > this.maxFileBytes) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  private normalizeCatalog(catalog: WindowSessionCatalog): WindowSessionCatalog {
    const fallbackLayout = createDefaultWorkbenchLayoutSnapshot();
    const seen = new Set<string>();
    const sessions = catalog.sessions
      .filter((session) => {
        if (seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      })
      .map((session) => ({
        ...session,
        layout: ensureBrowserStorageIdentities(
          normalizeLayout(session.layout, fallbackLayout),
          session.id,
        ),
        bounds: normalizeSessionBounds(session.bounds),
      }));
    return {
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: this.resolveLastActiveSessionId(sessions, catalog.lastActiveSessionId),
      sessions,
    };
  }

  private prepareCatalog(catalog: WindowSessionCatalog): PreparedCatalog {
    const normalized = this.normalizeCatalog(catalog);
    const rankedClosed = this.rankClosedSessions(normalized.sessions);
    const retainedClosedIds = new Set(
      rankedClosed.slice(0, this.maxClosedSessions).map((session) => session.id),
    );
    let sessions = normalized.sessions.filter(
      (session) => session.lifecycle.state === "open" || retainedClosedIds.has(session.id),
    );
    let compacted = this.catalogWithSessions(normalized, sessions);
    let serialized = serializeCatalog(compacted);
    const oldestRetained = rankedClosed
      .filter((session) => retainedClosedIds.has(session.id))
      .reverse();

    while (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes && oldestRetained.length > 0) {
      const oldest = oldestRetained.shift();
      if (!oldest) break;
      sessions = sessions.filter((session) => session.id !== oldest.id);
      compacted = this.catalogWithSessions(normalized, sessions);
      serialized = serializeCatalog(compacted);
    }

    if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes) {
      throw new Error("Window Session catalog exceeds its size bound");
    }

    return {
      catalog: WindowSessionCatalogSchema.parse(compacted),
      serialized,
    };
  }

  private catalogWithSessions(
    source: WindowSessionCatalog,
    sessions: WindowSessionRecord[],
  ): WindowSessionCatalog {
    return {
      version: WINDOW_SESSION_VERSION,
      lastActiveSessionId: this.resolveLastActiveSessionId(sessions, source.lastActiveSessionId),
      sessions,
    };
  }

  private resolveLastActiveSessionId(sessions: WindowSessionRecord[], requestedId: string): string {
    if (sessions.some((session) => session.id === requestedId)) return requestedId;
    return this.mostRecentlyFocusedSession(sessions)?.id ?? "";
  }

  private mostRecentlyFocusedSession(sessions: WindowSessionRecord[]): WindowSessionRecord | null {
    return (
      sessions
        .map((session, index) => ({ session, index }))
        .sort(
          (left, right) =>
            compareTimestampsDescending(left.session.focusedAt, right.session.focusedAt) ||
            right.index - left.index,
        )[0]?.session ?? null
    );
  }

  private rankClosedSessions(sessions: WindowSessionRecord[]): ClosedWindowSessionRecord[] {
    return sessions
      .map((session, index) => ({ session, index }))
      .filter(
        (
          entry,
        ): entry is {
          session: ClosedWindowSessionRecord;
          index: number;
        } => entry.session.lifecycle.state === "closed",
      )
      .sort(
        (left, right) =>
          compareTimestampsDescending(
            left.session.lifecycle.closedAt,
            right.session.lifecycle.closedAt,
          ) ||
          compareTimestampsDescending(left.session.focusedAt, right.session.focusedAt) ||
          right.index - left.index,
      )
      .map((entry) => entry.session);
  }

  private mostRecentlyClosedSession(
    sessions: WindowSessionRecord[],
  ): ClosedWindowSessionRecord | null {
    return this.rankClosedSessions(sessions)[0] ?? null;
  }

  private requireSession(catalog: WindowSessionCatalog, sessionId: string): WindowSessionRecord {
    const session = catalog.sessions.find((entry) => entry.id === sessionId);
    if (session) return session;
    throw new Error("Window Session was not retained");
  }

  private preserveCorruptCatalog(error: unknown): void {
    const timestamp = this.nowIso().replaceAll(/[:.]/g, "-");
    const corruptPath = `${this.statePath}.${timestamp}.corrupt`;
    try {
      fs.renameSync(this.statePath, corruptPath);
      logger.warn("Preserved malformed Window Session catalog", {
        corruptFileName: path.basename(corruptPath),
        reason: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
    } catch {
      // A concurrent read may already have preserved the same invalid file.
    }
  }

  private writeCatalog(catalog: WindowSessionCatalog): WindowSessionCatalog {
    const directory = path.dirname(this.statePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Window Session catalog directory is unsafe");
    }
    if (isSymlink(this.statePath)) {
      throw new Error("Window Session catalog target is a symlink");
    }

    const prepared = this.prepareCatalog(catalog);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.statePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, prepared.serialized, { encoding: "utf8" });
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, this.statePath);
      fs.chmodSync(this.statePath, 0o600);
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The rename may already have committed the replacement.
      }
      throw error;
    }
    return prepared.catalog;
  }
}

export const windowSessionStateTestHelpers = {
  isWindowSessionBoundsVisible,
  legacyV1FileName: WINDOW_SESSIONS_V1_FILE_NAME,
  legacyV2FileName: WINDOW_SESSIONS_V2_FILE_NAME,
  stateFileName: WINDOW_SESSIONS_V3_FILE_NAME,
};
