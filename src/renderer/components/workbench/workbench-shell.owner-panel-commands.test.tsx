import "./workbench-testkit/workbench-shell-harness";
import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  activateWorkbenchSceneSurface,
  patchWorkbenchScenePanel,
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import {
  createDefaultWorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshot,
} from "../../../shared/workbench-layout";
import { makeProject } from "./workbench-testkit/workbench-shell-fixtures";
import { getPanelTabById, renderWorkbench } from "./workbench-testkit/workbench-shell-harness";
import { settleAsyncRender } from "../../test/dom";

function pageSurface(owner: WorkbenchSceneOwner, id: string): WorkbenchSurfaceDescriptor {
  const routingContext =
    owner.kind === "project"
      ? { kind: "project" as const, projectId: owner.projectId }
      : { kind: "library" as const };
  return {
    id,
    kind: "page_stage",
    titleSnapshot: id,
    stateKey: 0,
    state: null,
    config: {
      routingContext,
      pageId: id,
    },
  };
}

function browserSurface(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "browser",
    titleSnapshot: "Browser",
    stateKey: 0,
    state: null,
    config: {
      browserTabId: `${id}:runtime`,
      url: "about:blank",
    },
  };
}

function makeScene(owner: WorkbenchSceneOwner): WorkbenchSceneSnapshot {
  const initial = materializeInitialWorkbenchScene(owner, {
    identityFactory: {
      createId: (kind) => `test:${kind}`,
    },
  });
  const withFirst = createWorkbenchSceneSurface(initial, {
    panelId: "right",
    surface: pageSurface(owner, "first-page"),
  });
  const withSecond = createWorkbenchSceneSurface(withFirst, {
    panelId: "right",
    surface: pageSurface(owner, "second-page"),
  });
  const patched = patchWorkbenchScenePanel(withSecond, "right", {
    collapsed: false,
    size: { fullWidth: false },
  });
  return activateWorkbenchSceneSurface(
    patched,
    "right",
    patched.panels.right.layout.activeLeafId,
    "first-page",
  );
}

function makeLayout(owner: WorkbenchSceneOwner): WorkbenchLayoutSnapshot {
  const scene = makeScene(owner);
  return {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location:
      owner.kind === "project"
        ? { kind: "project", projectId: owner.projectId }
        : { kind: "library" },
    databaseSearchByProject: {},
    scenesByOwnerKey: {
      [makeWorkbenchSceneKey(owner)]: scene,
    },
  };
}

describe("owner-scoped workbench panel commands", () => {
  test("projects render the Browser runtime favicon in durable Scene tabs", async () => {
    const owner = { kind: "project" as const, projectId: "alpha" };
    const initial = makeScene(owner);
    const scene = createWorkbenchSceneSurface(initial, {
      panelId: "right",
      surface: browserSurface("project-browser"),
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha")],
      sessionsByProject: { alpha: [] },
      initialWindowLayoutSnapshot: {
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "project", projectId: "alpha" },
        databaseSearchByProject: {},
        scenesByOwnerKey: {
          [makeWorkbenchSceneKey(owner)]: scene,
        },
      },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const browserTab = getPanelTabById(screen.container, "project-browser");
    expect(browserTab.querySelector('[data-browser-tab-icon-phase="settled"]')).not.toBeNull();
  });

  test("cycles and closes Project Scene tabs without a Session", async () => {
    const owner = { kind: "project" as const, projectId: "alpha" };
    const screen = renderWorkbench({
      projects: [makeProject("alpha")],
      sessionsByProject: { alpha: [] },
      initialWindowLayoutSnapshot: makeLayout(owner),
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.pointerDown(getPanelTabById(screen.container, "first-page"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "first-page"), {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getPanelTabById(screen.container, "second-page").getAttribute("aria-selected")).toBe(
      "true",
    );

    await act(async () => {
      fireEvent.keyDown(getPanelTabById(screen.container, "second-page"), {
        key: "w",
        code: "KeyW",
        ctrlKey: true,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.container.querySelector('[data-panel-tab-id="second-page"]')).toBeNull();
    });
    expect(screen.container.querySelector('[data-panel-tab-id="first-page"]')).not.toBeNull();
  });

  test("cycles Library Scene tabs through the native command port", async () => {
    const owner = { kind: "library" as const };
    const screen = renderWorkbench({
      projects: [makeProject("alpha")],
      sessionsByProject: { alpha: [] },
      initialWindowLayoutSnapshot: makeLayout(owner),
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.pointerDown(getPanelTabById(screen.container, "first-page"));
      await Promise.resolve();
    });
    await act(async () => {
      screen.requestPanelTabCycle("next");
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(getPanelTabById(screen.container, "second-page").getAttribute("aria-selected")).toBe(
      "true",
    );

    await act(async () => {
      screen.requestPanelTabClose();
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.container.querySelector('[data-panel-tab-id="second-page"]')).toBeNull();
    });
    expect(screen.container.querySelector('[data-panel-tab-id="first-page"]')).not.toBeNull();
  });
});
