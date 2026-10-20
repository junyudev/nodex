import { describe, expect, test } from "vite-plus/test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultWorkbenchLayoutSnapshot,
  createDefaultWorkbenchLayoutSnapshotV3,
  createDefaultWorkbenchLayoutSnapshotV4,
  type WorkbenchLayoutSnapshot,
} from "../shared/workbench-layout";
import {
  createWorkbenchSessionViewTab,
  materializeInitialWorkbenchSessionView,
} from "../shared/workbench-session-view";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../shared/workbench-scene";
import { WindowSessionState, windowSessionStateTestHelpers } from "./window-session-state";

function withTempUserData(run: (userDataPath: string) => void): void {
  const userDataPath = mkdtempSync(join(tmpdir(), "nodex-window-sessions-"));
  try {
    run(userDataPath);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
}

function createClock(start = "2026-07-24T00:00:00.000Z") {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance: (milliseconds = 1_000) => {
      current += milliseconds;
    },
  };
}

function makeLayout(_legacyStage: string, dbProjectId: string): WorkbenchLayoutSnapshot {
  return {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: {
      kind: "project",
      projectId: dbProjectId,
    },
  };
}

function getActiveProjectId(layout: WorkbenchLayoutSnapshot): string | null {
  const location =
    layout.location.kind === "settings" || layout.location.kind === "automations"
      ? layout.location.returnTo
      : layout.location;
  if (location.kind === "project") return location.projectId;
  if (location.kind === "session") return location.projectContextId;
  return null;
}

function saveLayout(
  state: WindowSessionState,
  webContentsId: number,
  sessionId: string,
  revision: number,
  layout: WorkbenchLayoutSnapshot,
) {
  return state.saveLayout(webContentsId, {
    sessionId,
    revision,
    layout,
  });
}

describe("WindowSessionState", () => {
  test("creates a fresh open versioned Window Session", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const session = state.createFreshSession();
      const catalog = state.readCatalog();

      expect(session.lifecycle).toEqual({ state: "open" });
      expect(session.layoutRevision).toBe(0);
      expect(session.layout.version).toBe(9);
      expect(getActiveProjectId(session.layout)).toBeNull();
      expect(catalog?.version).toBe(3);
      expect(catalog?.sessions).toHaveLength(1);
      expect(catalog?.lastActiveSessionId).toBe(session.id);
    });
  });

  test("seeds one durable active Welcome presentation idempotently", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const initial = state.createFreshSession();
      const presentation = {
        projectId: "project-default",
        starterPageId: "page-welcome",
        starterPageTitle: "Welcome to Nodex",
      };

      const seeded = state.seedInitialProjectPresentation(presentation);
      const replayed = state.seedInitialProjectPresentation(presentation);
      const restarted = new WindowSessionState(userDataPath)
        .readCatalog()
        ?.sessions.find((session) => session.id === initial.id);
      const scene = restarted?.layout.scenesByOwnerKey[`project:${presentation.projectId}`];

      expect(seeded.id).toBe(initial.id);
      expect(replayed).toEqual(seeded);
      expect(replayed.layoutRevision).toBe(1);
      expect(restarted?.layout.location).toEqual({
        kind: "project",
        projectId: presentation.projectId,
      });
      // The Project opens on its Inbox Home, with the Welcome Page beside it.
      expect(scene?.primary).toMatchObject({
        kind: "inbox",
        config: { scope: { kind: "project", projectId: presentation.projectId } },
      });
      expect(Object.values(scene?.panelSurfacesById ?? {}).map((surface) => surface.kind)).toEqual([
        "page_stage",
      ]);
    });
  });

  test("restores all open sessions without reopening deliberately closed history", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);
      clock.advance();
      state.detachWindow(2, { disposition: "user-close" });

      const restored = new WindowSessionState(userDataPath, {
        now: clock.now,
      }).selectStartupSessions("all");

      expect(restored.map((session) => session.id)).toEqual([first.id]);
      expect(
        state.readCatalog()?.sessions.find((session) => session.id === second.id)?.lifecycle.state,
      ).toBe("closed");
    });
  });

  test("restores the last-active open session first", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);
      clock.advance();
      state.markFocused(1);

      const restored = new WindowSessionState(userDataPath, {
        now: clock.now,
      }).selectStartupSessions("all");

      expect(restored.map((session) => session.id)).toEqual([first.id, second.id]);
    });
  });

  test("last-window demotes other open sessions into recoverable history", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      clock.advance();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);
      clock.advance();
      state.markFocused(1);

      const restarted = new WindowSessionState(userDataPath, { now: clock.now });
      clock.advance();
      const restored = restarted.selectStartupSessions("last-window");
      const catalog = restarted.readCatalog();

      expect(restored.map((session) => session.id)).toEqual([first.id]);
      expect(catalog?.sessions.find((session) => session.id === first.id)?.lifecycle).toEqual({
        state: "open",
      });
      expect(
        catalog?.sessions.find((session) => session.id === second.id)?.lifecycle,
      ).toMatchObject({ state: "closed" });
      expect(restarted.reopenMostRecentlyClosedSession()?.session.id).toBe(second.id);
    });
  });

  test("none starts fresh while preserving prior windows as closed history", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      clock.advance();
      const second = state.createFreshSession();

      const fresh = state.selectStartupSessions("none");
      const catalog = state.readCatalog();

      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.id).not.toBe(first.id);
      expect(fresh[0]?.id).not.toBe(second.id);
      expect(fresh[0]?.lifecycle).toEqual({ state: "open" });
      expect(
        catalog?.sessions
          .filter((session) => session.lifecycle.state === "closed")
          .map((session) => session.id),
      ).toEqual([first.id, second.id]);
    });
  });

  test.each(["all", "last-window"] as const)(
    "%s recovers the latest closed session when no open session remains",
    (policy) => {
      withTempUserData((userDataPath) => {
        const clock = createClock();
        const state = new WindowSessionState(userDataPath, { now: clock.now });
        const first = state.createFreshSession();
        state.attachWindow(1, first.id);
        clock.advance();
        state.detachWindow(1, { disposition: "user-close" });
        const second = state.createFreshSession();
        state.attachWindow(2, second.id);
        clock.advance();
        state.detachWindow(2, { disposition: "user-close" });

        const restored = new WindowSessionState(userDataPath, {
          now: clock.now,
        }).selectStartupSessions(policy);

        expect(restored.map((session) => session.id)).toEqual([second.id]);
        expect(restored[0]?.lifecycle).toEqual({ state: "open" });
      });
    },
  );

  test("closes and reopens the exact Window Session and nested view identities", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const session = state.createFreshSession();
      state.attachWindow(1, session.id);
      const owner = {
        kind: "session",
        sessionId: "project-session-1",
      } as const;
      const sessionScene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(owner), {
        panelId: "right",
        surface: {
          id: "database-surface",
          kind: "db_view",
          titleSnapshot: "Database",
          config: {
            routingContext: { kind: "project", projectId: "project-1" },
            target: {
              kind: "database-view",
              databaseViewId: "view-1",
            },
          },
          stateKey: 0,
          state: null,
        },
      });
      const sceneKey = makeWorkbenchSceneKey(owner);
      const layout = {
        ...makeLayout("threads", "project-1"),
        location: {
          kind: "session" as const,
          sessionId: "project-session-1",
          projectContextId: "project-1",
        },
        scenesByOwnerKey: {
          [sceneKey]: sessionScene,
        },
      };
      saveLayout(state, 1, session.id, 1, layout);
      const sourceSurfaceIds = Object.keys(sessionScene.panelSurfacesById);

      clock.advance();
      const closed = state.detachWindow(1, {
        disposition: "user-close",
        bounds: {
          x: 10,
          y: 20,
          width: 1_200,
          height: 800,
          mode: "normal",
        },
      });
      const reopened = state.reopenMostRecentlyClosedSession();

      expect(closed?.id).toBe(session.id);
      expect(closed?.lifecycle).toEqual({
        state: "closed",
        closedAt: "2026-07-24T00:00:01.000Z",
      });
      expect(reopened?.session.id).toBe(session.id);
      expect(reopened?.session.lifecycle).toEqual({ state: "open" });
      expect(
        Object.keys(reopened?.session.layout.scenesByOwnerKey[sceneKey]?.panelSurfacesById ?? {}),
      ).toEqual(sourceSurfaceIds);
      expect(reopened?.session.bounds).toMatchObject({ x: 10, y: 20 });
      expect(state.reopenMostRecentlyClosedSession()).toBeNull();
    });
  });

  test("reopens multiple windows in reverse close order", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);
      clock.advance();
      state.detachWindow(1, { disposition: "user-close" });
      clock.advance();
      state.detachWindow(2, { disposition: "user-close" });

      expect(state.reopenMostRecentlyClosedSession()?.session.id).toBe(second.id);
      expect(state.reopenMostRecentlyClosedSession()?.session.id).toBe(first.id);
      expect(state.reopenMostRecentlyClosedSession()).toBeNull();
    });
  });

  test("acquires a closed session before cloning the requesting window", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);
      saveLayout(state, 2, second.id, 1, makeLayout("threads", "project-2"));
      clock.advance();
      state.detachWindow(2, { disposition: "user-close" });

      const acquired = state.acquireSessionForNewWindow(1);

      expect(acquired.kind).toBe("reopened");
      expect(acquired.session.id).toBe(second.id);
      expect(getActiveProjectId(acquired.session.layout)).toBe("project-2");
      expect(state.readCatalog()?.sessions).toHaveLength(2);
    });
  });

  test("acquires a clone when no closed session remains and fresh state without a source", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const source = state.createFreshSession();
      state.attachWindow(1, source.id);
      saveLayout(state, 1, source.id, 1, makeLayout("files", "project-1"));

      const cloned = state.acquireSessionForNewWindow(1);
      const fresh = state.acquireSessionForNewWindow();

      expect(cloned.kind).toBe("cloned");
      expect(cloned.session.id).not.toBe(source.id);
      expect(getActiveProjectId(cloned.session.layout)).toBe("project-1");
      expect(fresh.kind).toBe("fresh");
      expect(getActiveProjectId(fresh.session.layout)).toBeNull();
    });
  });

  test("rolls a failed reopen back to its exact closed record", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, { now: clock.now });
      const session = state.createFreshSession();
      state.attachWindow(1, session.id);
      clock.advance();
      state.detachWindow(1, { disposition: "user-close" });
      const reopened = state.reopenMostRecentlyClosedSession();
      if (!reopened) throw new Error("Expected a reopen candidate");

      clock.advance();
      const rolledBack = state.rollbackReopenSession(reopened.previousRecord);

      expect(rolledBack).toEqual(reopened.previousRecord);
      expect(state.reopenMostRecentlyClosedSession()?.session.id).toBe(session.id);
    });
  });

  test("app quit and unexpected teardown keep sessions open for recovery", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);
      state.attachWindow(2, second.id);

      state.detachWindow(1, { disposition: "app-quit" });
      state.detachWindow(2, { disposition: "unexpected" });

      expect(state.readCatalog()?.sessions.map((session) => session.lifecycle.state)).toEqual([
        "open",
        "open",
      ]);
      expect(state.getSessionForWindow(1)).toBeNull();
      expect(state.getSessionForWindow(2)).toBeNull();
    });
  });

  test("rejects attaching one session twice or replacing a window assignment", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const first = state.createFreshSession();
      const second = state.createFreshSession();
      state.attachWindow(1, first.id);

      expect(() => state.attachWindow(2, first.id)).toThrow(/already attached/);
      expect(() => state.attachWindow(1, second.id)).toThrow(/already owns/);
      expect(state.attachWindow(1, first.id).id).toBe(first.id);
    });
  });

  test("clones the requesting window, remints view identities, then diverges", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const source = state.createFreshSession();
      state.attachWindow(1, source.id);
      const owner = {
        kind: "session",
        sessionId: "project-session-1",
      } as const;
      const sessionScene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(owner), {
        panelId: "right",
        surface: {
          id: "database-surface",
          kind: "db_view",
          titleSnapshot: "Database",
          config: {
            routingContext: { kind: "project", projectId: "project-1" },
            target: {
              kind: "database-view",
              databaseViewId: "view-1",
            },
          },
          stateKey: 0,
          state: null,
        },
      });
      const sceneKey = makeWorkbenchSceneKey(owner);
      const sourceLayout = {
        ...makeLayout("threads", "project-1"),
        location: {
          kind: "session" as const,
          sessionId: "project-session-1",
          projectContextId: "project-1",
        },
        scenesByOwnerKey: {
          [sceneKey]: sessionScene,
        },
      };
      saveLayout(state, 1, source.id, 1, sourceLayout);

      const clone = state.cloneSessionForWindow(1, {
        activeProjectSessionId: "project-session-1",
        activeProjectId: "project-1",
      });
      const sourceSurfaceIds = Object.keys(
        sourceLayout.scenesByOwnerKey[sceneKey]!.panelSurfacesById,
      );
      const cloneSurfaceIds = Object.keys(
        clone.layout.scenesByOwnerKey[sceneKey]!.panelSurfacesById,
      );
      expect(clone.lifecycle).toEqual({ state: "open" });
      expect(cloneSurfaceIds).not.toEqual(sourceSurfaceIds);
      expect(getActiveProjectId(clone.layout)).toBe("project-1");
      expect(clone.layoutRevision).toBe(0);

      state.attachWindow(2, clone.id);
      const cloneScene = clone.layout.scenesByOwnerKey[sceneKey]!;
      const divergentScene = createWorkbenchSceneSurface(cloneScene, {
        panelId: "bottom",
        surface: {
          id: "clone-only-tab",
          kind: "page_stage",
          titleSnapshot: "Clone only",
          config: {
            routingContext: { kind: "project", projectId: "project-1" },
            pageId: "page-1",
          },
          stateKey: 0,
          state: null,
        },
      });
      saveLayout(state, 2, clone.id, 1, {
        ...clone.layout,
        scenesByOwnerKey: {
          ...clone.layout.scenesByOwnerKey,
          [sceneKey]: divergentScene,
        },
      });

      const reloaded = new WindowSessionState(userDataPath).readCatalog();
      const reloadedSource = reloaded?.sessions.find((entry) => entry.id === source.id);
      const reloadedClone = reloaded?.sessions.find((entry) => entry.id === clone.id);
      expect(
        reloadedSource?.layout.scenesByOwnerKey[sceneKey]?.panelSurfacesById["clone-only-tab"],
      ).toBeUndefined();
      expect(
        reloadedClone?.layout.scenesByOwnerKey[sceneKey]?.panelSurfacesById["clone-only-tab"],
      ).toBeDefined();
    });
  });

  test("rejects stale and cross-window layout saves", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const session = state.createFreshSession();
      state.attachWindow(1, session.id);

      const accepted = saveLayout(state, 1, session.id, 8, makeLayout("pages", "new"));
      const stale = saveLayout(state, 1, session.id, 7, makeLayout("files", "stale"));

      expect(accepted.layoutRevision).toBe(8);
      expect(stale.layoutRevision).toBe(8);
      expect(getActiveProjectId(stale.layout)).toBe("new");
      expect(() => saveLayout(state, 2, session.id, 9, makeLayout("files", "wrong"))).toThrow(
        /does not match/,
      );
    });
  });

  test("migrates v2 records as open and preserves the source file", () => {
    withTempUserData((userDataPath) => {
      const legacyPath = join(userDataPath, windowSessionStateTestHelpers.legacyV2FileName);
      writeFileSync(
        legacyPath,
        JSON.stringify({
          version: 2,
          lastActiveSessionId: "legacy-window",
          sessions: [
            {
              id: "legacy-window",
              layoutRevision: 7,
              layout: {
                ...createDefaultWorkbenchLayoutSnapshotV3(),
                dbProjectId: "legacy",
                focusedStage: "files",
              },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              focusedAt: "2026-01-03T00:00:00.000Z",
              bounds: {
                x: 10,
                y: 20,
                width: 1_200,
                height: 800,
                mode: "normal",
              },
            },
          ],
        }),
      );

      const migrated = new WindowSessionState(userDataPath).readCatalog();

      expect(migrated?.version).toBe(3);
      expect(migrated?.sessions[0]).toMatchObject({
        id: "legacy-window",
        lifecycle: { state: "open" },
        layoutRevision: 7,
        layout: {
          version: 9,
          location: {
            kind: "project",
            projectId: "legacy",
          },
        },
        bounds: { x: 10, y: 20 },
      });
      expect(existsSync(legacyPath)).toBe(true);
      expect(readdirSync(userDataPath)).toContain(windowSessionStateTestHelpers.stateFileName);
    });
  });

  test("migrates v1 layouts once and preserves them as recovery input", () => {
    withTempUserData((userDataPath) => {
      const legacyLayout: Record<string, unknown> = {
        ...createDefaultWorkbenchLayoutSnapshotV3(),
        dbProjectId: "legacy",
        focusedStage: "files",
        version: 2,
      };
      delete legacyLayout.sessionViewsBySessionId;
      const legacyPath = join(userDataPath, windowSessionStateTestHelpers.legacyV1FileName);
      writeFileSync(
        legacyPath,
        JSON.stringify({
          version: 1,
          lastActiveSessionId: "legacy-window",
          sessions: [
            {
              id: "legacy-window",
              layout: legacyLayout,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              focusedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );

      const migrated = new WindowSessionState(userDataPath).readCatalog();

      expect(migrated?.version).toBe(3);
      expect(migrated?.sessions[0]).toMatchObject({
        id: "legacy-window",
        lifecycle: { state: "open" },
        layoutRevision: 0,
        layout: {
          version: 9,
          location: {
            kind: "project",
            projectId: "legacy",
          },
          scenesByOwnerKey: {},
        },
      });
      expect(readFileSync(legacyPath, "utf8")).toContain('"version":1');
      expect(readdirSync(userDataPath)).toContain(windowSessionStateTestHelpers.stateFileName);
    });
  });

  test("migrates Browser storage identity once per Window Session", () => {
    withTempUserData((userDataPath) => {
      let view = materializeInitialWorkbenchSessionView({
        id: "project-session-1",
        projectId: "project-1",
        databaseViewId: null,
      });
      view = createWorkbenchSessionViewTab(view, {
        panelId: "right",
        tab: {
          id: "browser-tab",
          kind: "browser",
          titleSnapshot: "Browser",
          config: {
            browserTabId: "shared-browser-tab",
            url: "https://example.com",
          },
          stateKey: 0,
          state: null,
        },
      });
      const legacyView = {
        ...view,
        version: 1,
      };
      const layout = {
        ...createDefaultWorkbenchLayoutSnapshotV4(),
        sessionViewsBySessionId: {
          "project-session-1": legacyView,
        },
      };
      const timestamp = "2026-07-29T00:00:00.000Z";
      writeFileSync(
        join(userDataPath, windowSessionStateTestHelpers.stateFileName),
        JSON.stringify({
          version: 3,
          lastActiveSessionId: "window-a",
          sessions: ["window-a", "window-b"].map((id) => ({
            id,
            lifecycle: { state: "open" },
            layoutRevision: 1,
            layout,
            createdAt: timestamp,
            updatedAt: timestamp,
            focusedAt: timestamp,
          })),
        }),
      );

      const migrated = new WindowSessionState(userDataPath).readCatalog();
      const storageIds = migrated?.sessions.map((session) => {
        const surface =
          session.layout.scenesByOwnerKey["session:project-session-1"]?.panelSurfacesById[
            "browser-tab"
          ];
        return surface?.kind === "browser" ? surface.config.browserStorageId : undefined;
      });

      expect(storageIds?.[0]).toMatch(/^browser:migrated:[a-f0-9]{64}$/u);
      expect(storageIds?.[1]).toMatch(/^browser:migrated:[a-f0-9]{64}$/u);
      expect(storageIds?.[0]).not.toBe(storageIds?.[1]);
    });
  });

  test("preserves a malformed v3 catalog and recovers with a fresh one", () => {
    withTempUserData((userDataPath) => {
      const statePath = join(userDataPath, windowSessionStateTestHelpers.stateFileName);
      writeFileSync(statePath, "{not-json");
      const state = new WindowSessionState(userDataPath);

      const catalog = state.readOrCreateCatalog();
      const files = readdirSync(userDataPath);

      expect(catalog.version).toBe(3);
      expect(catalog.sessions).toHaveLength(1);
      expect(files.some((file) => file.endsWith(".corrupt"))).toBe(true);
      expect(files).toContain(windowSessionStateTestHelpers.stateFileName);
    });
  });

  test("retains only the newest closed sessions without evicting open ones", () => {
    withTempUserData((userDataPath) => {
      const clock = createClock();
      const state = new WindowSessionState(userDataPath, {
        now: clock.now,
        maxClosedSessions: 2,
      });
      const closedIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const session = state.createFreshSession();
        state.attachWindow(index + 1, session.id);
        clock.advance();
        state.detachWindow(index + 1, { disposition: "user-close" });
        closedIds.push(session.id);
      }
      const open = state.createFreshSession();
      const catalog = state.readCatalog();

      expect(catalog?.sessions.some((session) => session.id === closedIds[0])).toBe(false);
      expect(
        catalog?.sessions
          .filter((session) => session.lifecycle.state === "closed")
          .map((session) => session.id),
      ).toEqual(closedIds.slice(1));
      expect(catalog?.sessions.find((session) => session.id === open.id)?.lifecycle).toEqual({
        state: "open",
      });
    });
  });

  test("evicts oldest closed history to keep an open catalog within its byte bound", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath, {
        maxFileBytes: 1_000,
      });
      const closed = state.createFreshSession();
      state.attachWindow(1, closed.id);
      state.detachWindow(1, { disposition: "user-close" });

      const open = state.createFreshSession();
      const catalog = state.readCatalog();
      const statePath = join(userDataPath, windowSessionStateTestHelpers.stateFileName);

      expect(catalog?.sessions.map((session) => session.id)).toEqual([open.id]);
      expect(catalog?.sessions[0]?.lifecycle).toEqual({ state: "open" });
      expect(statSync(statePath).size).toBeLessThanOrEqual(1_000);
    });
  });

  test("bootstraps the assigned session and normalizes bounds during saves", () => {
    withTempUserData((userDataPath) => {
      const state = new WindowSessionState(userDataPath);
      const session = state.createFreshSession();
      state.attachWindow(7, session.id);
      expect(state.bootstrap(7).id).toBe(session.id);

      const saved = state.saveLayout(
        7,
        {
          sessionId: session.id,
          revision: 1,
          layout: makeLayout("files", "bounded"),
        },
        {
          x: 10.2,
          y: 20.7,
          width: 1000.4,
          height: 800.8,
          mode: "normal",
        },
      );

      expect(saved.bounds).toMatchObject({
        x: 10,
        y: 21,
        width: 1000,
        height: 801,
      });
      expect(getActiveProjectId(saved.layout)).toBe("bounded");
    });
  });

  test("validates saved window bounds against displays", () => {
    const visible = windowSessionStateTestHelpers.isWindowSessionBoundsVisible(
      { x: 10, y: 10, width: 1000, height: 800, mode: "normal" },
      [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    );
    const offscreen = windowSessionStateTestHelpers.isWindowSessionBoundsVisible(
      { x: 3000, y: 3000, width: 1000, height: 800, mode: "normal" },
      [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    );

    expect(visible).toBe(true);
    expect(offscreen).toBe(false);
  });
});
