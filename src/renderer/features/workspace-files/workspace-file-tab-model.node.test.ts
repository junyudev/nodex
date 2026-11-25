import { describe, expect, test } from "vite-plus/test";
import {
  buildGitHubBlobUrl,
  parseGitHubRemote,
  preferredWorkspaceFileCopyPath,
  resolveWorkspaceFileBreadcrumb,
  resolveWorkspaceFilePathVariants,
} from "./workspace-file-header-model";
import {
  clampWorkspaceTreeWidth,
  WORKSPACE_TREE_DEFAULT_WIDTH,
  WORKSPACE_TREE_MIN_WIDTH,
} from "./workspace-file-layout";
import {
  decideWorkspaceFileTabOpen,
  type WorkspaceFileTabCandidate,
} from "./workspace-file-tab-model";

describe("workspace file header model", () => {
  test("starts the breadcrumb at the workspace folder, else the working directory", () => {
    expect(
      resolveWorkspaceFileBreadcrumb({
        cwd: null,
        workspaceRoot: "/repo/nodex",
        path: "/repo/nodex/notes/review.webm",
      }),
    ).toEqual({
      segments: ["nodex", "notes", "review.webm"],
      title: "nodex/notes/review.webm",
      workspacePaths: ["", "notes", "notes/review.webm"],
    });
    const cwdTrail = resolveWorkspaceFileBreadcrumb({
      cwd: "/tmp/run",
      workspaceRoot: "/repo/nodex",
      path: "/tmp/run/out.mp4",
    });
    expect(cwdTrail.segments).toEqual(["run", "out.mp4"]);
    // Only the workspace root's folders are browsable from the trail.
    expect(cwdTrail.workspacePaths).toBeNull();
    expect(
      resolveWorkspaceFileBreadcrumb({ cwd: null, workspaceRoot: null, path: "/var/log/app.log" }),
    ).toEqual({
      segments: ["var", "log", "app.log"],
      title: "/var/log/app.log",
      workspacePaths: null,
    });
    expect(
      resolveWorkspaceFileBreadcrumb({ cwd: null, workspaceRoot: "/repo/nodex", path: null })
        .segments,
    ).toEqual(["nodex"]);
  });

  test("offers repo- and project-relative forms only for files inside those roots", () => {
    const variants = resolveWorkspaceFilePathVariants({
      path: "/repo/app/packages/web/src/main.ts",
      projectRoot: "/repo/app/packages/web",
      repoRoot: "/repo/app",
    });
    expect(variants).toEqual({
      absolute: "/repo/app/packages/web/src/main.ts",
      projectRelative: "src/main.ts",
      repoRelative: "packages/web/src/main.ts",
    });
    expect(preferredWorkspaceFileCopyPath("/repo/app/packages/web/src/main.ts", variants)).toBe(
      "packages/web/src/main.ts",
    );
    const outside = resolveWorkspaceFilePathVariants({
      path: "/tmp/file.txt",
      projectRoot: "/repo/app",
      repoRoot: null,
    });
    expect(outside).toEqual({
      absolute: "/tmp/file.txt",
      projectRelative: null,
      repoRelative: null,
    });
    expect(preferredWorkspaceFileCopyPath("/tmp/file.txt", outside)).toBe("/tmp/file.txt");
  });

  test("recognizes GitHub remotes in https, ssh, and scp forms only", () => {
    expect(parseGitHubRemote("https://github.com/openai/nodex.git")).toEqual({
      owner: "openai",
      repo: "nodex",
    });
    expect(parseGitHubRemote("git@github.com:openai/nodex.git")).toEqual({
      owner: "openai",
      repo: "nodex",
    });
    expect(parseGitHubRemote("ssh://git@github.com/openai/nodex")).toEqual({
      owner: "openai",
      repo: "nodex",
    });
    expect(parseGitHubRemote("https://gitlab.com/openai/nodex.git")).toBeNull();
  });

  test("links the file on the current branch with encoded segments", () => {
    expect(
      buildGitHubBlobUrl({
        branch: "feature/media preview",
        path: "/repo/app/notes/review #1.webm",
        remoteUrl: "git@github.com:openai/nodex.git",
        root: "/repo/app",
        line: 4,
      }),
    ).toBe(
      "https://github.com/openai/nodex/blob/feature/media%20preview/notes/review%20%231.webm#L4",
    );
    expect(
      buildGitHubBlobUrl({
        branch: null,
        path: "/repo/app/a.ts",
        remoteUrl: "git@github.com:openai/nodex.git",
        root: "/repo/app",
      }),
    ).toBeNull();
    expect(
      buildGitHubBlobUrl({
        branch: "main",
        path: "/elsewhere/a.ts",
        remoteUrl: "git@github.com:openai/nodex.git",
        root: "/repo/app",
      }),
    ).toBeNull();
  });
});

describe("workspace file tree layout", () => {
  test("clamps restored and resized widths to the usable panel boundary", () => {
    expect(clampWorkspaceTreeWidth(Number.NaN, 1_000)).toBe(WORKSPACE_TREE_DEFAULT_WIDTH);
    expect(clampWorkspaceTreeWidth(100, 1_000)).toBe(WORKSPACE_TREE_MIN_WIDTH);
    expect(clampWorkspaceTreeWidth(900, 1_000)).toBe(600);
    expect(clampWorkspaceTreeWidth(300, 300)).toBe(WORKSPACE_TREE_MIN_WIDTH);
  });
});

describe("workspace file tab model", () => {
  const empty: WorkspaceFileTabCandidate = {
    hostId: "local",
    id: "files-empty",
    path: null,
  };
  const durable: WorkspaceFileTabCandidate = {
    hostId: "local",
    id: "files-a",
    path: "/repo/a.ts",
  };
  const preview: WorkspaceFileTabCandidate = {
    hostId: "local",
    id: "preview-b",
    path: "/repo/b.ts",
  };

  describe("workspace file tab state machine", () => {
    test("separates the same path on different hosts and pins only its own preview", () => {
      const remote = { ...preview, hostId: "remote-ssh-discovered:win" };
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: remote.hostId,
          mode: "preview",
          path: durable.path!,
          previewTab: null,
        }),
      ).toEqual({ kind: "create-preview", replacingPreviewTabId: null });
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: remote.hostId,
          mode: "durable",
          path: remote.path!,
          previewTab: remote,
        }),
      ).toEqual({ kind: "pin-preview", tabId: remote.id });
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: remote.path!,
          previewTab: remote,
        }),
      ).toEqual({ kind: "create-preview", replacingPreviewTabId: remote.id });
    });
    test("creates a semantic file tab before closing the active empty tab", () => {
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: empty.id,
          durableTabs: [empty],
          hostId: "local",
          mode: "preview",
          path: "/repo/a.ts",
          previewTab: null,
        }),
      ).toEqual({ kind: "create-from-empty", emptyTabId: empty.id });
    });

    test("creates, replaces, and pins the leaf preview explicitly", () => {
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: "/repo/b.ts",
          previewTab: null,
        }),
      ).toEqual({ kind: "create-preview", replacingPreviewTabId: null });
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: "/repo/c.ts",
          previewTab: preview,
        }),
      ).toEqual({
        kind: "create-preview",
        replacingPreviewTabId: preview.id,
      });
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "durable",
          path: preview.path ?? "",
          previewTab: preview,
        }),
      ).toEqual({ kind: "pin-preview", tabId: preview.id });
    });

    test("reuses matching durable and preview tabs without duplication", () => {
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: durable.path ?? "",
          previewTab: preview,
        }),
      ).toEqual({ kind: "focus-durable", tabId: durable.id });
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: preview.path ?? "",
          previewTab: preview,
        }),
      ).toEqual({ kind: "focus-preview", tabId: preview.id });
    });

    test("keeps an unrelated preview when focusing an existing durable file", () => {
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: preview.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "preview",
          path: durable.path ?? "",
          previewTab: preview,
        }),
      ).toEqual({ kind: "focus-durable", tabId: durable.id });
    });

    test("does not classify an unrelated preview as replaced for a direct durable open", () => {
      expect(
        decideWorkspaceFileTabOpen({
          activeDurableTabId: durable.id,
          durableTabs: [durable],
          hostId: "local",
          mode: "durable",
          path: "/repo/c.ts",
          previewTab: preview,
        }),
      ).toEqual({ kind: "create-durable" });
    });
  });
});
