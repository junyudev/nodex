import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { Project } from "./types";
import { useBoardsForProjects } from "./use-project-board-windows";

const mocks = vi.hoisted(() => ({
  unsubscribeBoard: vi.fn(),
  unregisterProjection: vi.fn(),
  registry: { register: vi.fn() },
  subscribeBoardChanges: vi.fn(),
  queryClient: {},
}));
vi.mock("@tanstack/react-query", () => ({
  hashKey: JSON.stringify,
  useQueries: () => null,
  useQueryClient: () => mocks.queryClient,
}));
vi.mock("./api", () => ({ subscribeBoardChanges: mocks.subscribeBoardChanges }));
vi.mock("./query-options", () => ({ boardByProjectQueryOptions: () => ({}) }));
vi.mock("./projection-invalidation-context", () => ({
  useProjectionInvalidationRegistry: () => mocks.registry,
}));

test("keeps Project subscriptions across metadata renders and replaces changed authority", () => {
  mocks.subscribeBoardChanges.mockReturnValue(mocks.unsubscribeBoard);
  mocks.registry.register.mockReturnValue(mocks.unregisterProjection);
  const project = {
    id: "project",
    libraryId: "library",
    databaseId: "database",
    name: "First",
  } as Project;
  const { rerender, unmount } = renderHook(({ projects }) => useBoardsForProjects(projects), {
    initialProps: { projects: [project] },
  });
  rerender({ projects: [{ ...project, name: "Renamed" }] });
  expect(mocks.subscribeBoardChanges).toHaveBeenCalledTimes(1);
  rerender({ projects: [{ ...project, databaseId: "other-database" }] });
  expect(mocks.unsubscribeBoard).toHaveBeenCalledTimes(1);
  expect(mocks.unregisterProjection).toHaveBeenCalledTimes(1);
  expect(mocks.subscribeBoardChanges).toHaveBeenCalledTimes(2);
  unmount();
  expect(mocks.unsubscribeBoard).toHaveBeenCalledTimes(2);
  expect(mocks.unregisterProjection).toHaveBeenCalledTimes(2);
});
