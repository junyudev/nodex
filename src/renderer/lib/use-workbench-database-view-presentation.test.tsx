import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { WorkbenchDatabaseViewPresentationRegistration } from "./workbench-database-view-presentation";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import { useWorkbenchDatabaseViewPresentation } from "./use-workbench-database-view-presentation";

test("retains a View registration across title changes and revokes it when unresolved", () => {
  const release = vi.fn();
  const registerResolvedDatabaseView = vi.fn(() => release);
  const registration: WorkbenchDatabaseViewPresentationRegistration = {
    owner: { registerResolvedDatabaseView } as unknown as WorkbenchWindowOwner,
    sceneOwner: { kind: "session", sessionId: "session" },
    surface: {
      id: "view-tab",
      kind: "db_view",
      titleSnapshot: "First title",
      config: {
        routingContext: { kind: "project", projectId: "project" },
        target: { kind: "project-default" },
      },
    },
  };
  const { rerender, unmount } = renderHook(
    ({ current, viewId }) => useWorkbenchDatabaseViewPresentation(current, viewId),
    {
      initialProps: { current: registration, viewId: "view-a" as string | null },
      wrapper: StrictMode,
    },
  );
  const registrationsAfterMount = registerResolvedDatabaseView.mock.calls.length;
  const releasesAfterMount = release.mock.calls.length;
  rerender({
    current: { ...registration, surface: { ...registration.surface, titleSnapshot: "Renamed" } },
    viewId: "view-a",
  });
  expect(registerResolvedDatabaseView).toHaveBeenCalledTimes(registrationsAfterMount);
  rerender({ current: registration, viewId: "view-b" });
  expect(release).toHaveBeenCalledTimes(releasesAfterMount + 1);
  expect(registerResolvedDatabaseView).toHaveBeenLastCalledWith(
    registration.sceneOwner,
    registration.surface,
    "view-b",
  );
  rerender({ current: registration, viewId: null });
  expect(release).toHaveBeenCalledTimes(releasesAfterMount + 2);
  unmount();
  expect(release).toHaveBeenCalledTimes(releasesAfterMount + 2);
});
