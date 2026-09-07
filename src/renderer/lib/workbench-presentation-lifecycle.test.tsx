import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import { parseDatabaseId } from "../../shared/database-identities";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import { readWorkbenchSubmitPresentation } from "./workbench-agent-context";
import type { WorkbenchDatabaseViewReference } from "./workbench-database-view-presentation";
import { useWorkbenchDatabaseViewPresentation } from "./use-workbench-database-view-presentation";
import { useWorkbenchSceneCommands } from "./use-workbench-scene-commands";
import { createWorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";

const lifecycle = vi.hoisted(() => ({ prepareClose: vi.fn(), close: vi.fn(), toast: vi.fn() }));
vi.mock("./workbench-scene-command-lifecycle", () => ({
  createWorkbenchSceneCommandLifecycle: () => lifecycle,
}));
vi.mock("../components/ui/toast", () => ({ toast: { danger: lifecycle.toast } }));

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.resetAllMocks();
});

function fixture(sceneOwner: WorkbenchSceneOwner = { kind: "project", projectId: "project-a" }) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const scene = materializeInitialWorkbenchScene(sceneOwner);
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: sceneOwner.kind === "project" ? sceneOwner : { kind: "pages" },
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  return { owner, sceneOwner, scene };
}

describe("Workbench rendered presentation lifetime", () => {
  test("captures the rendered default View and keeps an earlier submission exact after it changes", async () => {
    const { owner, sceneOwner, scene } = fixture();
    if (scene.primary?.kind !== "db_view") throw new Error("Expected Project primary View");
    const surface = scene.primary;
    const view = renderHook(
      ({ databaseViewId }: { databaseViewId: string | null }) =>
        useWorkbenchDatabaseViewPresentation({ owner, sceneOwner, surface }, databaseViewId),
      { initialProps: { databaseViewId: null as string | null } },
    );
    const capture = () =>
      readWorkbenchSubmitPresentation(owner.read(), "generation-a", {
        resolveDatabaseView: owner.resolveDatabaseView,
      });
    expect(capture().selectedTabs[0]?.surface).toMatchObject({
      config: { target: { kind: "project-default" } },
    });
    await act(async () => {
      view.rerender({ databaseViewId: "view-first" });
    });
    const first = capture();
    expect(first.selectedTabs[0]?.surface).toMatchObject({
      config: { target: { kind: "database-view", databaseViewId: "view-first" } },
    });
    await act(async () => {
      view.rerender({ databaseViewId: "view-second" });
    });
    const second = capture();
    expect(second.presentationRevision).toBeGreaterThan(first.presentationRevision);
    expect(second.selectedTabs[0]?.surface).toMatchObject({
      config: { target: { databaseViewId: "view-second" } },
    });
    expect(first.selectedTabs[0]?.surface).toMatchObject({
      config: { target: { databaseViewId: "view-first" } },
    });
    await act(async () => {
      view.unmount();
    });
    expect(owner.resolveDatabaseView(sceneOwner, surface)).toBeNull();
  });

  test("matches the original descriptor and prevents old cleanup from revoking a replacement", () => {
    const { owner, sceneOwner, scene } = fixture();
    if (scene.primary?.kind !== "db_view") throw new Error("Expected Project primary View");
    const surface = scene.primary;
    const releaseOld = owner.registerResolvedDatabaseView(sceneOwner, surface, "view-first");
    const releaseNew = owner.registerResolvedDatabaseView(sceneOwner, surface, "view-second");
    releaseOld();
    expect(owner.resolveDatabaseView(sceneOwner, surface)).toBe("view-second");
    const retargeted: WorkbenchDatabaseViewReference = {
      ...surface,
      config: {
        ...surface.config,
        target: { kind: "database-default", databaseId: parseDatabaseId("database-other") },
      },
    };
    expect(owner.resolveDatabaseView(sceneOwner, retargeted)).toBeNull();
    expect(
      owner.resolveDatabaseView({ kind: "project", projectId: "other-project" }, surface),
    ).toBeNull();
    releaseNew();
    expect(owner.resolveDatabaseView(sceneOwner, surface)).toBeNull();
  });

  test("an unmounted UI generation cannot finish a pending close against its old owner", async () => {
    const { owner, sceneOwner } = fixture({ kind: "pages" });
    owner.setScene(sceneOwner, (scene) =>
      createWorkbenchSceneSurface(scene!, {
        panelId: "right",
        surface: {
          id: "page-tab",
          kind: "page_stage",
          titleSnapshot: "Page",
          config: { accessContext: { kind: "library" }, pageId: "page-a" },
          state: null,
          stateKey: 0,
        },
      }),
    );
    const commit = vi.fn(async (snapshot: ReturnType<typeof owner.capturePersistenceSnapshot>) => ({
      ...snapshot,
      sessionId: "window-a",
      layoutRevision: 1,
    }));
    owner.registerPersistenceCommit(commit);
    let finishSave!: (saved: boolean) => void;
    lifecycle.prepareClose.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    const opener = createWorkbenchPanelTabOpenerStore();
    const view = renderHook(() =>
      useWorkbenchSceneCommands(owner, "window-a", async () => {}, opener),
    );
    const before = owner.read();
    let pending!: ReturnType<typeof view.result.current.execute>;
    await act(async () => {
      pending = view.result.current.execute(sceneOwner, { kind: "close_tab", tabId: "page-tab" });
      await Promise.resolve();
    });
    expect(lifecycle.prepareClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      view.unmount();
      finishSave(true);
      await pending;
    });
    await expect(pending).resolves.toMatchObject({ applied: false, error: "revoked_generation" });
    expect(owner.read()).toBe(before);
    expect(commit).not.toHaveBeenCalled();
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(lifecycle.toast).not.toHaveBeenCalled();
  });
});
