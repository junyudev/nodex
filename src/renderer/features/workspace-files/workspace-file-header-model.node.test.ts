import { describe, expect, test } from "vite-plus/test";
import {
  buildGitHubBlobUrl,
  parseGitHubRemote,
  preferredWorkspaceFileCopyPath,
  resolveWorkspaceFileBreadcrumb,
  resolveWorkspaceFilePathVariants,
} from "./workspace-file-header-model";

describe("workspace file header model", () => {
  test("starts the breadcrumb at the workspace folder, else the working directory", () => {
    expect(
      resolveWorkspaceFileBreadcrumb({
        cwd: null,
        workspaceRoot: "/repo/nodex",
        path: "/repo/nodex/notes/review.webm",
      }),
    ).toEqual({ segments: ["nodex", "notes", "review.webm"], title: "nodex/notes/review.webm" });
    expect(
      resolveWorkspaceFileBreadcrumb({
        cwd: "/tmp/run",
        workspaceRoot: "/repo/nodex",
        path: "/tmp/run/out.mp4",
      }).segments,
    ).toEqual(["run", "out.mp4"]);
    expect(
      resolveWorkspaceFileBreadcrumb({ cwd: null, workspaceRoot: null, path: "/var/log/app.log" }),
    ).toEqual({ segments: ["var", "log", "app.log"], title: "/var/log/app.log" });
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
