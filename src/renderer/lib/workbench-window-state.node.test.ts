import { describe, expect, test } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
} from "../../shared/workbench-scene";
import {
  closeWorkbenchRoute,
  createWorkbenchWindowState,
  navigateBackInWorkbenchWindow,
  navigateForwardInWorkbenchWindow,
  navigateWorkbenchWindow,
  openWorkbenchRoute,
  reconcileMissingWorkbenchSession,
  selectWorkbenchProject,
  selectWorkbenchPages,
  selectWorkbenchSession,
  snapshotWorkbenchWindowState,
  updateWorkbenchScene,
  updateWorkbenchSceneAndNavigate,
} from "./workbench-window-state";

describe("WorkbenchWindowState", () => {
  test("selecting a projectless Session preserves Project context", () => {
    const state = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: {
        kind: "project",
        projectId: "alpha",
      },
    });

    const selected = selectWorkbenchSession(state, {
      id: "session:projectless",
      projectId: null,
    });

    expect(selected.location).toEqual({
      kind: "session",
      sessionId: "session:projectless",
      projectContextId: "alpha",
    });
  });

  test("selecting a Project navigates directly without selecting a Session", () => {
    const state = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: {
        kind: "session",
        sessionId: "session:alpha",
        projectContextId: "alpha",
      },
    });

    expect(selectWorkbenchProject(state, "alpha").location).toEqual({
      kind: "project",
      projectId: "alpha",
    });
  });

  test("routes retain a Scene return location and close atomically", () => {
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: {
        kind: "session",
        sessionId: "session:alpha",
        projectContextId: "alpha",
      },
    });
    const routed = openWorkbenchRoute(initial, {
      kind: "settings",
      path: "/settings/keyboard-shortcuts",
    });

    expect(routed.location).toEqual({
      kind: "settings",
      path: "/settings/keyboard-shortcuts",
      returnTo: initial.location,
    });
    expect(closeWorkbenchRoute(routed).location).toEqual(initial.location);
  });

  test("back and forward apply history without recording themselves", () => {
    const initial = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const settings = openWorkbenchRoute(initial, {
      kind: "settings",
      path: "/settings/general",
    });
    const automations = openWorkbenchRoute(settings, {
      kind: "automations",
      path: "/automations",
    });

    const back = navigateBackInWorkbenchWindow(automations);
    const forward = navigateForwardInWorkbenchWindow(back);

    expect(back.location.kind).toBe("settings");
    expect(back.history.backStack).toHaveLength(1);
    expect(back.history.forwardStack).toHaveLength(1);
    expect(forward.location.kind).toBe("automations");
    expect(forward.history.backStack).toHaveLength(2);
    expect(forward.history.forwardStack).toHaveLength(0);
  });

  test("the Pages Scene participates in shared window history", () => {
    const initial = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const pages = selectWorkbenchPages(initial);
    const settings = openWorkbenchRoute(pages, {
      kind: "settings",
      path: "/settings/general",
    });

    const pagesAgain = navigateBackInWorkbenchWindow(settings);
    const emptyAgain = navigateBackInWorkbenchWindow(pagesAgain);
    const pagesForward = navigateForwardInWorkbenchWindow(emptyAgain);

    expect(pagesAgain.location).toEqual(pages.location);
    expect(emptyAgain.location).toEqual(initial.location);
    expect(pagesForward.location).toEqual(pages.location);
    expect(pagesForward.history.forwardStack).toHaveLength(1);
  });

  test("opens the Pages Scene atomically from another auxiliary route", () => {
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "project", projectId: "alpha" },
    });
    const settings = openWorkbenchRoute(initial, {
      kind: "settings",
      path: "/settings/general",
    });
    const pages = selectWorkbenchPages(settings);

    expect(pages.location).toEqual({ kind: "pages" });
    expect(navigateBackInWorkbenchWindow(pages).location).toEqual(settings.location);
  });

  test("records Pages surface creation and selection as one history entry", () => {
    const owner = { kind: "pages" } as const;
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "project", projectId: "alpha" },
    });
    const presented = updateWorkbenchSceneAndNavigate(
      initial,
      owner,
      (previous) =>
        createWorkbenchSceneSurface(previous ?? materializeInitialWorkbenchScene(owner), {
          panelId: "right",
          surface: {
            id: "page:one",
            kind: "page_stage",
            titleSnapshot: "Page One",
            config: {
              routingContext: { kind: "library" },
              pageId: "page:one",
            },
            stateKey: 0,
            state: null,
          },
        }),
      { kind: "pages" },
    );

    expect(presented.history.backStack).toHaveLength(1);
    expect(presented.location).toEqual({ kind: "pages" });
    const back = navigateBackInWorkbenchWindow(presented);
    expect(back.location).toEqual(initial.location);
    expect(back.scenesByOwnerKey.pages).toBeUndefined();
  });

  test("Pages replacement does not add history and divergent navigation clears forward", () => {
    const initial = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const pages = selectWorkbenchPages(initial);
    const emptyAgain = navigateBackInWorkbenchWindow(pages);
    const project = selectWorkbenchProject(emptyAgain, "alpha");
    const replacement = navigateWorkbenchWindow(project, { kind: "pages" }, { record: false });

    expect(project.history.forwardStack).toHaveLength(0);
    expect(replacement.history).toEqual(project.history);
    expect(replacement.location).toEqual(pages.location);
    expect(navigateWorkbenchWindow(replacement, replacement.location)).toBe(replacement);
  });

  test("back and forward restore the Scene snapshot atomically", () => {
    const owner = { kind: "session", sessionId: "session:alpha" } as const;
    const scene = patchWorkbenchScenePanel(materializeInitialWorkbenchScene(owner), "right", {
      collapsed: false,
    });
    const sceneKey = makeWorkbenchSceneKey(owner);
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: {
        kind: "session",
        sessionId: "session:alpha",
        projectContextId: "alpha",
      },
      scenesByOwnerKey: { [sceneKey]: scene },
    });
    const collapsed = updateWorkbenchScene(initial, owner, (current) =>
      patchWorkbenchScenePanel(current!, "right", { collapsed: true }),
    );

    expect(collapsed.scenesByOwnerKey[sceneKey]?.panels.right.collapsed).toBe(true);
    const back = navigateBackInWorkbenchWindow(collapsed);
    expect(back.scenesByOwnerKey[sceneKey]?.panels.right.collapsed).toBe(false);
    const forward = navigateForwardInWorkbenchWindow(back);
    expect(forward.scenesByOwnerKey[sceneKey]?.panels.right.collapsed).toBe(true);
  });

  test("updates composer overlay state without recording navigation history", () => {
    const owner = { kind: "session", sessionId: "session:alpha" } as const;
    const scene = materializeInitialWorkbenchScene(owner);
    const sceneKey = makeWorkbenchSceneKey(owner);
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: {
        kind: "session",
        sessionId: "session:alpha",
        projectContextId: "alpha",
      },
      scenesByOwnerKey: { [sceneKey]: scene },
    });

    const hidden = updateWorkbenchScene(
      initial,
      owner,
      (current) => ({
        ...current!,
        composerOverlay: { visible: false },
      }),
      { recordHistory: false },
    );

    expect(hidden.scenesByOwnerKey[sceneKey]?.composerOverlay.visible).toBe(false);
    expect(hidden.history).toEqual(initial.history);
    expect(snapshotWorkbenchWindowState(hidden).scenesByOwnerKey[sceneKey]).toEqual(
      hidden.scenesByOwnerKey[sceneKey],
    );
  });

  test("only an authoritative missing Session reconciles to Project", () => {
    const location = {
      kind: "settings",
      path: "/settings/general",
      returnTo: {
        kind: "session",
        sessionId: "session:deleted",
        projectContextId: "alpha",
      },
    } as const;
    const state = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
    });

    const reconciled = reconcileMissingWorkbenchSession(state, "session:deleted");

    expect(reconciled.location).toEqual({
      ...location,
      returnTo: {
        kind: "project",
        projectId: "alpha",
      },
    });
    expect(reconcileMissingWorkbenchSession(state, "session:another")).toBe(state);
  });

  test("persistence folds pending worktree to the return route", () => {
    const state = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const pending = openWorkbenchRoute(state, {
      kind: "pending-worktree",
      clientThreadId: "client:one",
    });

    expect(snapshotWorkbenchWindowState(pending).location).toEqual({
      kind: "empty",
    });
  });
});
