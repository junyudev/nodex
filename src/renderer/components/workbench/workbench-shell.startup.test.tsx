import "./workbench-testkit/workbench-shell-harness";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { createApplicationReadiness } from "@/bootstrap/application-surface";
import { settleAsyncRender } from "@/test/dom";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import {
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../../shared/workbench-scene";
import {
  makeAttachedSession,
  makeProject,
  type ProjectSession,
} from "./workbench-testkit/workbench-shell-fixtures";
import { renderWorkbench } from "./workbench-testkit/workbench-shell-harness";

describe("Workbench startup readiness", () => {
  test.each(["alpha", null])(
    "waits for selected chat detail in Project %s before reporting ready",
    async (projectId) => {
      const session = makeAttachedSession({ id: "session:startup", projectId });
      let resolveDetail = (_session: ProjectSession | null): void => undefined;
      const detail = new Promise<ProjectSession | null>((resolve) => {
        resolveDetail = resolve;
      });
      const readDetail = vi.fn(() => detail);
      const readiness = createApplicationReadiness();
      const ready = vi.fn();
      void readiness.ready.then(ready);
      renderWorkbench({
        projects: projectId ? [makeProject()] : [],
        sessionsByProject: projectId ? { [projectId]: [session] } : {},
        projectlessSessions: projectId ? [] : [session],
        sessionGetOverride: readDetail,
        applicationReadiness: readiness,
      });
      await waitFor(() => expect(readDetail).toHaveBeenCalledWith(session.id));
      await settleAsyncRender();
      expect(ready).not.toHaveBeenCalled();

      await act(async () => resolveDetail(session));
      await waitFor(() => expect(ready).toHaveBeenCalledOnce());
      await expect(readiness.ready).resolves.toBeUndefined();
    },
  );

  test("an empty Profile can finish opening without a selected chat", async () => {
    const readiness = createApplicationReadiness();
    const ready = vi.fn();
    void readiness.ready.then(ready);
    const view = renderWorkbench({
      projects: [],
      sessionsByProject: {},
      projectlessSessions: [],
      applicationReadiness: readiness,
    });
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(view.getByRole("button", { name: "Start a projectless chat" })).toBeTruthy();
  });

  test.each([true, false])(
    "waits for a restored bound Agent Dock only when visible=%s",
    async (visible) => {
      const session = makeAttachedSession({ id: "session:dock", projectId: "alpha" });
      let resolveDetail = (_session: ProjectSession | null): void => undefined;
      const detail = new Promise<ProjectSession | null>((resolve) => {
        resolveDetail = resolve;
      });
      const readDetail = vi.fn(() => detail);
      const readiness = createApplicationReadiness();
      const ready = vi.fn();
      void readiness.ready.then(ready);
      const owner = { kind: "project", projectId: "alpha" } as const;
      const scene = materializeInitialWorkbenchScene(owner);
      renderWorkbench({
        sessionsByProject: { alpha: [session] },
        sessionGetOverride: readDetail,
        applicationReadiness: readiness,
        initialWindowLayoutSnapshot: {
          ...createDefaultWorkbenchLayoutSnapshot(),
          location: owner,
          scenesByOwnerKey: {
            [makeWorkbenchSceneKey(owner)]: {
              ...scene,
              composerOverlay: { visible },
              agentDock: {
                binding: { kind: "session", sessionId: session.id },
                newDraftId: "draft:startup",
              },
            },
          },
        },
      });
      await waitFor(() => expect(readDetail).toHaveBeenCalledWith(session.id));
      await settleAsyncRender();
      if (visible) expect(ready).not.toHaveBeenCalled();
      else await waitFor(() => expect(ready).toHaveBeenCalledOnce());

      await act(async () => resolveDetail(session));
      await waitFor(() => expect(ready).toHaveBeenCalledOnce());
      await expect(readiness.ready).resolves.toBeUndefined();
    },
  );
});
