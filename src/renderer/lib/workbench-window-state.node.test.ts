import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  getWorkbenchPrimaryDestination,
  getWorkbenchSceneReturnLocation,
  type WorkbenchHomeLocation,
} from "../../shared/workbench-layout";
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
  presentWorkbenchScheduledSession,
  reconcileMissingWorkbenchSession,
  selectWorkbenchProject,
  selectWorkbenchPages,
  selectWorkbenchHome,
  selectWorkbenchSession,
  snapshotWorkbenchWindowState,
  updateWorkbenchScene,
  updateWorkbenchSceneAndNavigate,
  removeWorkbenchScene,
} from "./workbench-window-state";

describe("WorkbenchWindowState", () => {
  test.each([{ kind: "inbox" as const }])(
    "Settings retains its stable $kind origin after leaving Space",
    (route) => {
      const pages = selectWorkbenchPages(
        createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      );
      const home = openWorkbenchRoute(pages, route);
      const settings = openWorkbenchRoute(home, { kind: "settings", path: "/settings/general" });

      expect(settings.location).toEqual({
        kind: "settings",
        path: "/settings/general",
        returnTo: home.location,
      });
      expect(getWorkbenchPrimaryDestination(settings.location)).toBe("home");
      expect(getWorkbenchSceneReturnLocation(settings.location)).toEqual(pages.location);
      expect(settings.homeLocation).toEqual(home.location);
      expect(closeWorkbenchRoute(settings).location).toEqual(home.location);
      const back = navigateBackInWorkbenchWindow(settings);
      expect(back.location).toEqual(home.location);
      expect(navigateForwardInWorkbenchWindow(back).location).toEqual(settings.location);
      const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(settings));
      expect(closeWorkbenchRoute(reopened).location).toEqual(home.location);
      expect(selectWorkbenchHome(selectWorkbenchPages(reopened)).location).toEqual(home.location);
      expect(
        openWorkbenchRoute(settings, { kind: "settings", path: "/settings/appearance" }).location,
      ).toEqual({
        kind: "settings",
        path: "/settings/appearance",
        returnTo: home.location,
      });
    },
  );

  test("Scheduled presents a run chat in place and keeps Home's location", () => {
    const home = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-home", projectId: "alpha" },
    );
    const scheduled = openWorkbenchRoute(home, { kind: "automations", path: "/automations" });
    const run = presentWorkbenchScheduledSession(scheduled, {
      path: "/automations?automationId=task-a&runSessionId=session-run",
      session: { id: "session-run", projectId: "beta" },
    });

    expect(run.location).toEqual({
      kind: "automations",
      path: "/automations?automationId=task-a&runSessionId=session-run",
      returnTo: { kind: "session", sessionId: "session-run", projectContextId: "beta" },
    });
    expect(getWorkbenchPrimaryDestination(run.location)).toBe("scheduled");
    expect(getWorkbenchSceneReturnLocation(run.location)).toMatchObject({
      sessionId: "session-run",
    });
    expect(run.homeLocation).toEqual(home.location);
    expect(navigateBackInWorkbenchWindow(run).location).toEqual(scheduled.location);
    expect(selectWorkbenchHome(run).location).toEqual(home.location);
  });

  test("Scheduled is its own destination outside the remembered Home route", () => {
    const session = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const scheduled = openWorkbenchRoute(session, {
      kind: "automations",
      path: "/automations/edit/a",
    });
    expect(getWorkbenchPrimaryDestination(scheduled.location)).toBe("scheduled");
    expect(scheduled.homeLocation).toEqual(session.location);

    const home = selectWorkbenchHome(scheduled);
    expect(home.location).toEqual(session.location);
    expect(navigateBackInWorkbenchWindow(home).location).toEqual(scheduled.location);

    const settings = openWorkbenchRoute(scheduled, { kind: "settings", path: "/settings/general" });
    expect(getWorkbenchPrimaryDestination(settings.location)).toBe("scheduled");
    expect(closeWorkbenchRoute(settings).location).toEqual(scheduled.location);
    const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(settings));
    expect(reopened.homeLocation).toEqual(session.location);
    expect(selectWorkbenchHome(reopened).location).toEqual(session.location);
  });

  test.each([{ kind: "inbox" as const }])(
    "missing-owner repair retains Settings and its $kind return route",
    (route) => {
      const session = selectWorkbenchSession(
        createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
        {
          id: "session-a",
          projectId: "alpha",
        },
      );
      const home = openWorkbenchRoute(session, route);
      const settings = openWorkbenchRoute(home, { kind: "settings", path: "/settings/general" });
      const withoutSession = reconcileMissingWorkbenchSession(settings, "session-a");
      const repairedHome = { ...home.location, returnTo: { kind: "project", projectId: "alpha" } };
      expect(withoutSession.location).toEqual({ ...settings.location, returnTo: repairedHome });
      expect(withoutSession.homeLocation).toEqual(repairedHome);
      expect(getWorkbenchPrimaryDestination(withoutSession.location)).toBe("home");
      const withoutProject = removeWorkbenchScene(withoutSession, {
        kind: "project",
        projectId: "alpha",
      });
      expect(closeWorkbenchRoute(withoutProject).location).toEqual({
        ...home.location,
        returnTo: { kind: "empty" },
      });
      expect(navigateBackInWorkbenchWindow(withoutProject).location).toEqual({
        ...home.location,
        returnTo: { kind: "empty" },
      });
    },
  );

  test.each<WorkbenchHomeLocation>([
    { kind: "project", projectId: "alpha" },
    { kind: "session", sessionId: "session-a", projectContextId: "alpha" },
    { kind: "inbox", returnTo: { kind: "project", projectId: "alpha" } },
  ])("restores the previous Home route after reopening Space: $kind", (location) => {
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
    });
    const pages = selectWorkbenchPages(initial);
    const home = selectWorkbenchHome(pages);

    expect(pages.homeLocation).toEqual(location);
    expect(pages.history.backStack).toHaveLength(1);
    expect(home.location).toEqual(location);
    expect(home.history.backStack).toHaveLength(2);
    expect(selectWorkbenchHome(home)).toBe(home);
    expect(selectWorkbenchPages(pages)).toBe(pages);
    const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(pages));
    expect(reopened.history.backStack).toHaveLength(0);
    expect(selectWorkbenchHome(reopened).location).toEqual(location);
  });

  test("Settings and pending worktree presentation preserve the stable Home checkpoint", () => {
    const initial = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const inbox = openWorkbenchRoute(initial, { kind: "inbox" });
    const settings = openWorkbenchRoute(inbox, { kind: "settings", path: "/settings/general" });
    const pending = openWorkbenchRoute(inbox, {
      kind: "pending-worktree",
      clientThreadId: "pending-a",
    });

    expect(settings.homeLocation).toEqual(inbox.location);
    expect(pending.homeLocation).toEqual(inbox.location);
    expect(selectWorkbenchHome(selectWorkbenchPages(settings)).location).toEqual(inbox.location);
    expect(selectWorkbenchHome(pending).location).toEqual(inbox.location);
  });

  test("Back and Forward restore the matching Home checkpoint and Scene tree", () => {
    const initial = selectWorkbenchProject(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      "alpha",
    );
    const firstSpace = selectWorkbenchPages(initial);
    const secondHome = selectWorkbenchSession(firstSpace, { id: "session-b", projectId: "beta" });
    const secondSpace = selectWorkbenchPages(secondHome);
    const backHome = navigateBackInWorkbenchWindow(secondSpace);
    const backSpace = navigateBackInWorkbenchWindow(backHome);

    expect(backHome.homeLocation).toEqual(secondHome.location);
    expect(backSpace.location).toEqual(firstSpace.location);
    expect(backSpace.homeLocation).toEqual(initial.location);
    expect(navigateForwardInWorkbenchWindow(backSpace).homeLocation).toEqual(secondHome.location);
    const divergentHome = selectWorkbenchHome(backSpace);
    expect(divergentHome.location).toEqual(initial.location);
    expect(divergentHome.history.forwardStack).toHaveLength(0);
  });

  test("authoritative Session removal repairs dormant Home and both navigation stacks", () => {
    const owner = { kind: "session", sessionId: "session:deleted" } as const;
    const scene = materializeInitialWorkbenchScene(owner);
    const home = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "session", sessionId: owner.sessionId, projectContextId: "alpha" },
      scenesByOwnerKey: { [makeWorkbenchSceneKey(owner)]: scene },
    });
    const pages = selectWorkbenchPages(home);
    const restored = selectWorkbenchHome(pages);
    const withForward = navigateBackInWorkbenchWindow(restored);
    const pruned = reconcileMissingWorkbenchSession(withForward, owner.sessionId);

    expect(pruned.location).toEqual({ kind: "pages" });
    expect(pruned.homeLocation).toEqual({ kind: "project", projectId: "alpha" });
    expect(selectWorkbenchHome(pruned).location).toEqual(pruned.homeLocation);
    expect(navigateBackInWorkbenchWindow(pruned).location).toEqual(pruned.homeLocation);
    expect(navigateForwardInWorkbenchWindow(pruned).location).toEqual(pruned.homeLocation);
    for (const snapshot of [pruned, ...pruned.history.backStack, ...pruned.history.forwardStack]) {
      expect(snapshot.scenesByOwnerKey[makeWorkbenchSceneKey(owner)]).toBeUndefined();
    }
    expect(reconcileMissingWorkbenchSession(pruned, owner.sessionId)).toBe(pruned);
  });

  test("authoritative Project removal repairs Home routes without discarding projectless Sessions", () => {
    const home = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "inbox", returnTo: { kind: "project", projectId: "alpha" } },
    });
    const pruned = removeWorkbenchScene(selectWorkbenchPages(home), {
      kind: "project",
      projectId: "alpha",
    });
    expect(selectWorkbenchHome(pruned).location).toEqual({
      kind: "inbox",
      returnTo: { kind: "empty" },
    });
    const projectless = selectWorkbenchSession(selectWorkbenchProject(home, "alpha"), {
      id: "session-projectless",
      projectId: null,
    });
    const withoutProject = removeWorkbenchScene(projectless, {
      kind: "project",
      projectId: "alpha",
    });
    expect(withoutProject.location).toEqual({
      kind: "session",
      sessionId: "session-projectless",
      projectContextId: null,
    });
  });

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
