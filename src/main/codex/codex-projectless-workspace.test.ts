import { describe, expect, test } from "vite-plus/test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chatDirectoryName,
  createCodexProjectlessWorkspace,
  formatCodexProjectlessLocalDate,
  parseCodexProjectlessWorkspace,
  type CodexProjectlessWorkspaceFileSystem,
} from "./codex-projectless-workspace";

async function captureErrorMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Codex projectless workspace", () => {
  test("names a folder after the first words of its message, in ASCII", () => {
    expect(formatCodexProjectlessLocalDate(new Date(2026, 0, 2, 23, 59, 59))).toBe("2026-01-02");
    expect(chatDirectoryName("One two three four five six seven eight")).toBe(
      "one-two-three-four-five-six",
    );
    expect(chatDirectoryName("帮我修复 login 页面的 bug")).toBe("login-bug");
    expect(chatDirectoryName("你好，世界")).toBe("new-chat");
    expect(chatDirectoryName("🗂️")).toBe("new-chat");
    expect(chatDirectoryName(null)).toBe("new-chat");
    expect(chatDirectoryName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });

  test("creates a split workspace under the projects directory with cwd at the thread root", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-home-"));
    try {
      const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
      const workspace = await createCodexProjectlessWorkspace({
        createSplitDirectories: true,
        date: new Date(2026, 6, 11, 12),
        workspaceRoot,
        nameHint: "Draft a concise launch report with sources",
      });
      const threadDirectory = path.join(
        workspaceRoot,
        "2026-07-11",
        "draft-a-concise-launch-report-with",
      );

      expect(workspace.workspaceRoot).toBe(workspaceRoot);
      expect(workspace.cwd).toBe(threadDirectory);
      expect(workspace.outputDirectory).toBe(path.join(threadDirectory, "outputs"));
      expect((await lstat(threadDirectory)).isDirectory()).toBe(true);
      expect((await lstat(path.join(threadDirectory, "outputs"))).isDirectory()).toBe(true);
      expect((await lstat(path.join(threadDirectory, "work"))).isDirectory()).toBe(true);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("validates a renderer-returned workspace descriptor", () => {
    expect(
      parseCodexProjectlessWorkspace({
        cwd: "/tmp/Nodex/thread",
        outputDirectory: "/tmp/Nodex/thread/outputs",
        workspaceRoot: "/tmp/Nodex",
      }),
    ).toStrictEqual({
      cwd: "/tmp/Nodex/thread",
      outputDirectory: "/tmp/Nodex/thread/outputs",
      workspaceRoot: "/tmp/Nodex",
    });
    expect(() =>
      parseCodexProjectlessWorkspace({
        cwd: "",
        outputDirectory: "/tmp/Nodex/thread/outputs",
        workspaceRoot: "/tmp/Nodex",
      }),
    ).toThrow("Projectless workspace cwd must be a non-empty string");
  });

  test("tries 100 numeric names followed by at most five unique names", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-collision-"));
    try {
      const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
      const dateDirectory = path.join(workspaceRoot, "2026-07-11");
      await mkdir(dateDirectory, { recursive: true });
      for (let index = 0; index < 100; index += 1) {
        const name = index === 0 ? "collision" : `collision-${index + 1}`;
        await mkdir(path.join(dateDirectory, name));
      }
      for (let index = 1; index < 5; index += 1) {
        await mkdir(path.join(dateDirectory, `collision-uuid-${index}`));
      }

      let suffixAttempt = 0;
      const workspace = await createCodexProjectlessWorkspace({
        createSplitDirectories: false,
        date: new Date(2026, 6, 11, 12),
        nameHint: "collision",
        workspaceRoot,
        uniqueDirectoryNameSuffix: () => `uuid-${(suffixAttempt += 1)}`,
      });

      const expectedDirectory = path.join(dateDirectory, "collision-uuid-5");
      expect(suffixAttempt).toBe(5);
      expect(workspace.cwd).toBe(expectedDirectory);
      expect(workspace.outputDirectory).toBe(expectedDirectory);
      expect((await lstat(expectedDirectory)).isDirectory()).toBe(true);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked workspace and date directories", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "nodex-projectless-symlink-"));
    try {
      const homeDirectory = path.join(fixtureRoot, "home");
      const targetDirectory = path.join(fixtureRoot, "target");
      const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
      await mkdir(path.dirname(workspaceRoot), { recursive: true });
      await mkdir(targetDirectory);
      await symlink(targetDirectory, workspaceRoot, "dir");

      expect(
        await captureErrorMessage(() =>
          createCodexProjectlessWorkspace({
            createSplitDirectories: false,
            date: new Date(2026, 6, 11, 12),
            workspaceRoot,
            nameHint: "workspace symlink",
          }),
        ),
      ).toBe("Projectless thread directory must be a real directory");

      await rm(workspaceRoot, { force: true });
      await mkdir(workspaceRoot);
      await symlink(targetDirectory, path.join(workspaceRoot, "2026-07-11"), "dir");

      expect(
        await captureErrorMessage(() =>
          createCodexProjectlessWorkspace({
            createSplitDirectories: false,
            date: new Date(2026, 6, 11, 12),
            workspaceRoot,
            nameHint: "date symlink",
          }),
        ),
      ).toBe("Projectless thread directory must be a real directory");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("falls back to one unsplit directory when split subdirectory creation fails", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-fallback-"));
    const fileSystem: CodexProjectlessWorkspaceFileSystem = {
      async createDirectory(input) {
        if (path.basename(input.path) === "work") throw new Error("simulated split failure");
        await mkdir(input.path, { recursive: input.recursive });
      },
      async getMetadata(directoryPath) {
        const metadata = await lstat(directoryPath);
        return {
          isDirectory: metadata.isDirectory(),
          isSymlink: metadata.isSymbolicLink(),
        };
      },
    };

    try {
      const workspace = await createCodexProjectlessWorkspace({
        createSplitDirectories: true,
        date: new Date(2026, 6, 11, 12),
        fileSystem,
        workspaceRoot: homeDirectory,
        nameHint: "fallback",
      });

      expect(workspace.outputDirectory).toBe(workspace.cwd);
      expect((await lstat(workspace.cwd)).isDirectory()).toBe(true);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
