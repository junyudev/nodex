import { expect, test, vi } from "vite-plus/test";
import { openCommandPaletteProjectFolder } from "./command-palette-projects";
import type { Project, ProjectWindow } from "./types";

const project = (id: string, root: string): Project => ({
  id,
  name: id,
  libraryId: "library:test",
  databaseId: "database:test",
  defaultDatabaseViewId: null,
  lifecycle: "active",
  bindingRevision: 1,
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [{ root, order: 0 }],
  primaryWorkspaceRoot: root,
  pinned: false,
  pinnedOrder: null,
  created: new Date(0),
  updated: new Date(0),
});
const window = (items: Project[], nextCursor: string | null = null): ProjectWindow => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
  storeEpoch: "epoch:test",
  projectionRevision: 1,
});
const ports = () => ({
  chooseFolder: vi.fn<() => Promise<string | null>>(async () => "/work/new-project"),
  readProjects: vi.fn(async () => window([])),
  createProject: vi.fn(async () => project("created", "/work/new-project")),
  startChat: vi.fn(async (_projectId: string) => {}),
});

test("opening an existing folder selects its Project even beyond the first catalog window", async () => {
  const api = ports();
  api.readProjects.mockResolvedValueOnce(window([project("other", "/work/other")], "next"));
  api.readProjects.mockResolvedValueOnce(window([project("existing", "/work/new-project/")]));
  await openCommandPaletteProjectFolder(api);
  expect(api.readProjects).toHaveBeenLastCalledWith({ first: 100, after: "next" });
  expect(api.createProject).not.toHaveBeenCalled();
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith("existing");
});

test("an unregistered folder creates a named Project and opens its chat composer", async () => {
  const api = ports();
  await openCommandPaletteProjectFolder(api);
  expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
    name: "new-project",
    sources: ["/work/new-project"],
  });
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
});

test("opening one folder does not reuse a multi-folder Project with another working directory", async () => {
  const api = ports();
  const multiRoot = project("multi", "/work/primary");
  multiRoot.sources.push({ root: "/work/new-project", order: 1 });
  api.readProjects.mockResolvedValue(window([multiRoot]));
  await openCommandPaletteProjectFolder(api);
  expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
    name: "new-project",
    sources: ["/work/new-project"],
  });
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
});

test.each([
  { existing: "C:\\Work\\Repo", selected: "c:/work/repo/" },
  { existing: "\\\\Server\\Share\\Repo", selected: "//server/share/repo" },
])(
  "opening a Windows folder reuses its Project despite path case or separator differences ($existing)",
  async ({ existing, selected }) => {
    const api = ports();
    api.chooseFolder.mockResolvedValue(selected);
    api.readProjects.mockResolvedValue(window([project("existing", existing)]));
    await openCommandPaletteProjectFolder(api);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.startChat).toHaveBeenCalledExactlyOnceWith("existing");
  },
);

test("opening a distinct POSIX folder preserves case in the new Project source", async () => {
  const api = ports();
  api.chooseFolder.mockResolvedValue("/work/Repo");
  api.readProjects.mockResolvedValue(window([project("existing", "/work/repo")]));
  await openCommandPaletteProjectFolder(api);
  expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
    name: "Repo",
    sources: ["/work/Repo"],
  });
  expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
});

test("canceling the folder picker leaves Project and navigation state untouched", async () => {
  const api = ports();
  api.chooseFolder.mockResolvedValue(null);
  await openCommandPaletteProjectFolder(api);
  expect(api.readProjects).not.toHaveBeenCalled();
  expect(api.createProject).not.toHaveBeenCalled();
  expect(api.startChat).not.toHaveBeenCalled();
});

test("a failed catalog read or creation never opens a chat or duplicates a Project", async () => {
  const api = ports();
  api.readProjects.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(openCommandPaletteProjectFolder(api)).rejects.toThrow("Unavailable");
  expect(api.createProject).not.toHaveBeenCalled();
  api.createProject.mockRejectedValueOnce(new Error("Cannot create"));
  await expect(openCommandPaletteProjectFolder(api)).rejects.toThrow("Cannot create");
  expect(api.startChat).not.toHaveBeenCalled();
});
