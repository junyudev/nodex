import { describe, expect, it } from "vite-plus/test";
import { resolveWorkbenchPanelCapabilities } from "./workbench-panel-capabilities";

describe("resolveWorkbenchPanelCapabilities", () => {
  it("offers Review first for an attached projectless chat in the right panel", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: null,
        hasAttachedThread: true,
        cwd: "/workspace",
      },
    });

    expect(result.availableActionKinds).toEqual([
      "review",
      "side_chat",
      "browser",
      "terminal",
      "files",
      "new_page",
    ]);
  });

  it("offers side chat, browser, terminal, then files to attached projectless chats in the bottom panel", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "bottom",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: null,
        hasAttachedThread: true,
        cwd: "/workspace",
      },
    });

    expect(result.availableActionKinds).toEqual(["side_chat", "browser", "terminal", "files"]);
  });

  it("keeps Review unavailable without an attached thread", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: null,
        hasAttachedThread: false,
        cwd: null,
      },
    });

    expect(result.actions.review.reason).toBe("no_thread");
  });

  it("offers a chat without a Project its Terminal and Files before it has a folder", () => {
    const blank = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: null,
        hasAttachedThread: false,
        cwd: null,
      },
    });
    const bottom = resolveWorkbenchPanelCapabilities({
      panelId: "bottom",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: null,
        hasAttachedThread: false,
        cwd: null,
      },
    });

    expect(blank.availableActionKinds).toEqual(["browser", "terminal", "files", "new_page"]);
    expect(bottom.availableActionKinds).toEqual(["browser", "terminal", "files"]);
    expect(blank.actions.side_chat.reason).toBe("no_thread");
  });

  it("keeps Terminal from a Project chat that has no folder", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: false,
        cwd: null,
        projectWorkspaceRoot: null,
      },
    });

    expect(result.actions.terminal.reason).toBe("no_cwd");
  });

  it("keeps the existing project-backed action order and panel eligibility", () => {
    const right = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: true,
        cwd: null,
        projectWorkspaceRoot: "/project",
      },
    });
    const bottom = resolveWorkbenchPanelCapabilities({
      panelId: "bottom",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: true,
        cwd: null,
        projectWorkspaceRoot: "/project",
      },
    });

    expect(right.availableActionKinds).toEqual([
      "review",
      "terminal",
      "browser",
      "files",
      "side_chat",
      "new_page",
      "db_view",
      "page_stage",
      "canvas_stage",
    ]);
    expect(bottom.availableActionKinds).toEqual(["terminal", "browser", "files", "side_chat"]);
  });

  it("offers an independent side chat from ACP history while native Review remains unavailable", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "acp",
        projectId: "project-1",
        hasAttachedThread: true,
        cwd: "/workspace",
        projectWorkspaceRoot: "/workspace",
      },
    });

    expect(result.actions.review.reason).toBe("backend_not_supported");
    expect(result.actions.side_chat.available).toBe(true);
    expect(result.availableActionKinds).toEqual([
      "terminal",
      "browser",
      "files",
      "side_chat",
      "new_page",
      "db_view",
      "page_stage",
      "canvas_stage",
    ]);
  });

  it("hides an existing singleton without changing other actions", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: true,
        cwd: "/workspace",
      },
      existingTabKinds: ["review", "browser"],
    });

    expect(result.actions.review.reason).toBe("singleton_exists");
    expect(result.actions.browser.available).toBe(true);
  });

  it("keeps Session-only actions out of Project Scenes", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "project",
        projectId: "project-1",
        projectWorkspaceRoot: "/project",
      },
    });

    expect(result.availableActionKinds).toEqual([
      "terminal",
      "browser",
      "files",
      "new_page",
      "db_view",
      "page_stage",
      "canvas_stage",
    ]);
    expect(result.actions.review.reason).toBe("session_required");
    expect(result.actions.side_chat.reason).toBe("session_required");
  });

  it("requires an attached thread for Review in project-backed Sessions", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: false,
        cwd: null,
        projectWorkspaceRoot: "/project",
      },
    });

    expect(result.actions.review.reason).toBe("no_thread");
    expect(result.availableActionKinds).not.toContain("review");
  });

  it("does not expose generic execution actions in the Library Scene", () => {
    const result = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: { kind: "library" },
    });

    expect(result.availableActionKinds).toEqual([]);
    expect(result.actions.review.reason).toBe("owner_not_supported");
  });
});
