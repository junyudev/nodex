import { describe, expect, test } from "vite-plus/test";
import { parseWorkbenchProjectionTabConfig } from "./project-sessions";

describe("project session Terminal config", () => {
  test("persists only the stable terminal session identity", () => {
    expect(
      parseWorkbenchProjectionTabConfig("terminal", {
        terminalSessionId: "terminal:one",
      }),
    ).toEqual({
      terminalSessionId: "terminal:one",
    });
  });

  test("rejects Project fields that do not belong to Terminal content", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("terminal", {
        projectId: "legacy-project",
        terminalSessionId: "terminal:one",
      }),
    ).toThrow();
  });
});

describe("project session Page Stage config", () => {
  test("persists only Page identity, access context, and a title snapshot", () => {
    expect(
      parseWorkbenchProjectionTabConfig("page_stage", {
        accessContext: { kind: "project", projectId: "alpha" },
        pageId: "nested",
        titleSnapshot: "Nested",
      }),
    ).toEqual({
      accessContext: { kind: "project", projectId: "alpha" },
      pageId: "nested",
      titleSnapshot: "Nested",
    });
  });

  test("rejects interaction-derived ancestor trails at the durable boundary", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("page_stage", {
        accessContext: { kind: "project", projectId: "alpha" },
        pageId: "nested",
        ancestors: [
          {
            projectId: "stale-project",
            pageId: "root",
            titleSnapshot: "Stale title",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("project session Canvas Stage config", () => {
  test("persists only public Canvas identity, access context, and title fallback", () => {
    expect(
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        accessContext: { kind: "project", projectId: "alpha" },
        canvasBlockId: "canvas:one",
        titleSnapshot: "Sketch",
      }),
    ).toEqual({
      accessContext: { kind: "project", projectId: "alpha" },
      canvasBlockId: "canvas:one",
      titleSnapshot: "Sketch",
    });
  });

  test("rejects missing Canvas identity and private Document identity", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        accessContext: { kind: "project", projectId: "alpha" },
      }),
    ).toThrow();
    expect(() =>
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        accessContext: { kind: "project", projectId: "alpha" },
        canvasBlockId: "canvas:one",
        documentId: "document:private",
      }),
    ).toThrow();
  });
});

describe("project session Files config", () => {
  test("persists projectless exact-file tabs without inventing a workspace root", () => {
    expect(
      parseWorkbenchProjectionTabConfig("files", {
        projectId: null,
        hostId: "local",
        workspaceRoot: null,
        cwd: "/tmp/worktree",
        path: "/tmp/worktree/README.md",
      }),
    ).toEqual({
      projectId: null,
      hostId: "local",
      workspaceRoot: null,
      cwd: "/tmp/worktree",
      path: "/tmp/worktree/README.md",
    });
  });

  test("normalizes legacy empty browsing coordinates to no navigation root", () => {
    expect(
      parseWorkbenchProjectionTabConfig("files", {
        projectId: "alpha",
        workspaceRoot: "",
        cwd: "   ",
      }),
    ).toEqual({
      projectId: "alpha",
      hostId: "local",
      workspaceRoot: null,
      cwd: null,
    });
  });
});

describe("project session Review config", () => {
  test("keeps only optional Project workspace metadata", () => {
    expect(
      parseWorkbenchProjectionTabConfig("review", {
        projectId: null,
        context: { kind: "session", sessionId: "session-1" },
      }),
    ).toEqual({
      projectId: null,
    });
  });

  test("normalizes legacy Project-owned Review config to workspace metadata", () => {
    expect(
      parseWorkbenchProjectionTabConfig("review", {
        projectId: "alpha",
        context: { kind: "project", projectId: "alpha" },
      }),
    ).toEqual({
      projectId: "alpha",
    });
  });

  test("rejects Review config without explicit Project metadata", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("review", {
        context: { kind: "session", sessionId: "session-1" },
      }),
    ).toThrow();
  });

  test("does not let legacy Review migration erase unknown fields", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("review", {
        projectId: "alpha",
        context: { kind: "project", projectId: "alpha" },
        unexpected: true,
      }),
    ).toThrow();
  });
});
