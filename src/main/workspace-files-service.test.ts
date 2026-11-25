import { describe, afterEach, expect, test, vi } from "vite-plus/test";
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
import * as path from "node:path";
import pathfilewatchhost from "node:path";
import { join, resolve } from "node:path";
import * as os from "node:os";
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
import { describeWorkspaceFileBytes } from "./workspace-file-content";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ClipboardOperationError } from "./platform/electron/ElectronClipboard";
import { writeImageToClipboard } from "./clipboard-image-writer";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import {
  CLIPBOARD_INSPECTION_MAX_ITEMS,
  CLIPBOARD_INSPECTION_MAX_LINES,
  CLIPBOARD_INSPECTION_MAX_PATH_LENGTH,
  inspectClipboardPasteItemsFromStrings,
  readClipboardPastePayload,
  truncateClipboardUtf8,
} from "./clipboard-paste-inspector";
import {
  attachNodexClipboardEnvelope,
  attachNodexClipboardFragment,
  attachNodexClipboardWriteClaim,
  attachNodexStructuralClipboardWriteClaim,
} from "../shared/clipboard-paste";
import { EventEmitter } from "node:events";
import type { DownloadItem, Session, WebContents, WebContentsView } from "electron";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { WebContentsDestructionSubscriptions } from "./platform/electron/WebContentsDestructionSubscriptions";
import { startNativeLinkDownload } from "./native-link-download";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { NodeFileWatchHost, type NativeFileWatchFactory } from "./file-watch-host";
import {
  COMPOSER_PICKED_IMAGE_MAX_BYTES,
  prepareComposerPickedFile,
} from "./composer-picked-files";

describe("workspace-files-service", () => {
  describe("workspace-files-service", () => {
    const tempRoots: string[] = [];

    async function makeTempWorkspace(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "nodex-workspace-files-"));
      tempRoots.push(root);
      return root;
    }

    afterEach(async () => {
      await Promise.all(
        tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
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
      await writeFile(destination, "previous contents");
      expect(
        await saveWorkspaceFileCopy({ path: source }, async (name) => {
          expect(name).toBe("source.bin");
          return destination;
        }),
      ).toEqual({ path: destination });
      expect(await readFile(destination)).toEqual(bytes);
      expect(await saveWorkspaceFileCopy({ path: source }, async () => null)).toEqual({
        path: null,
      });
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
        expect(await readWorkspaceFile({ path: exact, maxBytes: 100 })).toEqual({
          contents: "exact",
        });
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
  });

  describe("workspace-file-content", () => {
    describe("workspace content sniffing", () => {
      test.each([
        ["vp9-opus.webm", "video", "video/webm"],
        ["vp8-vorbis.webm", "video", "video/webm"],
        ["h264-aac.mp4", "video", "video/mp4"],
      ])("identifies %s from a bounded sample", async (name, contentKind, mimeType) => {
        const bytes = await readFile(`tests/fixtures/workspace-media/${name}`);
        expect(await describeWorkspaceFileBytes(bytes.subarray(0, 4096))).toEqual({
          contentKind,
          mimeType,
        });
      });

      test.each([
        [Buffer.from(""), { contentKind: "text" }],
        [Buffer.from("hello\n\tworld"), { contentKind: "text" }],
        [Buffer.from([7, 8, 9, 10, 11, 12, 13, 14]), { contentKind: "text" }],
        [Buffer.from("many printable characters followed by\u0001"), { contentKind: "binary" }],
        [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), { contentKind: "binary" }],
        [
          Buffer.from(" \n<SVG viewBox='0 0 1 1'/>"),
          { contentKind: "image", mimeType: "image/svg+xml" },
        ],
        [
          Buffer.from("<?xml version='1.0'?><SVG/>"),
          { contentKind: "image", mimeType: "image/svg+xml" },
        ],
        [Buffer.from("%PDF-1.7\n"), { contentKind: "pdf", mimeType: "application/pdf" }],
        [Buffer.from("{\\rtf1 text}"), { contentKind: "text", mimeType: "application/rtf" }],
        [
          Buffer.from([0x50, 0x4b, 5, 6, ...new Array<number>(18).fill(0)]),
          { contentKind: "archive", mimeType: "application/zip" },
        ],
        [Buffer.from("RIFF0000WAVE"), { contentKind: "audio", mimeType: "audio/wav" }],
      ])("classifies sample %# without relying on an extension", async (bytes, expected) => {
        expect(await describeWorkspaceFileBytes(bytes)).toEqual(expected);
      });
    });
  });
});

describe("clipboard-image-writer", () => {
  describe("clipboard-image-writer", () => {
    class FakeImage {
      constructor(private readonly empty: boolean) {}

      isEmpty(): boolean {
        return this.empty;
      }
    }

    const imagePlatform = (writeCalls: FakeImage[], empty = false) => ({
      createImageFromBuffer: () => new FakeImage(empty) as never,
      createImageFromDataUrl: () => new FakeImage(empty) as never,
      writeImage: (image: unknown) =>
        Effect.sync(() => {
          writeCalls.push(image as FakeImage);
        }),
    });

    describe("clipboard image writer", () => {
      it.effect("reports an asynchronous native write rejection as a controlled failure", () =>
        Effect.gen(function* () {
          const result = yield* writeImageToClipboard(
            "data:image/png;base64,aGVsbG8=",
            {
              ...imagePlatform([]),
              writeImage: () =>
                Effect.fail(new ClipboardOperationError({ reason: "write_failed" })),
            },
            { resolveAssetPath: (name) => name },
          );
          expect(result).toEqual({ ok: false, message: "Could not copy image." });
        }),
      );
      it.effect("writes asset-backed image bytes to the native clipboard", () =>
        Effect.gen(function* () {
          const writeCalls: FakeImage[] = [];
          const result = yield* writeImageToClipboard(
            "nodex://assets/diagram.png",
            imagePlatform(writeCalls),
            {
              resolveAssetPath: (fileName) => `/tmp/${fileName}`,
              readFile: async (filePath) => Buffer.from(filePath),
            },
          );

          expect(result.ok).toBe(true);
          expect(writeCalls.length).toBe(1);
        }),
      );

      it.effect("writes absolute local file images to the native clipboard", () =>
        Effect.gen(function* () {
          const writeCalls: FakeImage[] = [];
          const result = yield* writeImageToClipboard(
            "/Users/me/image.png",
            imagePlatform(writeCalls),
            {
              readFile: async (filePath) => Buffer.from(filePath),
              resolveAssetPath: (fileName) => fileName,
            },
          );

          expect(result.ok).toBe(true);
          expect(writeCalls.length).toBe(1);
        }),
      );

      it.effect("fetches remote images and writes the decoded native image", () =>
        Effect.gen(function* () {
          const writeCalls: FakeImage[] = [];
          const result = yield* writeImageToClipboard(
            "https://example.com/hero.png",
            imagePlatform(writeCalls),
            {
              fetchImpl: async () =>
                ({
                  ok: true,
                  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
                }) as Response,
              readFile: async () => Buffer.from("unused"),
              resolveAssetPath: (fileName) => fileName,
            },
          );

          expect(result.ok).toBe(true);
          expect(writeCalls.length).toBe(1);
        }),
      );

      it.effect("returns a decode error when the image format cannot be converted", () =>
        Effect.gen(function* () {
          const writeCalls: FakeImage[] = [];
          const result = yield* writeImageToClipboard(
            "https://example.com/file.bin",
            imagePlatform(writeCalls, true),
            {
              fetchImpl: async () =>
                ({
                  ok: true,
                  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
                }) as Response,
              readFile: async () => Buffer.from("unused"),
              resolveAssetPath: (fileName) => fileName,
            },
          );

          expect(result.ok).toBe(false);
          expect("message" in result ? result.message : "").toBe(
            "Could not decode this image format for clipboard copy.",
          );
          expect(writeCalls.length).toBe(0);
        }),
      );

      it.effect("returns a copy failure for invalid image sources", () =>
        Effect.gen(function* () {
          const result = yield* writeImageToClipboard("relative/image.png", imagePlatform([]), {
            readFile: async () => Buffer.from("unused"),
            fetchImpl: async () =>
              ({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1]).buffer,
              }) as Response,
            resolveAssetPath: (fileName) => fileName,
          });

          expect(result.ok).toBe(false);
          expect("message" in result ? result.message : "").toBe("Could not copy image.");
        }),
      );
    });
  });

  describe("clipboard-paste-inspector", () => {
    const writeClaim = "0199134e-cbb0-7000-8000-000000000005";

    describe("clipboard paste inspector", () => {
      test("recovers the editor fragment when native reads cannot access Chromium custom MIME data", () => {
        const blocknoteHtml = '<div data-pm-slice="0 0 -1 []"><p>Nested fragment</p></div>';
        const payload = readClipboardPastePayload({
          generation: 1,
          fileUrls: [],
          html: attachNodexClipboardWriteClaim(
            attachNodexClipboardFragment("<p>Portable presentation</p>", blocknoteHtml),
            writeClaim,
          ),
          text: "Portable text",
        });
        expect(payload.blocknoteHtml).toBe(blocknoteHtml);
        expect(payload.html).toContain("<div><p>Portable presentation</p></div>");
        expect(payload.text).toBe("Portable text");
        expect(payload.structuralEnvelope).toBeUndefined();
        expect(payload.structuralWriteClaim).toBeUndefined();
      });
      test("collects unique pasted file and folder paths from text payloads", () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-clipboard-inspect-"));
        const filePath = path.join(fixtureRoot, "notes.txt");
        const folderPath = path.join(fixtureRoot, "folder");
        fs.writeFileSync(filePath, "hello");
        fs.mkdirSync(folderPath, { recursive: true });

        const result = inspectClipboardPasteItemsFromStrings([
          `${pathToFileURL(filePath).href}\n${folderPath}`,
          `${filePath}\n${filePath}`,
          "# comment\nmissing.txt",
        ]);

        expect(result.items.length).toBe(2);
        expect(result.items[0]?.path).toBe(filePath);
        expect(result.items[0]?.kind).toBe("file");
        expect(result.items[0]?.bytes).toBe(5);
        expect(result.items[1]?.path).toBe(folderPath);
        expect(result.items[1]?.kind).toBe("folder");
      });

      test("ignores non-absolute and missing clipboard entries", () => {
        const result = inspectClipboardPasteItemsFromStrings([
          "relative/path.txt",
          "",
          "https://example.com/file.txt",
        ]);

        expect(result.items.length).toBe(0);
      });

      test("enforces item, line, path, and symlink budgets", () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-clipboard-budget-"));
        const paths = Array.from({ length: CLIPBOARD_INSPECTION_MAX_ITEMS + 4 }, (_, index) =>
          path.join(fixtureRoot, `item-${index}.txt`),
        );
        for (const filePath of paths) fs.writeFileSync(filePath, "x");
        const symlinkPath = path.join(fixtureRoot, "symlink.txt");
        fs.symlinkSync(paths[0] ?? "", symlinkPath);
        const excessivePath = `/${"x".repeat(CLIPBOARD_INSPECTION_MAX_PATH_LENGTH + 1)}`;
        const extraLines = Array.from(
          { length: CLIPBOARD_INSPECTION_MAX_LINES + 4 },
          () => paths[0],
        );

        const result = inspectClipboardPasteItemsFromStrings([
          [symlinkPath, excessivePath, ...paths, ...extraLines].join("\n"),
        ]);

        expect(result.items).toHaveLength(CLIPBOARD_INSPECTION_MAX_ITEMS);
        expect(result.items.some((item) => item.path === symlinkPath)).toBe(false);
      });

      test("truncates payloads at a valid UTF-8 boundary without exceeding the budget", () => {
        const truncated = truncateClipboardUtf8("A日B", 3);

        expect(truncated).toBe("A");
        expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(3);
        expect(truncated).not.toContain("�");
      });

      test("returns a verified structural candidate separately from marker-free fallback HTML", () => {
        const structuralEnvelope = {
          version: 1,
          profileId: "profile-1",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          bundleId: "bundle-1",
          capability: "a".repeat(64),
          manifestHash: "b".repeat(64),
          actionHint: "copy",
        } as const;
        const html = attachNodexClipboardEnvelope("<p>Fallback</p>", structuralEnvelope);

        const payload = readClipboardPastePayload({
          generation: 1,
          fileUrls: [],
          html,
          text: "Fallback",
        });

        expect(payload.structuralEnvelope).toEqual(structuralEnvelope);
        expect(payload.html).toContain("<p>Fallback</p>");
        expect(payload.html).not.toContain("nodex-clipboard-envelope-v1");
        expect(payload.text).toBe("Fallback");
      });

      test("exposes a pending structural write claim without promoting it to authority", () => {
        const html = attachNodexStructuralClipboardWriteClaim("<p>Fallback</p>", writeClaim);
        const target = {
          generation: 1,
          fileUrls: [],
          html,
          text: "Fallback",
        };

        const payload = readClipboardPastePayload(target);
        expect(payload.structuralWriteClaim).toBe(writeClaim);
        expect(payload.structuralEnvelope).toBeUndefined();
      });
    });

    test("recovers a structural private MIME claim without an HTML fallback", () => {
      const payload = readClipboardPastePayload({
        generation: 1,
        fileUrls: [],
        text: "Portable",
        structuralDescriptor: JSON.stringify({
          version: 1,
          phase: "preparing",
          writeClaim,
          actionHint: "copy",
        }),
      });
      expect(payload.structuralWriteClaim).toBe(writeClaim);
      expect(payload.text).toBe("Portable");
      expect(payload.structuralEnvelope).toBeUndefined();
    });
  });
});

describe("native-link-download", () => {
  function fixture(destruction: WebContentsDestructionSubscriptions["Service"]) {
    const session = new EventEmitter();
    const source = Object.assign(new EventEmitter(), {
      id: 7,
      session,
      isDestroyed: () => false,
    });
    const views: Array<{ webContents: ReturnType<typeof contents> }> = [];
    function contents() {
      let destroyed = false;
      return {
        id: views.length + 10,
        downloadURL: vi.fn(),
        isDestroyed: () => destroyed,
        close: vi.fn(() => {
          destroyed = true;
        }),
      };
    }
    let current = true;
    const options = {
      url: "https://example.test/download?id=1#section",
      destruction,
      source: source as unknown as WebContents,
      isCurrent: () => current,
      createView: vi.fn((_session: Session) => {
        const view = { webContents: contents() };
        views.push(view);
        return view as unknown as WebContentsView;
      }),
    };
    const item = () =>
      Object.assign(new EventEmitter(), {
        getFilename: () => "server report.pdf",
        getURLChain: () => ["https://example.test/download?id=1", "https://cdn.example.test/file"],
        setSaveDialogOptions: vi.fn(),
      });
    const emit = (download: ReturnType<typeof item>, id: number) => {
      const event = { preventDefault: vi.fn() };
      session.emit("will-download", event, download as unknown as DownloadItem, { id });
      return event;
    };
    return {
      options,
      session,
      source,
      views,
      item,
      emit,
      retire: () => {
        current = false;
      },
    };
  }

  it.layer(WebContentsDestructionSubscriptions.live)("Native link downloads", (it) => {
    it.effect("keeps redirects and server filenames in Chromium's streaming Save As flow", () =>
      Effect.gen(function* () {
        const test = fixture(yield* WebContentsDestructionSubscriptions);
        const pending = yield* Effect.forkChild(startNativeLinkDownload(test.options));
        yield* Effect.yieldNow;
        const view = test.views[0]!;
        assert.strictEqual(test.options.createView.mock.calls[0]?.[0], test.session);
        assert.deepStrictEqual(view.webContents.downloadURL.mock.calls[0], [
          "https://example.test/download?id=1",
        ]);
        const item = test.item();
        const unrelated = test.emit(item, 99);
        assert.strictEqual(unrelated.preventDefault.mock.calls.length, 0);
        assert.strictEqual(item.setSaveDialogOptions.mock.calls.length, 0);
        test.emit(item, view.webContents.id);
        assert.strictEqual(yield* Fiber.join(pending), true);
        assert.deepStrictEqual(item.setSaveDialogOptions.mock.calls[0], [
          { defaultPath: "server report.pdf" },
        ]);
        assert.strictEqual(test.session.listenerCount("will-download"), 0);
        assert.strictEqual(test.source.listenerCount("destroyed"), 0);
        assert.strictEqual(view.webContents.close.mock.calls.length, 0);
        item.emit("done", {}, "cancelled");
        yield* Effect.promise(() => Promise.resolve());
        assert.strictEqual(view.webContents.close.mock.calls.length, 1);
      }),
    );

    it.effect("isolates concurrent downloads of the same URL by their private sender", () =>
      Effect.gen(function* () {
        const test = fixture(yield* WebContentsDestructionSubscriptions);
        const first = yield* Effect.forkChild(startNativeLinkDownload(test.options));
        const second = yield* Effect.forkChild(startNativeLinkDownload(test.options));
        yield* Effect.yieldNow;
        const firstItem = test.item();
        const secondItem = test.item();
        test.emit(firstItem, test.views[0]!.webContents.id);
        test.emit(secondItem, test.views[1]!.webContents.id);
        assert.strictEqual(yield* Fiber.join(first), true);
        assert.strictEqual(yield* Fiber.join(second), true);
        assert.strictEqual(firstItem.setSaveDialogOptions.mock.calls.length, 1);
        assert.strictEqual(secondItem.setSaveDialogOptions.mock.calls.length, 1);
        firstItem.emit("done", {}, "completed");
        secondItem.emit("done", {}, "interrupted");
        yield* Effect.promise(() => Promise.resolve());
        assert.isTrue(test.views.every((view) => view.webContents.isDestroyed()));
      }),
    );

    it.effect("cancels a pending start when its source closes or retires", () =>
      Effect.gen(function* () {
        const closed = fixture(yield* WebContentsDestructionSubscriptions);
        const closing = yield* Effect.forkChild(startNativeLinkDownload(closed.options));
        yield* Effect.yieldNow;
        closed.source.emit("destroyed");
        assert.strictEqual(yield* Fiber.join(closing), false);
        assert.isTrue(closed.views[0]!.webContents.isDestroyed());
        assert.strictEqual(closed.session.listenerCount("will-download"), 0);
        const retired = fixture(yield* WebContentsDestructionSubscriptions);
        const retiring = yield* Effect.forkChild(startNativeLinkDownload(retired.options));
        yield* Effect.yieldNow;
        retired.retire();
        const event = retired.emit(retired.item(), retired.views[0]!.webContents.id);
        assert.strictEqual(yield* Fiber.join(retiring), false);
        assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        assert.isTrue(retired.views[0]!.webContents.isDestroyed());
      }),
    );

    it.effect("cleans the private sender and listeners when a download never starts", () =>
      Effect.gen(function* () {
        const test = fixture(yield* WebContentsDestructionSubscriptions);
        const pending = yield* Effect.forkChild(startNativeLinkDownload(test.options));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* Fiber.join(pending), false);
        assert.isTrue(test.views[0]!.webContents.isDestroyed());
        assert.strictEqual(test.session.listenerCount("will-download"), 0);
        assert.strictEqual(test.source.listenerCount("destroyed"), 0);
      }),
    );
  });
});

describe("file-watch-host", () => {
  const path = pathfilewatchhost;
  class FakeNativeWatcher extends EventEmitter {
    readonly close = vi.fn();
  }

  function createHarness() {
    const watcher = new FakeNativeWatcher();
    let listener: Parameters<NativeFileWatchFactory>[2] | null = null;
    const watchFactory = vi.fn<NativeFileWatchFactory>((_watchPath, _options, nextListener) => {
      listener = nextListener;
      return watcher;
    });
    return {
      host: new NodeFileWatchHost(watchFactory),
      listener: () => {
        if (listener === null) throw new Error("Watcher listener was not set.");
        return listener;
      },
      watcher,
      watchFactory,
    };
  }

  const awaitStarted = (harness: ReturnType<typeof createHarness>) =>
    Effect.gen(function* () {
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Wait for the fake native watcher to be acquired before sending a change.
      while (harness.watchFactory.mock.calls.length === 0) yield* Effect.yieldNow;
    });

  describe("NodeFileWatchHost", () => {
    it.effect("streams normalized changes and releases the native watcher", () =>
      Effect.gen(function* () {
        const harness = createHarness();
        const eventsFiber = yield* harness.host
          .watch({
            path: path.join(path.sep, "repo"),
            recursive: true,
            renameEventHandling: "changed-path-with-parent-directory",
          })
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
        yield* awaitStarted(harness);

        harness.listener()("change", "src/example.ts");
        harness.listener()("rename", Buffer.from("src/renamed.ts"));
        harness.listener()("change", null);
        const events = yield* Fiber.join(eventsFiber);

        expect(harness.watchFactory).toHaveBeenCalledWith(
          path.join(path.sep, "repo"),
          { recursive: true },
          expect.any(Function),
        );
        expect(events).toEqual([
          {
            _tag: "Ready",
            coverage: { recursive: true, typedPathChanges: false },
            path: path.join(path.sep, "repo"),
          },
          { _tag: "Changed", changedPaths: [path.join(path.sep, "repo", "src", "example.ts")] },
          {
            _tag: "Changed",
            changedPaths: [
              path.join(path.sep, "repo", "src", "renamed.ts"),
              path.join(path.sep, "repo", "src"),
            ],
          },
          { _tag: "Changed", changedPaths: [] },
        ]);
        expect(harness.watcher.close).toHaveBeenCalledTimes(1);
      }),
    );

    it.effect("reports native failure and closes once through the stream Scope", () =>
      Effect.gen(function* () {
        const errorHarness = createHarness();
        const failureFiber = yield* errorHarness.host
          .watch({
            path: path.join(path.sep, "repo"),
            recursive: false,
            renameEventHandling: "changed-path",
          })
          .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);
        yield* awaitStarted(errorHarness);
        const cause = new Error("watch failed");
        errorHarness.watcher.emit("error", cause);

        expect(yield* Fiber.join(failureFiber)).toMatchObject({
          _tag: "FileWatchError",
          path: path.join(path.sep, "repo"),
          cause,
        });
        expect(errorHarness.watcher.close).toHaveBeenCalledTimes(1);

        const acquisitionCause = new Error("watch unavailable");
        const unavailableHost = new NodeFileWatchHost(() => {
          throw acquisitionCause;
        });
        expect(
          yield* unavailableHost
            .watch({
              path: path.join(path.sep, "missing"),
              recursive: false,
              renameEventHandling: "changed-path",
            })
            .pipe(Stream.runDrain, Effect.flip),
        ).toMatchObject({
          _tag: "FileWatchError",
          path: path.join(path.sep, "missing"),
          cause: acquisitionCause,
        });

        const scopedHarness = createHarness();
        const parentScope = yield* Scope.Scope;
        const watchScope = yield* Scope.fork(parentScope);
        yield* scopedHarness.host
          .watch({
            path: path.join(path.sep, "repo"),
            recursive: false,
            renameEventHandling: "changed-path",
          })
          .pipe(Stream.runDrain, Effect.forkScoped, Scope.provide(watchScope));
        yield* awaitStarted(scopedHarness);
        yield* Scope.close(watchScope, Exit.void);

        expect(scopedHarness.watcher.close).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

describe("composer-picked-files", () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nodex-composer-picked-files-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    const dirs = tempDirs.splice(0);
    await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })));
  });

  describe("composer picked files", () => {
    test("embeds image bytes only for selected image files", async () => {
      const dir = await createTempDir();
      const imagePath = path.join(dir, "diagram.png");
      await writeFile(imagePath, Buffer.from("image"));

      const pickedFile = await prepareComposerPickedFile(imagePath);

      expect(pickedFile.label).toBe("diagram.png");
      expect(pickedFile.path).toBe(imagePath);
      expect(pickedFile.bytes).toBe(5);
      expect(pickedFile.mimeType).toBe("image/png");
      expect(pickedFile.imageDataUrl).toBe("data:image/png;base64,aW1hZ2U=");
    });

    test("does not embed bytes for non-image files", async () => {
      const dir = await createTempDir();
      const textPath = path.join(dir, "notes.md");
      await writeFile(textPath, Buffer.from("# notes\n"));

      const pickedFile = await prepareComposerPickedFile(textPath);

      expect(pickedFile.label).toBe("notes.md");
      expect(pickedFile.path).toBe(textPath);
      expect("bytes" in pickedFile).toBe(false);
      expect("mimeType" in pickedFile).toBe(false);
      expect("imageDataUrl" in pickedFile).toBe(false);
    });

    test("does not treat unsupported image formats as Composer images", async () => {
      const dir = await createTempDir();
      const imagePath = path.join(dir, "legacy.bmp");
      await writeFile(imagePath, Buffer.from("image"));

      const pickedFile = await prepareComposerPickedFile(imagePath);

      expect(pickedFile.label).toBe("legacy.bmp");
      expect("mimeType" in pickedFile).toBe(false);
      expect("imageDataUrl" in pickedFile).toBe(false);
    });

    test("does not attach empty image files", async () => {
      const dir = await createTempDir();
      const imagePath = path.join(dir, "empty.png");
      await writeFile(imagePath, Buffer.alloc(0));

      const pickedFile = await prepareComposerPickedFile(imagePath);

      expect(pickedFile.label).toBe("empty.png");
      expect("mimeType" in pickedFile).toBe(false);
      expect("imageDataUrl" in pickedFile).toBe(false);
    });

    test("does not embed bytes for oversized images", async () => {
      const dir = await createTempDir();
      const imagePath = path.join(dir, "huge.png");
      await writeFile(imagePath, Buffer.alloc(COMPOSER_PICKED_IMAGE_MAX_BYTES + 1));

      const pickedFile = await prepareComposerPickedFile(imagePath);

      expect(pickedFile.label).toBe("huge.png");
      expect("bytes" in pickedFile).toBe(false);
      expect("imageDataUrl" in pickedFile).toBe(false);
    });

    test("does not embed bytes for directories with image-like names", async () => {
      const dir = await createTempDir();
      const directoryPath = path.join(dir, "folder.png");
      await mkdir(directoryPath);

      const pickedFile = await prepareComposerPickedFile(directoryPath);

      expect(pickedFile.label).toBe("folder.png");
      expect("bytes" in pickedFile).toBe(false);
      expect("imageDataUrl" in pickedFile).toBe(false);
    });
  });
});
