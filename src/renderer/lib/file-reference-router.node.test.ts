import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createFileReferenceRouter,
  openFileReferenceExternally,
  resolveFileReferenceTarget,
} from "./file-reference-router";

const operations = vi.hoisted(() => ({
  metadata: vi.fn(),
  save: vi.fn(),
  targets: vi.fn(),
  native: vi.fn(),
  external: vi.fn(),
}));
vi.mock("./workspace-file-operations", () => ({
  readWorkspaceFileMetadata: operations.metadata,
  saveWorkspaceFileCopy: operations.save,
}));
vi.mock("./file-reference-open-targets", () => ({
  readFileReferenceOpenTargets: operations.targets,
  openFileReferenceTarget: operations.native,
}));
vi.mock("./file-system-operations", () => ({ openFileLink: operations.external }));
beforeEach(() => {
  vi.clearAllMocks();
  operations.metadata.mockResolvedValue({ isFile: true });
  operations.save.mockResolvedValue({ path: "/downloads/copy" });
  operations.targets.mockResolvedValue({
    primary: { id: "application:editor", label: "Editor", appPath: "/Applications/Editor.app" },
    alternatives: [],
  });
  operations.native.mockResolvedValue(true);
  operations.external.mockResolvedValue(true);
});

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
    const router = createFileReferenceRouter({ port: { openWorkspaceFileTab } });
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
    const router = createFileReferenceRouter({ port: { openWorkspaceFileTab } });
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
    const router = createFileReferenceRouter({ port: { openWorkspaceFileTab } });
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

  test("does not change the destination when a native opener fails", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    await expect(
      openFileReferenceExternally({ path: "/repo/file.ts" }, "vscode", openExternal),
    ).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ path: "/repo/file.ts" }, "vscode");
  });
});

test("local HTML renders internally independent of URL preferences, preserving native path escaping", async () => {
  const openLink = vi.fn(async () => true);
  const panel = vi.fn(async () => true);
  const router = createFileReferenceRouter({
    port: { openWorkspaceFileTab: panel },
    links: { browserAvailable: true, openLink },
  });
  expect(await router.open({ path: "/repo/a #?%.HTML" }, { sidePanel: true })).toBe(true);
  expect(openLink).toHaveBeenCalledExactlyOnceWith({
    url: "file:///repo/a%20%23%3F%25.HTML",
    hostId: "local",
    initiator: "open_in_browser_bridge",
    source: "manual",
    openTarget: "in-app-browser",
  });
  expect(panel).not.toHaveBeenCalled();
});
test("modified local HTML retains side-panel source view while a user reference chooses its real native target", async () => {
  const openLink = vi.fn(async () => true);
  const panel = vi.fn(async () => true);
  const router = createFileReferenceRouter({
    port: { openWorkspaceFileTab: panel },
    links: { browserAvailable: true, openLink },
  });
  const target = { path: "/repo/a.html" };
  const activation = { platform: "darwin", metaKey: true };
  await router.open(target, { activation });
  expect(panel).toHaveBeenCalledWith(
    expect.objectContaining({ path: target.path, mode: "preview" }),
  );
  await router.open(target, { sidePanel: false, activation });
  expect(operations.native).toHaveBeenCalledWith(
    expect.objectContaining({ appPath: "/Applications/Editor.app" }),
    target,
  );
  expect(openLink).not.toHaveBeenCalled();
});
test("a directory named like HTML opens the file manager and a location stays in Files", async () => {
  const openLink = vi.fn(async () => true);
  const panel = vi.fn(async () => true);
  const router = createFileReferenceRouter({
    port: { openWorkspaceFileTab: panel },
    links: { browserAvailable: true, openLink },
  });
  operations.metadata.mockResolvedValueOnce({ isFile: false });
  await router.open({ path: "/repo/folder.html" });
  expect(operations.external).toHaveBeenCalledExactlyOnceWith(
    { path: "/repo/folder.html" },
    "fileManager",
  );
  await router.open({ path: "/repo/a.html", line: 7, column: 3 });
  expect(panel).toHaveBeenCalledWith(expect.objectContaining({ location: { line: 7, column: 3 } }));
  expect(openLink).not.toHaveBeenCalled();
});
test("remote HTML retains its Files host and never enters local metadata or URL conversion", async () => {
  const openLink = vi.fn(async () => true);
  const panel = vi.fn(async () => true);
  const router = createFileReferenceRouter({
    port: { openWorkspaceFileTab: panel },
    links: { browserAvailable: true, openLink },
  });
  await router.open({ path: "/repo/a.html" }, { hostId: "ssh:build", mode: "durable" });
  expect(panel).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "ssh:build", mode: "durable" }),
  );
  expect(openLink).not.toHaveBeenCalled();
  expect(operations.metadata).not.toHaveBeenCalled();
});
