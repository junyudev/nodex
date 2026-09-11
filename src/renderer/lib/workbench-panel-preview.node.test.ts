import { describe, expect, test } from "vite-plus/test";
import type { ProjectSessionThreadLink } from "@/lib/types";
import {
  isPreviewableWorkbenchTabKind,
  makePinnedPreviewTabCreateInput,
  makePreviewPageStageTab,
  makePreviewWorkbenchTabProjection,
  makePreviewWorkspaceFileTab,
  makeWorkbenchTabProjectionDraft,
  sameWorkbenchPreviewInstance,
} from "./workbench-panel-preview";
import { makeTestWorkbenchSession } from "@/components/workbench/workbench-testkit/panel-fixtures";

function thread(cwd: string): ProjectSessionThreadLink {
  return {
    sessionId: "session-1",
    projectId: null,
    threadId: "thread-1",
    threadName: "Thread",
    threadPreview: "Thread",
    backendBinding: { kind: "codex" },
    executionHostId: "local",
    cwd,
    statusType: "notLoaded",
    statusActiveFlags: [],
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    linkedAt: "2026-07-28T00:00:00.000Z",
    managedWorktreePath: null,
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
  };
}

describe("workbench panel preview", () => {
  test("limits generic preview replacement to browser and files", () => {
    expect(isPreviewableWorkbenchTabKind("browser")).toBe(true);
    expect(isPreviewableWorkbenchTabKind("files")).toBe(true);
    expect(isPreviewableWorkbenchTabKind("terminal")).toBe(false);
    expect(isPreviewableWorkbenchTabKind("page_stage")).toBe(false);
  });

  test("guards projectless draft creation by runtime capability", () => {
    const projectless = makeTestWorkbenchSession({ projectId: null });
    expect(makeWorkbenchTabProjectionDraft(projectless, "browser")).toMatchObject({
      kind: "browser",
    });
    expect(makeWorkbenchTabProjectionDraft(projectless, "files")).toBeNull();
    expect(makeWorkbenchTabProjectionDraft(projectless, "review")).toBeNull();
    expect(makeWorkbenchTabProjectionDraft(projectless, "terminal")).toBeNull();

    const attached = makeTestWorkbenchSession({
      projectId: null,
      thread: thread("/workspace"),
    });
    expect(makeWorkbenchTabProjectionDraft(attached, "terminal")).toMatchObject({
      kind: "terminal",
      config: {
        terminalSessionId: expect.any(String),
      },
    });
    expect(makeWorkbenchTabProjectionDraft(attached, "review")).toMatchObject({
      kind: "review",
      config: { projectId: null },
    });
  });

  test("gives each Browser runtime a distinct preview identity that survives promotion", () => {
    const session = makeTestWorkbenchSession();
    const draft = makeWorkbenchTabProjectionDraft(session, "browser");
    if (!draft) throw new Error("Browser draft should be available");
    const first = makePreviewWorkbenchTabProjection(session, "right", draft);
    const replacement = makePreviewWorkbenchTabProjection(session, "right", draft);
    expect(replacement.id).not.toBe(first.id);
    expect(
      makePinnedPreviewTabCreateInput(session, "bottom", "another-group", first).clientTabId,
    ).toBe(first.id);
    expect(replacement.browserTabId).not.toBe(first.browserTabId);
  });

  test("reuses canonical file identity across groups", () => {
    const session = makeTestWorkbenchSession();
    const first = makePreviewWorkspaceFileTab(session, "right", {
      cwd: "/workspace",
      leafId: "leaf-1",
      path: "src/a.ts",
      title: "a.ts",
      workspaceRoot: "/workspace",
    });
    const differentLeaf = makePreviewWorkspaceFileTab(session, "right", {
      cwd: "/workspace",
      leafId: "leaf-2",
      path: "src/a.ts",
      title: "a.ts",
      workspaceRoot: "/workspace",
    });
    expect(first.id).toBe("file:local:/workspace/src/a.ts");
    expect(differentLeaf.id).toBe(first.id);
    expect(
      sameWorkbenchPreviewInstance(first, {
        ...first,
        stateKey: 4,
        state: { pendingReveal: { line: 20 } },
        panelId: "bottom",
      }),
    ).toBe(true);
    expect(sameWorkbenchPreviewInstance(first, differentLeaf)).toBe(false);
    expect(first.config.path).toBe("/workspace/src/a.ts");
  });

  test("carries a file reference reveal location into preview state", () => {
    const session = makeTestWorkbenchSession();
    const preview = makePreviewWorkspaceFileTab(session, "right", {
      cwd: "/workspace",
      leafId: "leaf-1",
      path: "/workspace/src/a.ts",
      title: "a.ts",
      workspaceRoot: "/workspace",
      location: { line: 12, column: 3, endLine: 14, endColumn: 2 },
    });

    expect(preview.state).toEqual({
      pendingReveal: { line: 12, column: 3, endLine: 14, endColumn: 2 },
    });
  });

  test("creates new Page preview identity and preserves it on promotion", () => {
    const session = makeTestWorkbenchSession();
    const first = makePreviewPageStageTab(session, "right", {
      projectId: "project-1",
      pageId: "page-1",
    });
    const replacement = makePreviewPageStageTab(session, "right", {
      projectId: "project-1",
      pageId: "page-1",
    });
    expect(replacement.id).not.toBe(first.id);
    expect(makePinnedPreviewTabCreateInput(session, "right", "right-leaf", first)).toMatchObject({
      clientTabId: first.id,
      kind: "page_stage",
    });
  });

  test("preserves Browser runtime identity and rehomes file project config", () => {
    const session = makeTestWorkbenchSession();
    const browserDraft = makeWorkbenchTabProjectionDraft(session, "browser");
    if (!browserDraft) throw new Error("Browser draft should exist");
    const browser = makePreviewWorkbenchTabProjection(session, "right", browserDraft);
    expect(makePinnedPreviewTabCreateInput(session, "right", "right-leaf", browser)).toMatchObject({
      browserTabId: browser.browserTabId,
      config: {
        browserStorageId: `browser:${browser.browserTabId}`,
      },
      kind: "browser",
    });

    const projectlessFile = makePreviewWorkspaceFileTab(
      makeTestWorkbenchSession({ projectId: null }),
      "right",
      {
        cwd: "/workspace",
        leafId: "right-leaf",
        path: "src/a.ts",
        title: "a.ts",
        workspaceRoot: "/workspace",
      },
    );
    expect(
      makePinnedPreviewTabCreateInput(session, "right", "right-leaf", projectlessFile),
    ).toMatchObject({
      clientTabId: projectlessFile.id,
      config: { projectId: "project-1" },
    });
  });
});
