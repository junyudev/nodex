import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listWorkspaceDirectoryEntries,
  readWorkspaceFile,
  readWorkspaceFileBinary,
  readWorkspaceFileMetadata,
  searchWorkspaceFiles,
  saveWorkspaceFileCopy,
  toWorkspaceFileIpcError,
  WorkspaceFileUserError,
  writeWorkspaceFile,
} from "./workspace-files-service";

const tempRoots: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nodex-workspace-files-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("save copy preserves binary bytes, cancellation, and the source through symlinks", async () => {
  const root = await makeTempWorkspace();
  const source = join(root, "source.bin");
  const destination = join(root, "copy.bin");
  const bytes = Buffer.from([0, 255, 128, 1, 0, 3]);
  await writeFile(source, bytes);
  expect(
    await saveWorkspaceFileCopy({ path: source }, async (name) => {
      expect(name).toBe("source.bin");
      return destination;
    }),
  ).toEqual({ path: destination });
  expect(await readFile(destination)).toEqual(bytes);
  expect(await saveWorkspaceFileCopy({ path: source }, async () => null)).toEqual({ path: null });
  await symlink(source, join(root, "alias.bin"));
  await saveWorkspaceFileCopy({ path: source }, async () => join(root, "alias.bin"));
  expect(await readFile(source)).toEqual(bytes);
});

describe("workspace-files-service directory browsing", () => {
  test("returns canonical relative entries, parents, visibility, and directory filtering", async () => {
    const root = await makeTempWorkspace();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "README.md"), "# Project\n", "utf8");
    await writeFile(join(root, ".env"), "SECRET=no\n", "utf8");

    const rootResult = await listWorkspaceDirectoryEntries({ workspaceRoot: root });
    const visibleResult = await listWorkspaceDirectoryEntries({
      workspaceRoot: root,
      includeHidden: true,
    });
    const childResult = await listWorkspaceDirectoryEntries({
      workspaceRoot: root,
      directoryPath: "src/nested/.",
    });
    const directoryResult = await listWorkspaceDirectoryEntries({
      workspaceRoot: root,
      directoriesOnly: true,
    });

    expect(rootResult).toEqual({
      directoryPath: "",
      parentPath: null,
      entries: [
        { isSymlink: false, name: "node_modules", path: "node_modules", type: "directory" },
        { isSymlink: false, name: "src", path: "src", type: "directory" },
        { isSymlink: false, name: "README.md", path: "README.md", type: "file" },
      ],
    });
    expect(visibleResult.entries.at(-1)?.name).toBe("README.md");
    expect(visibleResult.entries.some((entry) => entry.name === ".env")).toBe(true);
    expect(childResult.directoryPath).toBe("src/nested");
    expect(childResult.parentPath).toBe("src");
    expect(directoryResult.entries.every((entry) => entry.type === "directory")).toBe(true);
  });

  test("omits directory symlinks that escape the root and permits internal directory symlinks", async () => {
    const root = await makeTempWorkspace();
    const outsideRoot = await makeTempWorkspace();
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "inside", "visible.txt"), "inside", "utf8");
    await writeFile(join(outsideRoot, "secret.txt"), "outside", "utf8");
    await symlink(outsideRoot, join(root, "escape"), "dir");
    await symlink(join(root, "inside"), join(root, "alias"), "dir");

    const result = await listWorkspaceDirectoryEntries({ workspaceRoot: root });
    const aliasResult = await listWorkspaceDirectoryEntries({
      workspaceRoot: root,
      directoryPath: "alias",
    });

    expect(result.entries.some((entry) => entry.name === "escape")).toBe(false);
    expect(result.entries.find((entry) => entry.name === "alias")).toEqual({
      isSymlink: true,
      name: "alias",
      path: "alias",
      type: "directory",
    });
    expect(aliasResult.entries.map((entry) => entry.name)).toEqual(["visible.txt"]);
  });

  test.each(["../outside", "/absolute", "C:\\absolute"])(
    "rejects invalid directory coordinate %s",
    async (directoryPath) => {
      const root = await makeTempWorkspace();
      await expect(
        listWorkspaceDirectoryEntries({ workspaceRoot: root, directoryPath }),
      ).rejects.toThrow(/relative to workspaceRoot|within workspaceRoot/);
    },
  );
});

describe("workspace-files-service workspace search", () => {
  test("finds nested, hidden, and generated files while excluding escaping symlinks", async () => {
    const root = await makeTempWorkspace();
    const outsideRoot = await makeTempWorkspace();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(join(root, "src", "nested", "needle.ts"), "export {};\n", "utf8");
    await writeFile(join(root, ".hidden", "needle.env"), "SAFE=yes\n", "utf8");
    await writeFile(
      join(root, "node_modules", "fixture", "needle.js"),
      "module.exports = {};\n",
      "utf8",
    );
    await writeFile(join(outsideRoot, "needle-secret.txt"), "outside", "utf8");
    await symlink(outsideRoot, join(root, "escape"), "dir");

    const result = await searchWorkspaceFiles({
      workspaceRoot: root,
      query: "needle",
    });

    expect(result.matches.map((match) => match.path)).toEqual([
      "node_modules/fixture/needle.js",
      "src/nested/needle.ts",
      ".hidden/needle.env",
    ]);
    expect(result.ancestorDirectories).toEqual([
      ".hidden",
      "node_modules",
      "node_modules/fixture",
      "src",
      "src/nested",
    ]);
    expect(result.truncated).toBe(false);
  });

  test("reports bounded traversal and result truncation deterministically", async () => {
    const root = await makeTempWorkspace();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(join(root, `match-${index}.txt`), `${index}`, "utf8"),
      ),
    );

    const resultLimited = await searchWorkspaceFiles({
      workspaceRoot: root,
      query: "match",
      maxResults: 2,
    });
    const traversalLimited = await searchWorkspaceFiles({
      workspaceRoot: root,
      query: "match",
      maxVisitedEntries: 1,
    });

    expect(resultLimited.matches.map((match) => match.path)).toEqual([
      "match-0.txt",
      "match-1.txt",
    ]);
    expect(resultLimited.truncated).toBe(true);
    expect(traversalLimited.matches).toHaveLength(1);
    expect(traversalLimited.truncated).toBe(true);
  });
});

describe("workspace-files-service exact file resources", () => {
  test.each([
    ["ENOENT", "not_found"],
    ["EACCES", "invalid_path"],
    ["ELOOP", "invalid_path"],
    ["ENOSPC", "invalid_path"],
  ])("classifies expected filesystem error %s as a user failure", (code, expectedCode) => {
    const error = Object.assign(new Error(`filesystem ${code}`), { code });
    const transformed = toWorkspaceFileIpcError(error);

    expect(transformed).toBeInstanceOf(WorkspaceFileUserError);
    expect(transformed).toMatchObject({ code: expectedCode });
  });

  test("reads path-scoped text, sampled metadata, binary bytes, and content MIME", async () => {
    const root = await makeTempWorkspace();
    const textPath = join(root, "notes.md");
    const binaryPath = join(root, "image.bin");
    await writeFile(textPath, "# Notes\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));

    const text = await readWorkspaceFile({ path: textPath, maxBytes: 100 });
    const textMetadata = await readWorkspaceFileMetadata({
      path: textPath,
      contentSampleByteLimit: 8_192,
      contentSampleMaxFileBytes: 100,
    });
    const skippedSample = await readWorkspaceFileMetadata({
      path: textPath,
      contentSampleByteLimit: 8_192,
      contentSampleMaxFileBytes: 1,
    });
    const binaryMetadata = await readWorkspaceFileMetadata({
      path: binaryPath,
      contentSampleByteLimit: 8_192,
    });
    const binary = await readWorkspaceFileBinary({ path: binaryPath });

    expect(text.contents).toBe("# Notes\n");
    expect(textMetadata.contentKind).toBe("text");
    expect(textMetadata.isFile).toBe(true);
    expect(textMetadata.sizeBytes).toBe(8);
    expect(skippedSample.contentKind).toBeUndefined();
    expect(binaryMetadata.contentKind).toBe("binary");
    expect(binaryMetadata.mimeType).toBe("image/png");
    expect(binary).toEqual({
      contentsBase64: "iVBORw0KGgoA",
      mimeType: "image/png",
    });
    await expect(readWorkspaceFile({ path: textPath, maxBytes: 7 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  test("uses modification time compare-and-swap and does not create missing parents", async () => {
    const root = await makeTempWorkspace();
    const filePath = join(root, "file.txt");
    await writeFile(filePath, "first", "utf8");
    const initialMtimeMs = (await stat(filePath)).mtimeMs;
    const future = new Date(Date.now() + 10_000);
    await writeFile(filePath, "second", "utf8");
    await utimes(filePath, future, future);
    const currentMtimeMs = (await stat(filePath)).mtimeMs;

    const conflict = await writeWorkspaceFile({
      path: filePath,
      content: "stale",
      expectedMtimeMs: initialMtimeMs,
    });
    const saved = await writeWorkspaceFile({
      path: filePath,
      content: "saved",
      expectedMtimeMs: currentMtimeMs,
    });

    expect(conflict).toEqual({ outcome: "conflict", mtimeMs: currentMtimeMs });
    expect(saved.outcome).toBe("saved");
    expect(await readFile(filePath, "utf8")).toBe("saved");
    await expect(
      writeWorkspaceFile({
        path: join(root, "missing", "file.txt"),
        content: "no implicit mkdir",
        expectedMtimeMs: null,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates a missing file only with a null modification-time expectation", async () => {
    const root = await makeTempWorkspace();
    const filePath = join(root, "new.txt");

    const conflict = await writeWorkspaceFile({
      path: filePath,
      content: "blocked",
      expectedMtimeMs: 1,
    });
    const saved = await writeWorkspaceFile({
      path: filePath,
      content: "created",
      expectedMtimeMs: null,
    });

    expect(conflict).toEqual({ outcome: "conflict", mtimeMs: null });
    expect(saved.outcome).toBe("saved");
    expect(await readFile(filePath, "utf8")).toBe("created");
  });
});
