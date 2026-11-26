import { describe, expect, test } from "vite-plus/test";
import { resolvePageExecutionContext } from "./page-execution-context";

describe("Page execution and workspace defaults", () => {
  test("uses the Scene for execution and the Page home for workspace-relative paths", () => {
    expect(
      resolvePageExecutionContext({ sceneProjectId: "scene", pageHomeProjectId: "home" }),
    ).toEqual({
      executionProjectId: "scene",
      launchProjectId: "scene",
      targetProjectId: "scene",
      workspaceProjectId: "home",
    });
  });

  test("uses the Page home to prefill a launch in a Scene with no Project", () => {
    expect(
      resolvePageExecutionContext({ sceneProjectId: null, pageHomeProjectId: "home" }),
    ).toEqual({
      executionProjectId: null,
      launchProjectId: "home",
      targetProjectId: "home",
      workspaceProjectId: "home",
    });
  });

  test("falls back to the Scene's checkout for a Page without a home Project", () => {
    expect(
      resolvePageExecutionContext({ sceneProjectId: "scene", pageHomeProjectId: null }),
    ).toEqual({
      executionProjectId: "scene",
      launchProjectId: "scene",
      targetProjectId: "scene",
      workspaceProjectId: "scene",
    });
    expect(resolvePageExecutionContext({ sceneProjectId: null, pageHomeProjectId: null })).toEqual({
      executionProjectId: null,
      launchProjectId: null,
      targetProjectId: null,
      workspaceProjectId: null,
    });
  });

  test.each(["chat", null])("keeps a destination's own execution Project (%s)", (projectId) => {
    expect(
      resolvePageExecutionContext({
        sceneProjectId: "scene",
        pageHomeProjectId: "home",
        destination: { projectId },
      }),
    ).toEqual({
      executionProjectId: "scene",
      launchProjectId: "scene",
      targetProjectId: projectId,
      workspaceProjectId: "home",
    });
  });
});
