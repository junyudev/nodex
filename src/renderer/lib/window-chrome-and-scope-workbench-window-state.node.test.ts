import { describe, expect, test, it } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  getWorkbenchPrimaryDestination,
  getWorkbenchSceneReturnLocation,
  type WorkbenchHomeLocation,
  type WorkbenchSceneLocation,
  type WorkbenchLocation,
} from "../../shared/workbench-layout";
import {
  activateWorkbenchSceneSurface,
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
  presentWorkbenchAutomationSession,
  reconcileMissingWorkbenchSession,
  selectWorkbenchProject,
  selectWorkbenchInbox,
  selectWorkbenchLibrary,
  selectWorkbenchHome,
  selectWorkbenchSession,
  snapshotWorkbenchWindowState,
  updateWorkbenchScene,
  updateWorkbenchSceneAndNavigate,
  removeWorkbenchScene,
} from "./workbench-window-state";
import { createIntl } from "react-intl";
import {
  formatWorkbenchWindowTitle,
  resolveWorkbenchWindowTitleParts,
  type WorkbenchWindowTitleInput,
} from "./workbench-window-title";

describe("WorkbenchWindowState", () => {
  test("incoming Scheduled links enter the canonical Automations route", () => {
    const state = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const next = openWorkbenchRoute(state, {
      kind: "automations",
      path: "/scheduled/edit/kept",
    });
    expect(next.location).toMatchObject({
      kind: "automations",
      path: "/automations?automationId=kept&automationMode=edit",
    });
  });
  test.each([{ kind: "inbox" as const }])(
    "Settings retains its stable $kind origin after leaving Space",
    () => {
      const pages = selectWorkbenchLibrary(
        createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      );
      const home = selectWorkbenchInbox(pages);
      const settings = openWorkbenchRoute(home, { kind: "settings", path: "/settings/general" });

      expect(settings.location).toEqual({
        kind: "settings",
        path: "/settings/general",
        returnTo: home.location,
      });
      expect(getWorkbenchPrimaryDestination(settings.location)).toBe("home");
      expect(getWorkbenchSceneReturnLocation(settings.location)).toEqual({ kind: "inbox" });
      expect(settings.homeLocation).toEqual(home.location);
      expect(closeWorkbenchRoute(settings).location).toEqual(home.location);
      const back = navigateBackInWorkbenchWindow(settings);
      expect(back.location).toEqual(home.location);
      expect(navigateForwardInWorkbenchWindow(back).location).toEqual(settings.location);
      const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(settings));
      expect(closeWorkbenchRoute(reopened).location).toEqual(home.location);
      expect(selectWorkbenchHome(selectWorkbenchLibrary(reopened)).location).toEqual(home.location);
      expect(
        openWorkbenchRoute(settings, { kind: "settings", path: "/settings/appearance" }).location,
      ).toEqual({
        kind: "settings",
        path: "/settings/appearance",
        returnTo: home.location,
      });
    },
  );

  test("Automations presents a run chat in place and keeps Home's location", () => {
    const home = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-home", projectId: "alpha" },
    );
    const scheduled = openWorkbenchRoute(home, { kind: "automations", path: "/automations" });
    const run = presentWorkbenchAutomationSession(scheduled, {
      path: "/automations?automationId=task-a&runSessionId=session-run",
      session: { id: "session-run", projectId: "beta" },
    });

    expect(run.location).toEqual({
      kind: "automations",
      path: "/automations?automationId=task-a&runSessionId=session-run",
      returnTo: { kind: "session", sessionId: "session-run", projectContextId: "beta" },
    });
    expect(getWorkbenchPrimaryDestination(run.location)).toBe("automations");
    expect(getWorkbenchSceneReturnLocation(run.location)).toMatchObject({
      sessionId: "session-run",
    });
    expect(run.homeLocation).toEqual(home.location);
    expect(navigateBackInWorkbenchWindow(run).location).toEqual(scheduled.location);
    expect(selectWorkbenchHome(run).location).toEqual(home.location);
  });

  test("Automations is its own destination outside the remembered Home route", () => {
    const session = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const scheduled = openWorkbenchRoute(session, {
      kind: "automations",
      path: "/automations/edit/a",
    });
    expect(getWorkbenchPrimaryDestination(scheduled.location)).toBe("automations");
    expect(scheduled.homeLocation).toEqual(session.location);

    const home = selectWorkbenchHome(scheduled);
    expect(home.location).toEqual(session.location);
    expect(navigateBackInWorkbenchWindow(home).location).toEqual(scheduled.location);

    const settings = openWorkbenchRoute(scheduled, { kind: "settings", path: "/settings/general" });
    expect(getWorkbenchPrimaryDestination(settings.location)).toBe("automations");
    expect(closeWorkbenchRoute(settings).location).toEqual(scheduled.location);
    const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(settings));
    expect(reopened.homeLocation).toEqual(session.location);
    expect(selectWorkbenchHome(reopened).location).toEqual(session.location);
  });

  test("Customize is its own destination and switching to Automations keeps its Scene", () => {
    const session = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const plugins = openWorkbenchRoute(session, { kind: "plugins", path: "/plugins" });
    expect(plugins.location).toEqual({
      kind: "plugins",
      path: "/plugins",
      returnTo: session.location,
    });
    expect(getWorkbenchPrimaryDestination(plugins.location)).toBe("plugins");
    expect(plugins.homeLocation).toEqual(session.location);

    const scheduled = openWorkbenchRoute(plugins, { kind: "automations", path: "/automations" });
    expect(scheduled.location).toEqual({
      kind: "automations",
      path: "/automations",
      returnTo: session.location,
    });
    expect(navigateBackInWorkbenchWindow(scheduled).location).toEqual(plugins.location);
    expect(selectWorkbenchHome(plugins).location).toEqual(session.location);

    const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(plugins));
    expect(reopened.location).toEqual(plugins.location);
    expect(reopened.homeLocation).toEqual(session.location);
  });

  test("removing a Session leaves the Inbox and Settings over it in place", () => {
    const session = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const inbox = selectWorkbenchInbox(session);
    const settings = openWorkbenchRoute(inbox, { kind: "settings", path: "/settings/general" });
    const withoutSession = reconcileMissingWorkbenchSession(settings, "session-a");

    expect(withoutSession.location).toEqual(settings.location);
    expect(withoutSession.homeLocation).toEqual({ kind: "inbox" });
    expect(closeWorkbenchRoute(withoutSession).location).toEqual({ kind: "inbox" });
    // Back past the Inbox lands on the repaired Session origin, its Project.
    const backToInbox = navigateBackInWorkbenchWindow(withoutSession);
    expect(backToInbox.location).toEqual({ kind: "inbox" });
    expect(navigateBackInWorkbenchWindow(backToInbox).location).toEqual({
      kind: "project",
      projectId: "alpha",
    });
  });

  test.each<WorkbenchHomeLocation>([
    { kind: "project", projectId: "alpha" },
    { kind: "session", sessionId: "session-a", projectContextId: "alpha" },
    { kind: "inbox" },
  ])("restores the previous Home route after reopening Space: $kind", (location) => {
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
    });
    const pages = selectWorkbenchLibrary(initial);
    const home = selectWorkbenchHome(pages);

    expect(pages.homeLocation).toEqual(location);
    expect(pages.history.backStack).toHaveLength(1);
    expect(home.location).toEqual(location);
    expect(home.history.backStack).toHaveLength(2);
    expect(selectWorkbenchHome(home)).toBe(home);
    expect(selectWorkbenchLibrary(pages)).toBe(pages);
    const reopened = createWorkbenchWindowState(snapshotWorkbenchWindowState(pages));
    expect(reopened.history.backStack).toHaveLength(0);
    expect(selectWorkbenchHome(reopened).location).toEqual(location);
  });

  test("Settings and pending worktree presentation preserve the stable Home checkpoint", () => {
    const initial = selectWorkbenchSession(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      { id: "session-a", projectId: "alpha" },
    );
    const inbox = selectWorkbenchInbox(initial);
    const settings = openWorkbenchRoute(inbox, { kind: "settings", path: "/settings/general" });
    const pending = openWorkbenchRoute(inbox, {
      kind: "pending-worktree",
      clientThreadId: "pending-a",
    });

    expect(settings.homeLocation).toEqual(inbox.location);
    expect(pending.homeLocation).toEqual(inbox.location);
    expect(selectWorkbenchHome(selectWorkbenchLibrary(settings)).location).toEqual(inbox.location);
    expect(selectWorkbenchHome(pending).location).toEqual(inbox.location);
  });

  test("Back and Forward restore the matching Home checkpoint and Scene tree", () => {
    const initial = selectWorkbenchProject(
      createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot()),
      "alpha",
    );
    const firstSpace = selectWorkbenchLibrary(initial);
    const secondHome = selectWorkbenchSession(firstSpace, { id: "session-b", projectId: "beta" });
    const secondSpace = selectWorkbenchLibrary(secondHome);
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
    const pages = selectWorkbenchLibrary(home);
    const restored = selectWorkbenchHome(pages);
    const withForward = navigateBackInWorkbenchWindow(restored);
    const pruned = reconcileMissingWorkbenchSession(withForward, owner.sessionId);

    expect(pruned.location).toEqual({ kind: "library" });
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
      location: { kind: "project", projectId: "alpha" },
    });
    const pruned = removeWorkbenchScene(selectWorkbenchLibrary(home), {
      kind: "project",
      projectId: "alpha",
    });
    expect(selectWorkbenchHome(pruned).location).toEqual({ kind: "empty" });
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

  test("the Library Scene participates in shared window history", () => {
    const initial = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const pages = selectWorkbenchLibrary(initial);
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

  test("opens the Library Scene atomically from another auxiliary route", () => {
    const initial = createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "project", projectId: "alpha" },
    });
    const settings = openWorkbenchRoute(initial, {
      kind: "settings",
      path: "/settings/general",
    });
    const pages = selectWorkbenchLibrary(settings);

    expect(pages.location).toEqual({ kind: "library" });
    expect(navigateBackInWorkbenchWindow(pages).location).toEqual(settings.location);
  });

  test("records Pages surface creation and selection as one history entry", () => {
    const owner = { kind: "library" } as const;
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
              pageId: "page:one",
            },
            stateKey: 0,
            state: null,
          },
        }),
      { kind: "library" },
    );

    expect(presented.history.backStack).toHaveLength(1);
    expect(presented.location).toEqual({ kind: "library" });
    const back = navigateBackInWorkbenchWindow(presented);
    expect(back.location).toEqual(initial.location);
    expect(back.scenesByOwnerKey.pages).toBeUndefined();
  });

  test("Pages replacement does not add history and divergent navigation clears forward", () => {
    const initial = createWorkbenchWindowState(createDefaultWorkbenchLayoutSnapshot());
    const pages = selectWorkbenchLibrary(initial);
    const emptyAgain = navigateBackInWorkbenchWindow(pages);
    const project = selectWorkbenchProject(emptyAgain, "alpha");
    const replacement = navigateWorkbenchWindow(project, { kind: "library" }, { record: false });

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

  test("asking for the state a Scene is already in changes nothing, including Forward", () => {
    const owner = { kind: "project", projectId: "alpha" } as const;
    const sceneKey = makeWorkbenchSceneKey(owner);
    const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(owner), {
      panelId: "right",
      surface: {
        id: "page:one",
        kind: "page_stage",
        titleSnapshot: "Page One",
        config: { pageId: "page:one" },
        stateKey: 0,
        state: null,
      },
    });
    const leafId = scene.panels.right.layout.activeLeafId;
    const focus = (state: ReturnType<typeof createWorkbenchWindowState>) =>
      updateWorkbenchScene(state, owner, (current) =>
        activateWorkbenchSceneSurface(current!, "right", leafId),
      );
    const focused = focus(
      createWorkbenchWindowState({
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "project", projectId: "alpha" },
        scenesByOwnerKey: { [sceneKey]: scene },
      }),
    );

    expect(focus(focused)).toBe(focused);
    expect(
      updateWorkbenchSceneAndNavigate(
        focused,
        owner,
        (current) => activateWorkbenchSceneSurface(current!, "right", leafId),
        focused.location as WorkbenchSceneLocation,
      ),
    ).toBe(focused);

    const collapsed = updateWorkbenchScene(focused, owner, (current) =>
      patchWorkbenchScenePanel(current!, "right", { collapsed: true }),
    );
    const back = navigateBackInWorkbenchWindow(collapsed);
    expect(back.history.forwardStack).toHaveLength(1);
    expect(focus(back)).toBe(back);
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

describe("workbench window title", () => {
  const sessionLocation: WorkbenchLocation = {
    kind: "session",
    sessionId: "session-1",
    projectContextId: "project-1",
  };

  const titleFor = (
    input: Partial<WorkbenchWindowTitleInput> & Pick<WorkbenchWindowTitleInput, "location">,
    os: "darwin" | "win32" | "linux" = "darwin",
  ): string =>
    formatWorkbenchWindowTitle(
      resolveWorkbenchWindowTitleParts({ chat: null, project: null, spaceTrail: [], ...input }),
      os,
    );

  describe("workbench window title", () => {
    it("names a chat before the Project it belongs to", () => {
      expect(
        titleFor({
          location: sessionLocation,
          chat: { sessionId: "session-1", title: "Fix flaky E2E", projectName: "nodex" },
        }),
      ).toBe("Fix flaky E2E — nodex");
      expect(
        titleFor({
          location: sessionLocation,
          chat: { sessionId: "session-1", title: "Plan the offsite", projectName: null },
        }),
      ).toBe("Plan the offsite");
    });

    it("uses the current display language for a draft Session's native window title", () => {
      const intl = createIntl({
        locale: "zh-CN",
        messages: { "command.newThread.title": "新聊天" },
      });
      expect(
        resolveWorkbenchWindowTitleParts(
          {
            location: sessionLocation,
            chat: { sessionId: "session-1", title: "New chat", projectName: "nodex" },
            project: null,
            spaceTrail: [],
          },
          intl,
        ),
      ).toEqual(["新聊天", "nodex"]);
    });

    it("never names a chat or Project the window has moved away from", () => {
      expect(
        titleFor({
          location: sessionLocation,
          chat: { sessionId: "session-0", title: "Previous chat", projectName: "nodex" },
        }),
      ).toBe("Nodex");
      expect(
        titleFor({
          location: { kind: "project", projectId: "project-2" },
          project: { id: "project-1", name: "nodex" },
        }),
      ).toBe("Nodex");
      expect(
        titleFor({
          location: { kind: "project", projectId: "project-1" },
          project: { id: "project-1", name: "nodex" },
        }),
      ).toBe("nodex");
    });

    it("names Space by its active surface, most specific first", () => {
      expect(titleFor({ location: { kind: "library" }, spaceTrail: ["Ship v1", "Tasks"] })).toBe(
        "Ship v1 — Tasks",
      );
      expect(titleFor({ location: { kind: "library" }, spaceTrail: ["Q4 roadmap"] })).toBe(
        "Q4 roadmap",
      );
      expect(titleFor({ location: { kind: "library" } })).toBe("Space");
    });

    it("names every other destination", () => {
      const returnTo = { kind: "empty" } as const;
      const cases: ReadonlyArray<readonly [WorkbenchLocation, string]> = [
        [{ kind: "empty" }, "New chat"],
        [{ kind: "pending-worktree", clientThreadId: "client-1", returnTo }, "New chat"],
        [{ kind: "inbox" }, "Inbox"],
        [{ kind: "automations", path: "/", returnTo }, "Automations"],
        [{ kind: "plugins", path: "/", returnTo }, "Plugins"],
        [{ kind: "insights", path: "/", returnTo }, "Insights"],
        [{ kind: "settings", path: "/general", returnTo }, "Settings"],
      ];
      for (const [location, title] of cases) expect(titleFor({ location })).toBe(title);
    });

    it("ends the title with Nodex outside macOS", () => {
      const chat = { sessionId: "session-1", title: "Fix flaky E2E", projectName: "nodex" };
      expect(titleFor({ location: sessionLocation, chat }, "win32")).toBe(
        "Fix flaky E2E — nodex — Nodex",
      );
      expect(titleFor({ location: { kind: "inbox" } }, "linux")).toBe("Inbox — Nodex");
      expect(titleFor({ location: sessionLocation }, "win32")).toBe("Nodex");
    });

    it("ends a team window's location with its Space, which also names Space itself", () => {
      const team = { teamSpaceName: "Acme" };
      const chat = { sessionId: "session-1", title: "Fix flaky E2E", projectName: "nodex" };
      expect(titleFor({ ...team, location: sessionLocation, chat })).toBe(
        "Fix flaky E2E — nodex — Acme",
      );
      expect(titleFor({ ...team, location: { kind: "inbox" } }, "win32")).toBe(
        "Inbox — Acme — Nodex",
      );
      expect(
        titleFor({ ...team, location: { kind: "library" }, spaceTrail: ["Ship v1", "Tasks"] }),
      ).toBe("Ship v1 — Tasks — Acme");
      expect(titleFor({ ...team, location: { kind: "library" } })).toBe("Acme");
      // A location the window has not loaded names neither it nor the Space.
      expect(titleFor({ ...team, location: sessionLocation })).toBe("Nodex");
    });

    it("presents each part on one line and drops empty parts", () => {
      expect(
        formatWorkbenchWindowTitle(["  Draft\n  release\tnotes ", "   ", "nodex"], "darwin"),
      ).toBe("Draft release notes — nodex");
      expect(formatWorkbenchWindowTitle([], "darwin")).toBe("Nodex");
    });
  });
});
