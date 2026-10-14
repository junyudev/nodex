import { describe, expect, test, vi } from "vite-plus/test";
import {
  createFileReferenceRouter,
  openFileReferenceExternally,
  resolveFileReferenceTarget,
} from "./file-reference-router";

describe("file reference router", () => {
  test.each([
    ["/source", "src/a%20b.ts", "/source/src/a%20b.ts"],
    ["/source", "a/file.ts ", "/source/a/file.ts "],
    ["C:\\repo", "src/a%20b.ts", "C:/repo/src/a%20b.ts"],
    ["\\\\server\\share\\repo", "../a%20b.ts", "//server/share/a%20b.ts"],
  ])(
    "resolves native reference %s + %s without URI or patch-prefix decoding",
    (base, path, expected) => {
      expect(resolveFileReferenceTarget({ path, line: 7 }, base)).toEqual({
        path: expected,
        line: 7,
      });
    },
  );
  test("keeps already absolute native spelling and requires a captured absolute directory for relative references", () => {
    const target = { path: "C:\\repo\\a%20b.ts ", line: 7 };
    expect(resolveFileReferenceTarget(target, "/unrelated")).toEqual(target);
    expect(resolveFileReferenceTarget({ path: "a/file.ts" })).toBeNull();
    expect(resolveFileReferenceTarget({ path: "a/file.ts" }, "relative-root")).toBeNull();
    expect(resolveFileReferenceTarget({ path: "bad\0file.ts" }, "/source")).toBeNull();
  });
  test("a relative remote request without a captured directory cannot reach Files or a native opener", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const router = createFileReferenceRouter({ opener: "vscode", port: { openWorkspaceFileTab } });
    expect(await router.open({ path: "src/file.ts" }, { hostId: "ssh:source" })).toBe(false);
    expect(openWorkspaceFileTab).not.toHaveBeenCalled();
  });
  test("withdrawn source authority prevents dispatch and external fallback after an awaited panel result", async () => {
    let current = false;
    const isCurrent = () => current;
    const openWorkspaceFileTab = vi.fn(async (input: { isCurrent?: () => boolean }) => {
      expect(input.isCurrent?.()).toBe(true);
      current = false;
      return false;
    });
    const router = createFileReferenceRouter({ opener: "vscode", port: { openWorkspaceFileTab } });
    expect(await router.open({ path: "/tmp/source.ts" }, { isCurrent })).toBe(false);
    expect(openWorkspaceFileTab).not.toHaveBeenCalled();
    current = true;
    expect(await router.open({ path: "/tmp/source.ts" }, { isCurrent })).toBe(false);
    expect(openWorkspaceFileTab).toHaveBeenCalledOnce();
  });
  test("an external opener result cannot start a fallback after source retirement", async () => {
    let current = true;
    const openExternal = vi.fn(async () => {
      current = false;
      return false;
    });
    expect(
      await openFileReferenceExternally(
        { path: "/tmp/source.ts" },
        "vscode",
        openExternal,
        () => current,
      ),
    ).toBe(false);
    expect(openExternal).toHaveBeenCalledOnce();
  });
  test("passes a remote host to Files and never falls back to a local opener", async () => {
    const openWorkspaceFileTab = vi.fn(async () => false);
    const router = createFileReferenceRouter({ opener: "vscode", port: { openWorkspaceFileTab } });
    const target = { path: "C:/repo/file.md" };
    await expect(router.open(target, { hostId: "remote-ssh-discovered:win" })).resolves.toBe(false);
    expect(openWorkspaceFileTab).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-ssh-discovered:win", path: target.path }),
    );
    openWorkspaceFileTab.mockClear();
    await expect(
      router.open(target, { hostId: "remote-ssh-discovered:win", external: true }),
    ).resolves.toBe(false);
    expect(openWorkspaceFileTab).not.toHaveBeenCalled();
  });
  test("uses the panel port for an ordinary file reference", async () => {
    const openWorkspaceFileTab = vi.fn(async () => true);
    const router = createFileReferenceRouter({
      opener: "vscode",
      port: { openWorkspaceFileTab },
    });

    await expect(
      router.open(
        {
          path: "/workspace/project/src/index.ts",
          line: 19,
          column: 4,
        },
        {
          cwd: "/workspace/project",
          workspaceRoot: "/workspace/project",
          title: "index.ts",
        },
      ),
    ).resolves.toBe(true);

    expect(openWorkspaceFileTab).toHaveBeenCalledWith({
      cwd: "/workspace/project",
      hostId: "local",
      path: "/workspace/project/src/index.ts",
      title: "index.ts",
      panelId: "right",
      mode: "preview",
      workspaceRoot: "/workspace/project",
      location: { line: 19, column: 4 },
    });
  });

  test("falls back to Finder when the selected external opener cannot open", async () => {
    const openExternal = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      openFileReferenceExternally(
        { path: "/workspace/project/src/index.ts", line: 19 },
        "vscode",
        openExternal,
      ),
    ).resolves.toBe(true);

    expect(openExternal).toHaveBeenNthCalledWith(
      2,
      { path: "/workspace/project/src/index.ts", line: 19 },
      "fileManager",
    );
  });
});
