import { beforeEach, expect, test, vi } from "vite-plus/test";
import { buildFileReferenceContextMenu } from "./file-reference-context-menu";

const ports = vi.hoisted(() => ({
  targets: vi.fn(),
  openTarget: vi.fn(),
  github: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  copy: vi.fn(),
  external: vi.fn(),
}));
vi.mock("./file-reference-open-targets", () => ({
  readFileReferenceOpenTargets: ports.targets,
  openFileReferenceTarget: ports.openTarget,
}));
vi.mock("./workspace-file-operations", () => ({
  readWorkspaceFileGitHubUrl: ports.github,
  saveWorkspaceFileCopy: ports.save,
  readWorkspaceFileText: ports.read,
}));
vi.mock("./clipboard", () => ({ writeTextToClipboard: ports.copy }));
vi.mock("./file-system-operations", () => ({ openExternalUrl: ports.external }));

beforeEach(() => {
  vi.clearAllMocks();
  ports.targets.mockResolvedValue({
    primary: { id: "cursor", label: "Cursor", opener: "cursor" },
    alternatives: [{ id: "cursor", label: "Cursor", opener: "cursor" }],
  });
  ports.github.mockResolvedValue("https://github.com/team/project/blob/main/file.ts#L7");
});

test("editor file actions retain the real destinations and clicked GitHub line without reopening Files", async () => {
  const open = vi.fn();
  const target = { path: "/repo/file.ts", line: 7 };
  const menu = await buildFileReferenceContextMenu({
    target,
    label: "file.ts",
    open,
    includeOpenFile: false,
  });
  expect(menu.items.map((item) => item.id).filter(Boolean)).toEqual([
    "file-reference:preferred",
    "file-reference:open-with",
    "file-reference:github",
    "file-reference:save",
    "file-reference:copy-path",
    "file-reference:copy-contents",
    "file-reference:reveal",
  ]);
  expect(ports.github).toHaveBeenCalledExactlyOnceWith({ hostId: "local", ...target });
  await menu.select("file-reference:open-with:cursor");
  expect(ports.openTarget).toHaveBeenCalledExactlyOnceWith(
    { id: "cursor", label: "Cursor", opener: "cursor" },
    target,
  );
  expect(open).not.toHaveBeenCalled();
  await menu.select("file-reference:github");
  expect(ports.external).toHaveBeenCalledExactlyOnceWith(
    "https://github.com/team/project/blob/main/file.ts#L7",
  );
});

test("remote editor menus expose save and content actions without local applications or reveal", async () => {
  ports.github.mockResolvedValue(null);
  const menu = await buildFileReferenceContextMenu({
    hostId: "ssh:build",
    target: { path: "/remote/file.ts" },
    label: "file.ts",
    open: vi.fn(),
    includeOpenFile: false,
  });
  expect(menu.items.map((item) => item.id)).toEqual([
    "file-reference:save",
    "file-reference:copy-path",
    "file-reference:copy-contents",
  ]);
  expect(ports.targets).not.toHaveBeenCalled();
  await menu.select("file-reference:save");
  expect(ports.save).toHaveBeenCalledExactlyOnceWith({
    hostId: "ssh:build",
    path: "/remote/file.ts",
  });
});

test("captured file choices stop after their editor source retires", async () => {
  let current = true;
  const menu = await buildFileReferenceContextMenu({
    target: { path: "/repo/file.ts" },
    label: "file.ts",
    open: vi.fn(),
    isCurrent: () => current,
  });
  current = false;
  await menu.select("file-reference:preferred");
  expect(ports.openTarget).not.toHaveBeenCalled();
});

test("Open file alone does not introduce an empty destination separator", async () => {
  ports.targets.mockResolvedValue({ primary: null, alternatives: [] });
  ports.github.mockResolvedValue(null);
  const menu = await buildFileReferenceContextMenu({
    target: { path: "/repo/file.ts" },
    label: "file.ts",
    open: vi.fn(),
  });
  expect(menu.items[0]).toMatchObject({ id: "file-reference:open", label: "Open file" });
  expect(menu.items.some((item) => item.type === "separator")).toBe(false);
});
