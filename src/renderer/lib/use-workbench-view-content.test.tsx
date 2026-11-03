import { Suspense, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { WorkbenchCaptureViewRequest } from "../../shared/nodex-app-tools/workbench-view-content";
import type { WorkbenchViewContentBinding } from "./workbench-view-content";
import { registerWorkbenchViewContent } from "./workbench-view-content";
import { useWorkbenchViewContent } from "./use-workbench-view-content";

vi.mock("./workbench-view-content", () => ({ registerWorkbenchViewContent: vi.fn() }));

test("retains registration across title changes and reads only committed callbacks", () => {
  const release = vi.fn();
  const register = vi.mocked(registerWorkbenchViewContent).mockReturnValue(release);
  const owner = {} as WorkbenchViewContentBinding["presentation"]["owner"];
  const binding = (
    titleSnapshot: string,
    databaseViewId = "view",
  ): WorkbenchViewContentBinding => ({
    presentation: {
      owner,
      sceneOwner: { kind: "project", projectId: "project" },
      surface: {
        id: "tab",
        kind: "db_view",
        titleSnapshot,
        config: {
          routingContext: { kind: "library" },
          target: { kind: "database-view", databaseViewId },
        },
      },
    },
    preferencesRevision: null,
    preferencesPending: false,
    loading: false,
  });
  const first = vi.fn(() => null);
  const second = vi.fn(() => null);
  const abandoned = vi.fn(() => null);
  const suspended = new Promise<void>(() => undefined);
  const request = {} as WorkbenchCaptureViewRequest;
  const view = renderHook(
    ({ current, read, suspend }) => {
      useWorkbenchViewContent(current, read);
      if (suspend) throw suspended;
    },
    {
      initialProps: { current: binding("Initial"), read: first, suspend: false },
      wrapper: ({ children }: { children: ReactNode }) => (
        <Suspense fallback={null}>{children}</Suspense>
      ),
    },
  );
  const readRegistered = register.mock.calls[0]![1];
  view.rerender({ current: binding("Renamed"), read: second, suspend: false });
  expect(register).toHaveBeenCalledOnce();
  readRegistered(request);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  view.rerender({ current: binding("Uncommitted"), read: abandoned, suspend: true });
  readRegistered(request);
  expect(abandoned).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(2);
  view.rerender({ current: binding("Another", "other-view"), read: second, suspend: false });
  expect(release).toHaveBeenCalled();
  expect(register).toHaveBeenLastCalledWith(
    binding("Another", "other-view").presentation,
    expect.any(Function),
  );
  view.unmount();
});
