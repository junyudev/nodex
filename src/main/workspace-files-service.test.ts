import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  listWorkspaceDirectoryEntries,
  readWorkspaceFile,
  readWorkspaceFileBinary,
  readWorkspaceFileMetadata,
  saveWorkspaceFileCopy,
  saveWorkspaceFileDataCopy,
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

test("native data saves preserve bytes and cancellation never writes", async () => {
  const root = await makeTempWorkspace();
  const destination = join(root, "saved.bin");
  const bytes = Buffer.from([0, 255, 128, 3]);
  const input = { fileName: "a/b.bin", contentsBase64: bytes.toString("base64") };
  expect(await saveWorkspaceFileDataCopy(input, async () => null)).toEqual({ path: null });
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await saveWorkspaceFileDataCopy(input, async (name) => {
      expect(name).toBe("a_b.bin");
      return destination;
    }),
  ).toEqual({ path: destination });
  expect(await readFile(destination)).toEqual(bytes);
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
  test("preserves exact root and directory names with trailing spaces", async () => {
    const parent = await makeTempWorkspace();
    const root = join(parent, "root ");
    await mkdir(join(root, "nested "), { recursive: true });
    await mkdir(join(root, "nested ", "child"));
    const result = await listWorkspaceDirectoryEntries({
      workspaceRoot: root,
      directoryPath: "nested ",
    });
    expect(result.directoryPath).toBe("nested ");
    expect(result.entries.map((entry) => entry.path)).toEqual(["nested /child"]);
  });
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

describe("workspace-files-service exact file resources", () => {
  test("preserves an exact trailing-space filename across reads and rejects relative paths", async () => {
    const root = await makeTempWorkspace();
    const plain = join(root, "report");
    const exact = `${plain} `;
    await writeFile(plain, "neighbour");
    await writeFile(exact, "exact");
    expect(await readWorkspaceFile({ path: exact, maxBytes: 100 })).toEqual({ contents: "exact" });
    expect((await readWorkspaceFileMetadata({ path: exact })).sizeBytes).toBe(5);
    expect((await readWorkspaceFileBinary({ path: exact })).contentsBase64).toBe(
      Buffer.from("exact").toString("base64"),
    );
    await expect(readWorkspaceFile({ path: "report", maxBytes: 100 })).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(await readFile(plain, "utf8")).toBe("neighbour");
  });

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
    await writeFile(
      binaryPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

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
    expect(binaryMetadata.contentKind).toBe("image");
    expect(binaryMetadata.mimeType).toBe("image/png");
    expect(binary).toEqual({
      contentsBase64: (await readFile(binaryPath)).toString("base64"),
      contentKind: "image",
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

test("wide directories retain every entry and natural folder-first ordering across batches", async () => {
  const root = await makeTempWorkspace();
  for (let start = 0; start < 600; start += 30) {
    await Promise.all(
      Array.from({ length: 30 }, (_, offset) =>
        writeFile(join(root, `file-${start + offset}.txt`), ""),
      ),
    );
  }
  await mkdir(join(root, "folder-10"));
  await mkdir(join(root, "folder-2"));
  const result = await listWorkspaceDirectoryEntries({ workspaceRoot: root });
  expect(result.entries.map((entry) => entry.name)).toEqual([
    "folder-2",
    "folder-10",
    ...Array.from({ length: 600 }, (_, index) => `file-${index}.txt`),
  ]);
});

test("binary reads accept the exact limit, reject overflows, and preserve empty files", async () => {
  const root = await makeTempWorkspace();
  const file = join(root, "sample.bin");
  await writeFile(file, Buffer.from([1, 2, 3, 4]));
  expect(await readWorkspaceFileBinary({ path: file, maxBytes: 4 })).toMatchObject({
    contentsBase64: "AQIDBA==",
    contentKind: "binary",
  });
  await expect(readWorkspaceFileBinary({ path: file, maxBytes: 3 })).rejects.toMatchObject({
    code: "too_large",
  });
  await writeFile(file, "");
  expect(await readWorkspaceFileBinary({ path: file, maxBytes: 1 })).toEqual({
    contentsBase64: "",
    contentKind: "text",
  });
});

test("local save-copy handles media larger than the preview limits without a base64 read", async () => {
  const root = await makeTempWorkspace();
  const file = join(root, "large.webm");
  const destination = join(root, "copy.webm");
  const handle = await open(file, "w");
  try {
    await handle.truncate(256 * 1024 * 1024 + 1);
    await handle.write(Buffer.from("media-tail"), 0, 10, 256 * 1024 * 1024 - 9);
  } finally {
    await handle.close();
  }
  await expect(readWorkspaceFileBinary({ path: file })).rejects.toMatchObject({
    code: "too_large",
  });
  await saveWorkspaceFileCopy({ path: file }, async () => destination);
  expect((await stat(destination)).size).toBe(256 * 1024 * 1024 + 1);
  const copy = await open(destination, "r");
  try {
    const buffer = Buffer.alloc(10);
    await copy.read(buffer, 0, 10, 256 * 1024 * 1024 - 9);
    expect(buffer.toString()).toBe("media-tail");
  } finally {
    await copy.close();
  }
});

test("local metadata and binary reads identify video independently of filenames", async () => {
  const root = await makeTempWorkspace();
  const file = join(root, "media.bin");
  const bytes = await readFile(resolve("tests/fixtures/workspace-media/vp9-opus.webm"));
  await writeFile(file, bytes);
  expect(await readWorkspaceFileMetadata({ path: file })).toMatchObject({
    contentKind: "video",
    mimeType: "video/webm",
    sizeBytes: bytes.length,
  });
  expect(await readWorkspaceFileBinary({ path: file, maxBytes: bytes.length })).toEqual({
    contentKind: "video",
    mimeType: "video/webm",
    contentsBase64: bytes.toString("base64"),
  });
});
