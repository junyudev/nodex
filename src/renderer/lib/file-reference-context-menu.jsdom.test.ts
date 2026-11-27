import { beforeEach, expect, test, vi } from "vite-plus/test";
import { buildFileReferenceContextMenu } from "./file-reference-context-menu";

const ports = vi.hoisted(() => ({
  targets: vi.fn(),
  openTarget: vi.fn(),
  github: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  metadata: vi.fn(),
  reportError: vi.fn(),
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
  readWorkspaceFileMetadata: ports.metadata,
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: ports.reportError } }));
vi.mock("./clipboard", () => ({ writeTextToClipboard: ports.copy }));
vi.mock("./link-opening", () => ({ openLink: ports.external }));

beforeEach(() => {
  vi.clearAllMocks();
  ports.metadata.mockResolvedValue({ contentKind: "text" });
  ports.targets.mockResolvedValue({
    primary: { id: "cursor", label: "Cursor", opener: "cursor" },
    alternatives: [{ id: "vscode", label: "VS Code", opener: "vscode" }],
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
  await menu.select("file-reference:open-with:vscode");
  expect(ports.openTarget).toHaveBeenCalledExactlyOnceWith(
    { id: "vscode", label: "VS Code", opener: "vscode" },
    target,
  );
  expect(open).not.toHaveBeenCalled();
  await menu.select("file-reference:github");
  expect(ports.external).toHaveBeenCalledExactlyOnceWith({
    url: "https://github.com/team/project/blob/main/file.ts#L7",
    hostId: "local",
    initiator: "file_context_menu",
  });
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

test("separates the sole open action from the file commands", async () => {
  ports.targets.mockResolvedValue({ primary: null, alternatives: [] });
  ports.github.mockResolvedValue(null);
  const menu = await buildFileReferenceContextMenu({
    target: { path: "/repo/file.ts" },
    label: "file.ts",
    open: vi.fn(),
  });
  expect(menu.items[0]).toMatchObject({ id: "file-reference:open", label: "Open file" });
  expect(menu.items[1]?.type).toBe("separator");
});

test.each([true, false])("HTML menu keeps the caller's side-panel intent %s", async (sidePanel) => {
  const open = vi.fn(async () => true);
  const menu = await buildFileReferenceContextMenu({
    target: { path: "/repo/report.htm" },
    label: "Report",
    open,
    sidePanel,
    browserAvailable: true,
  });
  const id = sidePanel ? "file-reference:open" : "file-reference:browser";
  expect(menu.items[0]).toMatchObject({ id, label: sidePanel ? "Open file" : "View in browser" });
  await menu.select(id);
  expect(open).toHaveBeenCalledWith(
    { path: "/repo/report.htm" },
    expect.objectContaining({ sidePanel }),
  );
});
test("remote HTML never advertises a local browser", async () => {
  const menu = await buildFileReferenceContextMenu({
    hostId: "ssh:build",
    target: { path: "/repo/report.html" },
    label: "Report",
    open: vi.fn(),
    sidePanel: false,
    browserAvailable: true,
  });
  expect(menu.items.some((item) => item.id === "file-reference:browser")).toBe(false);
});

test("offers file contents only for text and reports a failed copy read", async () => {
  const input = { target: { path: "/repo/file" }, label: "file", open: vi.fn() };
  ports.metadata.mockResolvedValueOnce({ contentKind: "binary" });
  const binary = await buildFileReferenceContextMenu(input);
  expect(binary.items.some((item) => item.id === "file-reference:copy-contents")).toBe(false);
  const text = await buildFileReferenceContextMenu(input);
  ports.read.mockRejectedValueOnce(new Error("File disappeared"));
  await text.select("file-reference:copy-contents");
  expect(ports.reportError).toHaveBeenCalledOnce();
  expect(ports.copy).not.toHaveBeenCalled();
});
