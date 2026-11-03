import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import type { Project } from "./types";
import { useTabs } from "./use-tabs";

const project = (id: string) => ({ id }) as Project;
afterEach(() => {
  localStorage.removeItem("nodex-tabs");
  localStorage.removeItem("nodex-project");
  window.history.replaceState(null, "", "/");
});

test("initializes loaded Projects and selects a surviving tab when its active Project is removed", async () => {
  const { result, rerender } = renderHook(({ projects }) => useTabs(projects), {
    initialProps: { projects: [] as Project[] },
  });
  const first = project("first");
  const second = project("second");
  rerender({ projects: [first, second] });
  expect(result.current.activeTab?.projectId).toBe("first");
  await act(async () => result.current.openTab(second.id));
  expect(result.current.activeTab?.projectId).toBe("second");
  rerender({ projects: [first] });
  expect(result.current.tabs.map((tab) => tab.projectId)).toEqual([first.id]);
  expect(result.current.activeTab?.projectId).toBe(first.id);
  rerender({ projects: [second] });
  expect(result.current.tabs.map((tab) => tab.projectId)).toEqual([second.id]);
  expect(result.current.activeTab?.projectId).toBe(second.id);
});
