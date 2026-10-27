import { describe, expect, test } from "vite-plus/test";
import {
  EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
  normalizeWorkspaceFileNavigationKey,
  normalizeWorkspaceFileNavigationState,
  selectWorkspaceFileNavigationPath,
  updateWorkspaceFileNavigationExpansion,
  workspaceFileNavigationStateFamily,
} from "./workspace-file-navigation-state";

describe("workspace file navigation state", () => {
  test("canonicalizes workspace-root keys without erasing filesystem roots", () => {
    expect(
      normalizeWorkspaceFileNavigationKey({
        hostId: "local",
        includeHidden: true,
        workspaceRoot: "C:\\repo\\nodex\\",
      }),
    ).toEqual({
      hostId: "local",
      includeHidden: true,
      workspaceRoot: "C:/repo/nodex",
    });
    expect(
      normalizeWorkspaceFileNavigationKey({
        hostId: "local",
        includeHidden: true,
        workspaceRoot: "/",
      }).workspaceRoot,
    ).toBe("/");
    expect(
      normalizeWorkspaceFileNavigationKey({
        hostId: "local",
        includeHidden: true,
        workspaceRoot: "C:\\",
      }).workspaceRoot,
    ).toBe("C:/");

    expect(
      workspaceFileNavigationStateFamily({
        hostId: "local",
        includeHidden: true,
        workspaceRoot: "C:\\repo\\nodex\\",
      }),
    ).toBe(
      workspaceFileNavigationStateFamily({
        hostId: "local",
        includeHidden: true,
        workspaceRoot: "C:/repo/nodex",
      }),
    );
  });

  test("normalizes paths, duplicates, and invalid scroll offsets", () => {
    expect(
      normalizeWorkspaceFileNavigationState({
        ...EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
        expandedPaths: ["", "src/", "src", "\\src\\components\\"],
        selectedPath: "\\src\\index.ts",
        searchQuery: "index",
        scrollTop: Number.NaN,
      }),
    ).toEqual({
      ...EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
      expandedPaths: ["", "src", "src/components"],
      selectedPath: "src/index.ts",
      searchQuery: "index",
      scrollTop: 0,
    });
  });

  test("rejects root-escaping paths and resolves contained parent segments", () => {
    expect(
      normalizeWorkspaceFileNavigationState({
        ...EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
        expandedPaths: ["", "../outside", "src/../../outside", "src/../docs"],
        selectedPath: "../outside.ts",
      }),
    ).toEqual({
      ...EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
      expandedPaths: ["", "docs"],
      selectedPath: null,
    });

    expect(
      selectWorkspaceFileNavigationPath(EMPTY_WORKSPACE_FILE_NAVIGATION_STATE, "../outside.ts"),
    ).toBe(EMPTY_WORKSPACE_FILE_NAVIGATION_STATE);
    expect(
      updateWorkspaceFileNavigationExpansion(
        EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
        "../outside",
        true,
      ),
    ).toBe(EMPTY_WORKSPACE_FILE_NAVIGATION_STATE);
  });

  test("merges selected-file ancestors without collapsing unrelated branches", () => {
    const state = {
      ...EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
      expandedPaths: ["", "docs", "packages/other"],
    };
    expect(selectWorkspaceFileNavigationPath(state, "src/components/button.tsx")).toEqual({
      ...state,
      expandedPaths: ["", "docs", "packages/other", "src", "src/components"],
      selectedPath: "src/components/button.tsx",
    });
  });

  test("returns the same reference for a semantic no-op", () => {
    const state = selectWorkspaceFileNavigationPath(
      EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
      "src/index.ts",
    );
    expect(selectWorkspaceFileNavigationPath(state, "src/index.ts")).toBe(state);
    expect(updateWorkspaceFileNavigationExpansion(state, "src", true)).toBe(state);
  });

  test("keeps the root expanded when collapsing paths", () => {
    const state = selectWorkspaceFileNavigationPath(
      EMPTY_WORKSPACE_FILE_NAVIGATION_STATE,
      "src/index.ts",
    );
    expect(updateWorkspaceFileNavigationExpansion(state, "src", false).expandedPaths).toEqual([""]);
    expect(updateWorkspaceFileNavigationExpansion(state, "", false).expandedPaths).toEqual([
      "",
      "src",
    ]);
  });
});
