import { describe, expect, test, vi } from "vite-plus/test";
import { formatDisplayPath } from "./display-path";
import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import {
  isFileSourceReferenceChangeForDocument,
  pageFileReferenceInvalidationsForDocument,
  pageFileReadInvalidationsFromChange,
} from "./file-read-authority";
import type { LibraryFilePresentation } from "../../shared/library-files";
import type { FileBytes } from "../../shared/file-resources";
import { EMPTY_FILE_READ_SNAPSHOT, FileReadCache } from "./file-read-cache";
import type { FileReadAuthority } from "./library-file-resources";
import type { FuzzyFileSearchResult } from "@nodex/codex-app-server-protocol";
import { projectFileSearchResults } from "./file-search-results";
import {
  applyFileTreeExpansion,
  buildFileTreeInput,
  diffFileTreePaths,
  withFileTreeFolders,
  type FileTreeFolderHandle,
} from "./file-tree-paths";
import { readExactWorkspaceTextFile } from "./read-exact-workspace-text-file";
import {
  buildWorkspaceFileEditorSelection,
  buildWorkspaceFileLineSelection,
  buildWorkspaceFileScrollTarget,
  resolveWorkspaceFileRevealRange,
} from "./workspace-file-reveal";
import { resolveWorkspaceSearchContext } from "./workspace-search-context";

describe("formatDisplayPath", () => {
  test("spells paths from the working directory, then from home, then absolutely", () => {
    const cwd = "/Users/ada/repo/nodex";
    expect(formatDisplayPath(cwd, cwd)).toBe(".");
    expect(formatDisplayPath(`${cwd}/src/app.ts`, `${cwd}/`)).toBe("./src/app.ts");
    expect(formatDisplayPath("/Users/ada/Desktop/a.pdf", cwd)).toBe("~/Desktop/a.pdf");
    expect(formatDisplayPath("/Users/ada", cwd)).toBe("~");
    expect(formatDisplayPath("/tmp/out/", cwd)).toBe("/tmp/out");
    expect(formatDisplayPath("/", cwd)).toBe("/");
  });

  test("does not treat a sibling with a shared prefix as inside the working directory", () => {
    expect(formatDisplayPath("/Users/ada/repo/nodex-2/a.md", "/Users/ada/repo/nodex")).toBe(
      "~/repo/nodex-2/a.md",
    );
  });

  test("normalizes Windows separators and infers a Windows home", () => {
    expect(formatDisplayPath("C:\\Users\\ada\\docs\\a.md", "C:/Users/ada/work")).toBe(
      "~/docs/a.md",
    );
  });

  test("leaves paths absolute without a working directory", () => {
    expect(formatDisplayPath("/Users/ada/a.md", null)).toBe("/Users/ada/a.md");
  });
});

describe("file read authority", () => {
  type DeliveryAtom = AuthorizedDeliveryPacket["atoms"][number];

  const atom = (event: DeliveryAtom["payload"]): DeliveryAtom => ({
    descriptor: {
      atom_id: "atom:test",
      atom_order: 0,
      kind: "owned_document_changed",
      payload_hash: "a".repeat(64),
      required_resources: [],
    },
    payload: event,
  });

  describe("File read invalidation", () => {
    test("matches only the exact Document reference-change event", () => {
      const referenceChange = atom({
        module: "owned_document",
        library_id: "library:test",
        event: {
          kind: "page_file_references_changed",
          document_id: "document:target",
          generation: 2,
          head_seq: 9,
          change: { kind: "exact", added_file_ids: ["file-a"], removed_file_ids: [] },
        },
      });
      expect(isFileSourceReferenceChangeForDocument(referenceChange, "document:target")).toBe(true);
      expect(isFileSourceReferenceChangeForDocument(referenceChange, "document:other")).toBe(false);

      expect(
        isFileSourceReferenceChangeForDocument(
          atom({
            module: "owned_document",
            library_id: "library:test",
            event: {
              kind: "document_resync_required",
              document_id: "document:target",
              generation: 2,
              head_seq: 9,
              update_id: "update:test",
              update_hash: "a".repeat(64),
            },
          }),
          "document:target",
        ),
      ).toBe(false);
      expect(
        isFileSourceReferenceChangeForDocument(
          atom({
            module: "library",
            library_id: "library:test",
            event: {
              kind: "library_changed",
              page_ids: [],
              database_ids: [],
              view_ids: [],
              parent_keys: [],
              file_revisions: {},
              page_file_manifest_invalidations: {},
              page_file_body_usage_revisions: {},
              page_file_content_invalidations: {},
            },
          }),
          "document:target",
        ),
      ).toBe(false);
    });

    test("projects reset reference events as page-wide authority revocation", () => {
      const referenceChange = atom({
        module: "owned_document",
        library_id: "library:test",
        event: {
          kind: "page_file_references_changed",
          document_id: "document:target",
          generation: 2,
          head_seq: 9,
          change: { kind: "reset" },
        },
      });

      expect(pageFileReferenceInvalidationsForDocument(referenceChange, "document:target")).toEqual(
        [
          {
            mode: "revoke",
            fileIds: null,
            metadata: true,
            content: true,
          },
        ],
      );
    });

    test("separates newly readable and revoked File identities", () => {
      const referenceChange = atom({
        module: "owned_document",
        library_id: "library:test",
        event: {
          kind: "page_file_references_changed",
          document_id: "document:target",
          generation: 2,
          head_seq: 9,
          change: {
            kind: "exact",
            added_file_ids: ["file-a", "file-b"],
            removed_file_ids: ["file-c"],
          },
        },
      });

      expect(pageFileReferenceInvalidationsForDocument(referenceChange, "document:target")).toEqual(
        [
          {
            mode: "refresh",
            fileIds: ["file-a", "file-b"],
            metadata: true,
            content: true,
          },
          {
            mode: "revoke",
            fileIds: ["file-c"],
            metadata: true,
            content: true,
          },
        ],
      );
    });

    test("keeps metadata-only and content invalidations separate", () => {
      expect(
        pageFileReadInvalidationsFromChange({
          manifestRevision: 3,
          manifestFileIds: ["file-renamed"],
          bodyUsageRevision: null,
          contentRevision: 4,
          contentFileIds: ["file-replaced"],
        }),
      ).toEqual([
        {
          mode: "refresh",
          fileIds: ["file-renamed", "file-replaced"],
          metadata: true,
          content: false,
        },
        {
          mode: "refresh",
          fileIds: ["file-replaced"],
          metadata: false,
          content: true,
        },
      ]);
    });

    test("lets a content-only signal refresh both metadata and bytes", () => {
      expect(
        pageFileReadInvalidationsFromChange({
          manifestRevision: null,
          manifestFileIds: null,
          bodyUsageRevision: null,
          contentRevision: 4,
          contentFileIds: ["file-replaced"],
        }),
      ).toEqual([
        {
          mode: "refresh",
          fileIds: ["file-replaced"],
          metadata: true,
          content: true,
        },
      ]);
    });
  });
});

describe("file read cache", () => {
  const authority = {
    libraryId: "library-1",
    contentRoutingContext: { kind: "project", projectId: "project-1" } as const,
    readSource: { kind: "page", page_id: "page-1" } as const,
    storeEpoch: "store-1",
  };

  const metadata = (fileId: string, version = 1): LibraryFilePresentation => ({
    file_id: fileId,
    default_name: `${fileId}.png`,
    mime_type: "image/png",
    byte_length: version,
    version,
    blob_etag: `etag-${fileId}-${version}`,
  });

  const bytes = (fileId: string, version = 1): FileBytes => ({
    bytes: new TextEncoder().encode(`${fileId}:${version}`),
    mimeType: "image/png",
    etag: `etag-${fileId}-${version}`,
  });

  const deferred = <Value>() => {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    return { promise, resolve, reject };
  };

  describe("FileReadCache", () => {
    test("isolates current bytes, exact history, and fixed versions of the same File", async () => {
      const revoked: string[] = [];
      const readBytes = vi.fn(async (scope: FileReadAuthority, fileId: string) =>
        bytes(fileId, scope.readSource.kind === "page" ? 3 : (scope.version ?? 1)),
      );
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes,
        createObjectUrl: (value) => `blob:${value.etag}`,
        revokeObjectUrl: (url) => revoked.push(url),
      });
      const current = cache.acquire(authority);
      const historical = cache.acquire({
        ...authority,
        readSource: { kind: "document_revision", document_id: "doc", revision_id: "revision" },
      });
      const fixed = cache.acquire({ ...authority, readSource: { kind: "direct" }, version: 2 });
      for (const scope of [current, historical, fixed])
        scope.subscribe("file", { objectUrl: true }, () => undefined);
      expect(
        await Promise.all([current, historical, fixed].map((scope) => scope.readObjectUrl("file"))),
      ).toEqual(["blob:etag-file-3", "blob:etag-file-1", "blob:etag-file-2"]);
      expect(readBytes).toHaveBeenCalledTimes(3);
      current.release();
      expect(revoked).toEqual(["blob:etag-file-3"]);
      expect(historical.snapshot("file").objectUrl).toBe("blob:etag-file-1");
      historical.release();
      fixed.release();
      expect(revoked).toHaveLength(3);
    });

    test("deduplicates same-key metadata and content reads across scope leases", async () => {
      const metadataRead = deferred<LibraryFilePresentation>();
      const bytesRead = deferred<FileBytes>();
      const readMetadata = vi.fn(() => metadataRead.promise);
      const readBytes = vi.fn(() => bytesRead.promise);
      const cache = new FileReadCache({
        readMetadata,
        readBytes,
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: vi.fn(),
      });
      const first = cache.acquire(authority);
      const second = cache.acquire(authority);

      const metadataRequests = [first.readMetadata("file-a"), second.readMetadata("file-a")];
      const contentRequests = [first.readBytes("file-a"), second.readBytes("file-a")];
      expect(readMetadata).toHaveBeenCalledTimes(1);
      expect(readBytes).toHaveBeenCalledTimes(1);

      metadataRead.resolve(metadata("file-a"));
      bytesRead.resolve(bytes("file-a"));
      await expect(Promise.all(metadataRequests)).resolves.toHaveLength(2);
      await expect(Promise.all(contentRequests)).resolves.toHaveLength(2);

      first.release();
      second.release();
    });

    test("refreshes only exact File identities while retaining the old object URL", async () => {
      const refresh = deferred<FileBytes>();
      const versions = new Map([
        ["file-a", 1],
        ["file-b", 1],
      ]);
      const readBytes = vi.fn((_, fileId: string) => {
        if (fileId === "file-a" && versions.get(fileId) === 2) return refresh.promise;
        return Promise.resolve(bytes(fileId, versions.get(fileId)));
      });
      const revoked: string[] = [];
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId, versions.get(fileId)),
        readBytes,
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: (url) => revoked.push(url),
      });
      const scope = cache.acquire(authority);
      scope.subscribe("file-a", { objectUrl: true }, () => undefined);
      scope.subscribe("file-b", { objectUrl: true }, () => undefined);
      await Promise.all([scope.readObjectUrl("file-a"), scope.readObjectUrl("file-b")]);
      expect(scope.snapshot("file-a").objectUrl).toBe("blob:etag-file-a-1");

      versions.set("file-a", 2);
      scope.invalidate({
        mode: "refresh",
        fileIds: ["file-a"],
        metadata: false,
        content: true,
      });
      expect(scope.snapshot("file-a")).toMatchObject({
        objectUrl: "blob:etag-file-a-1",
        contentRefreshing: true,
      });
      expect(scope.snapshot("file-b")).toMatchObject({
        objectUrl: "blob:etag-file-b-1",
        contentRefreshing: false,
      });
      expect(readBytes).toHaveBeenCalledTimes(3);

      refresh.resolve(bytes("file-a", 2));
      await refresh.promise;
      await vi.waitFor(() => {
        expect(scope.snapshot("file-a").objectUrl).toBe("blob:etag-file-a-2");
      });
      expect(revoked).toEqual(["blob:etag-file-a-1"]);
      expect(readBytes.mock.calls.filter((call) => call[1] === "file-b")).toHaveLength(1);
      scope.release();
    });

    test("keeps stale presentation after a failed refresh and retries on demand", async () => {
      let version = 1;
      let failRefresh = true;
      const readBytes = vi.fn(async (_, fileId: string) => {
        if (version === 2 && failRefresh) throw new Error("offline");
        return bytes(fileId, version);
      });
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId, version),
        readBytes,
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: vi.fn(),
      });
      const scope = cache.acquire(authority);
      scope.subscribe("file-a", { objectUrl: true }, () => undefined);
      await scope.readObjectUrl("file-a");

      version = 2;
      scope.invalidate({
        mode: "refresh",
        fileIds: ["file-a"],
        metadata: false,
        content: true,
      });
      await vi.waitFor(() => expect(scope.snapshot("file-a").contentError).toBe("offline"));
      expect(scope.snapshot("file-a").objectUrl).toBe("blob:etag-file-a-1");

      failRefresh = false;
      await expect(scope.readObjectUrl("file-a")).resolves.toBe("blob:etag-file-a-1");
      await vi.waitFor(() => {
        expect(scope.snapshot("file-a").objectUrl).toBe("blob:etag-file-a-2");
      });
      scope.release();
    });

    test("retries an in-flight authorization failure after exact authority advances", async () => {
      const firstMetadata = deferred<LibraryFilePresentation>();
      const firstContent = deferred<FileBytes>();
      const readMetadata = vi
        .fn<(_scope: FileReadAuthority, fileId: string) => Promise<LibraryFilePresentation>>()
        .mockImplementationOnce(() => firstMetadata.promise)
        .mockImplementation(async (_, fileId) => metadata(fileId, 2));
      const readBytes = vi
        .fn<(_scope: FileReadAuthority, fileId: string) => Promise<FileBytes>>()
        .mockImplementationOnce(() => firstContent.promise)
        .mockImplementation(async (_, fileId) => bytes(fileId, 2));
      const cache = new FileReadCache({
        readMetadata,
        readBytes,
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: vi.fn(),
      });
      const scope = cache.acquire(authority);
      scope.subscribe(
        "file-a",
        { metadata: true, content: true, objectUrl: true },
        () => undefined,
      );
      const metadataRequest = scope.readMetadata("file-a");
      const objectUrlRequest = scope.readObjectUrl("file-a");

      scope.invalidate({
        mode: "refresh",
        fileIds: ["file-a"],
        metadata: true,
        content: true,
      });
      firstMetadata.reject(new Error("File is unavailable"));
      firstContent.reject(new Error("File is unavailable"));

      await expect(metadataRequest).resolves.toEqual(metadata("file-a", 2));
      await expect(objectUrlRequest).resolves.toBe("blob:etag-file-a-2");
      expect(readMetadata).toHaveBeenCalledTimes(2);
      expect(readBytes).toHaveBeenCalledTimes(2);
      expect(scope.snapshot("file-a")).toMatchObject({
        metadata: metadata("file-a", 2),
        bytes: bytes("file-a", 2),
        objectUrl: "blob:etag-file-a-2",
        metadataError: null,
        contentError: null,
      });
      scope.release();
    });

    test("does not retry a stable authorization failure without a new generation", async () => {
      const readMetadata = vi.fn(async () => {
        throw new Error("File is unavailable");
      });
      const readBytes = vi.fn(async () => {
        throw new Error("File is unavailable");
      });
      const cache = new FileReadCache({
        readMetadata,
        readBytes,
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: vi.fn(),
      });
      const scope = cache.acquire(authority);
      scope.subscribe("file-a", { metadata: true, content: true }, () => undefined);

      await expect(scope.readMetadata("file-a")).rejects.toThrow("File is unavailable");
      await expect(scope.readBytes("file-a")).rejects.toThrow("File is unavailable");
      await expect(scope.readMetadata("file-a")).rejects.toThrow("File is unavailable");
      await expect(scope.readBytes("file-a")).rejects.toThrow("File is unavailable");

      expect(readMetadata).toHaveBeenCalledTimes(1);
      expect(readBytes).toHaveBeenCalledTimes(1);
      scope.release();
    });

    test("creates one object URL when bytes were already cached", async () => {
      const createObjectUrl = vi.fn((file: FileBytes) => `blob:${file.etag}`);
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes: async (_, fileId) => bytes(fileId),
        createObjectUrl,
        revokeObjectUrl: vi.fn(),
      });
      const scope = cache.acquire(authority);
      scope.subscribe("file-a", { content: true }, () => undefined);
      await scope.readBytes("file-a");
      scope.subscribe("file-a", { objectUrl: true }, () => undefined);

      await expect(
        Promise.all([scope.readObjectUrl("file-a"), scope.readObjectUrl("file-a")]),
      ).resolves.toEqual(["blob:etag-file-a-1", "blob:etag-file-a-1"]);
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      scope.release();
    });

    test("releases object URLs only after the last matching authority scope closes", async () => {
      const revokeObjectUrl = vi.fn();
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes: async (_, fileId) => bytes(fileId),
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl,
      });
      const first = cache.acquire(authority);
      const second = cache.acquire(authority);
      first.subscribe("file-a", { objectUrl: true }, () => undefined);
      second.subscribe("file-a", { objectUrl: true }, () => undefined);
      await first.readObjectUrl("file-a");

      first.release();
      expect(revokeObjectUrl).not.toHaveBeenCalled();
      expect(second.snapshot("file-a").objectUrl).toBe("blob:etag-file-a-1");
      second.release();
      expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:etag-file-a-1");
    });

    test("does not publish a late read after its scope was released", async () => {
      const pending = deferred<FileBytes>();
      const createObjectUrl = vi.fn((file: FileBytes) => `blob:${file.etag}`);
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes: () => pending.promise,
        createObjectUrl,
        revokeObjectUrl: vi.fn(),
      });
      const scope = cache.acquire(authority);
      const read = scope.readBytes("file-a");
      scope.release();
      pending.resolve(bytes("file-a"));

      await expect(read).rejects.toThrow("released");
      expect(createObjectUrl).not.toHaveBeenCalled();
    });

    test("revokes stale presentation immediately when placement authority is removed", async () => {
      const revokeObjectUrl = vi.fn();
      let authorized = true;
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => {
          if (!authorized) throw new Error("not authorized");
          return metadata(fileId);
        },
        readBytes: async (_, fileId) => {
          if (!authorized) throw new Error("not authorized");
          return bytes(fileId);
        },
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl,
      });
      const scope = cache.acquire(authority);
      scope.subscribe("file-a", { metadata: true, objectUrl: true }, () => undefined);
      await Promise.all([scope.readMetadata("file-a"), scope.readObjectUrl("file-a")]);
      expect(scope.snapshot("file-a")).toMatchObject({
        metadata: { file_id: "file-a" },
        objectUrl: "blob:etag-file-a-1",
      });

      authorized = false;
      scope.invalidate({
        mode: "revoke",
        fileIds: ["file-a"],
        metadata: true,
        content: true,
      });

      expect(scope.snapshot("file-a")).toMatchObject({ metadata: null, objectUrl: null });
      expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith("blob:etag-file-a-1");
      await vi.waitFor(() => {
        expect(scope.snapshot("file-a")).toMatchObject({
          metadataError: "not authorized",
          contentError: "not authorized",
        });
      });
      scope.release();
    });

    test("detaches subscriptions owned by a released lease", async () => {
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes: async (_, fileId) => bytes(fileId),
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl: vi.fn(),
      });
      const first = cache.acquire(authority);
      const second = cache.acquire(authority);
      const firstListener = vi.fn();
      const secondListener = vi.fn();
      first.subscribe("file-a", { metadata: true }, firstListener);
      second.subscribe("file-a", { metadata: true }, secondListener);

      first.release();
      await second.readMetadata("file-a");

      expect(firstListener).not.toHaveBeenCalled();
      expect(secondListener).toHaveBeenCalled();
      second.release();
    });

    test("retains bytes and object URLs only while their presentation demand is active", async () => {
      const revokeObjectUrl = vi.fn();
      const cache = new FileReadCache({
        readMetadata: async (_, fileId) => metadata(fileId),
        readBytes: async (_, fileId) => bytes(fileId),
        createObjectUrl: (file) => `blob:${file.etag}`,
        revokeObjectUrl,
      });
      const scope = cache.acquire(authority);

      for (let index = 0; index < 32; index += 1) {
        const fileId = `file-${index}`;
        const releaseContent = scope.subscribe(fileId, { content: true }, () => undefined);
        const releaseImage = scope.subscribe(fileId, { objectUrl: true }, () => undefined);
        await scope.readObjectUrl(fileId);
        expect(scope.snapshot(fileId).bytes).not.toBeNull();

        releaseContent();
        expect(scope.snapshot(fileId).bytes).toBeNull();
        expect(scope.snapshot(fileId).objectUrl).not.toBeNull();
        releaseImage();
        expect(scope.snapshot(fileId)).toBe(EMPTY_FILE_READ_SNAPSHOT);
      }

      expect(revokeObjectUrl).toHaveBeenCalledTimes(32);
      scope.release();
    });
  });
});

describe("file search results", () => {
  const file = (path: string, kind: "file" | "directory" = "file"): FuzzyFileSearchResult => ({
    root: "/repo",
    path,
    file_name: path.split("/").at(-1)!,
    match_type: kind,
    score: 1,
    indices: null,
  });

  test("filters generated path segments, keeps the native order, and preserves directory mentions", () => {
    const results = projectFileSearchResults(
      [
        file("src/abc-helper.ts"),
        file("node_modules/pkg/abc.ts"),
        file(".git/abc"),
        file("src/abc", "directory"),
        file("src/abc-dist.ts"),
        file("dist/abc.ts"),
      ],
      ["/repo"],
    );
    expect(results[1]).toEqual({
      root: "/repo",
      relativePath: "src/abc",
      directoryPath: "src",
      path: "src/abc",
      fsPath: "/repo/src/abc",
      label: "abc",
      kind: "directory",
    });
    expect(results.map((result) => result.path)).toEqual([
      "src/abc-helper.ts",
      "src/abc",
      "src/abc-dist.ts",
    ]);
  });

  test("distinguishes equal relative paths across roots and labels their containing workspace", () => {
    const results = projectFileSearchResults(
      [
        { ...file("src/abc.ts"), root: "/one" },
        { ...file("src/abc.ts"), root: "/two" },
      ],
      ["/one", "/two"],
    );
    expect(
      results.map(({ path, fsPath, directoryPath }) => ({ path, fsPath, directoryPath })),
    ).toEqual([
      { path: "/one/src/abc.ts", fsPath: "/one/src/abc.ts", directoryPath: "one/src" },
      { path: "/two/src/abc.ts", fsPath: "/two/src/abc.ts", directoryPath: "two/src" },
    ]);
  });

  test("places matched characters on the displayed name and folder", () => {
    // "é" in a decomposed name is one character to the matcher but two UTF-16 units here.
    const path = "src/Re\u0301sume\u0301/notes-file.md";
    const [single] = projectFileSearchResults(
      [{ ...file(path), indices: [0, 4, 5, 11, 17] }],
      ["/repo"],
    );
    expect(single!.matched).toEqual({
      label: [
        { start: 0, end: 1 },
        { start: 6, end: 7 },
      ],
      directory: [
        { start: 0, end: 1 },
        { start: 4, end: 7 },
      ],
    });
    const [, second] = projectFileSearchResults(
      [file("x.md"), { ...file("src/abc.ts"), root: "/two", indices: [0, 4] }],
      ["/one", "/two"],
    );
    // The folder is shown as "two/src", so its characters shift past the root label.
    expect(second!.matched).toEqual({
      label: [{ start: 0, end: 1 }],
      directory: [{ start: 4, end: 5 }],
    });
  });
});

describe("file tree paths", () => {
  /** Folder flags with the tree's rule that opening a folder opens every folder above it. */
  function folderTree(paths: readonly string[], expanded: readonly string[] = []) {
    const open = new Set(expanded);
    const folders = new Set(paths);
    const getFolder = (path: string): FileTreeFolderHandle | null =>
      folders.has(path)
        ? {
            isExpanded: () => open.has(path),
            expand: () => {
              const parts = path.split("/");
              for (let depth = 1; depth <= parts.length; depth += 1)
                open.add(parts.slice(0, depth).join("/"));
            },
            collapse: () => open.delete(path),
          }
        : null;
    return { open, getFolder };
  }

  describe("file tree input", () => {
    test("lists every containing folder once, after the given entries", () => {
      expect(withFileTreeFolders(["a/b/c.ts", "a/b/", "x.ts", "a/d/e/"])).toEqual([
        "a/b/c.ts",
        "a/b/",
        "x.ts",
        "a/d/e/",
        "a/",
        "a/d/",
      ]);
    });

    test("removes deepest entries first and keeps entries both inputs share", () => {
      expect(
        diffFileTreePaths(["a/", "a/b/", "a/b/c.ts", "a/x.ts", "z.ts"], ["a/", "a/x.ts", "y.ts"]),
      ).toEqual([
        { type: "remove", path: "z.ts" },
        { type: "remove", path: "a/b/c.ts" },
        { type: "remove", path: "a/b/" },
        { type: "add", path: "y.ts" },
      ]);
    });
  });

  describe("file tree expansion", () => {
    test("keeps a parent collapsed when its expanded child is restored", () => {
      const tree = folderTree(["outer", "outer/inner"]);
      applyFileTreeExpansion(tree.getFolder, { expand: ["outer/inner"], collapse: [] });
      expect([...tree.open]).toEqual(["outer/inner"]);
    });

    test("opens requested ancestors and closes only incidental ones", () => {
      const tree = folderTree(["a", "a/b", "a/b/c", "x"], ["x"]);
      applyFileTreeExpansion(tree.getFolder, { expand: ["a/b/c", "a"], collapse: ["x"] });
      expect([...tree.open].sort()).toEqual(["a", "a/b/c"]);
    });

    test("leaves folders outside the request untouched", () => {
      const tree = folderTree(["a", "a/b", "c"], ["a", "c"]);
      applyFileTreeExpansion(tree.getFolder, { expand: ["a/b"], collapse: ["missing"] });
      expect([...tree.open].sort()).toEqual(["a", "a/b", "c"]);
    });
  });

  describe("file tree rows", () => {
    test("adds a placeholder inside each loading folder without colliding with real entries", () => {
      const input = buildFileTreeInput(["src/", "src/.nodex-loading", "docs/a.md"], ["src", "lib"]);
      expect([...input.loadingRows]).toEqual(["src/.nodex-loading_", "lib/.nodex-loading"]);
      expect(input.folders).toEqual(["src", "docs", "lib"]);
      expect(input.treePaths).toContain("lib/");
    });
  });
});

describe("readExactWorkspaceTextFile", () => {
  test("reads an absolute file without coupling the request to a workspace root", async () => {
    const readMetadata = vi.fn(async () => ({
      isFile: true,
      createdAtMs: 1,
      mtimeMs: 2,
      sizeBytes: 12,
      contentKind: "text" as const,
    }));
    const readText = vi.fn(async () => ({ contents: "outside root" }));

    await expect(
      readExactWorkspaceTextFile(
        {
          path: "/tmp/worktree/README.md",
          maxBytes: 1_000,
          contentSampleByteLimit: 128,
        },
        { readMetadata, readText },
      ),
    ).resolves.toBe("outside root");

    expect(readMetadata).toHaveBeenCalledWith({
      path: "/tmp/worktree/README.md",
      contentSampleByteLimit: 128,
      contentSampleMaxFileBytes: 1_000,
    });
    expect(readText).toHaveBeenCalledWith({
      path: "/tmp/worktree/README.md",
      maxBytes: 1_000,
    });
  });

  test.each([
    { contentKind: "binary" as const, sizeBytes: 12 },
    { contentKind: "text" as const, sizeBytes: 1_001 },
    { contentKind: undefined, sizeBytes: null },
  ])("does not read unsupported content: %o", async (metadata) => {
    const readText = vi.fn(async () => ({ contents: "unexpected" }));
    const result = await readExactWorkspaceTextFile(
      {
        path: "/tmp/file.bin",
        maxBytes: 1_000,
        contentSampleByteLimit: 128,
      },
      {
        readMetadata: async () => ({
          isFile: true,
          createdAtMs: 1,
          mtimeMs: 2,
          ...metadata,
        }),
        readText,
      },
    );

    expect(result).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("workspace file reveal", () => {
  test("builds a line target when a reference has only a start line", () => {
    expect(buildWorkspaceFileScrollTarget("file.ts", { line: 12, column: 3 })).toEqual({
      type: "line",
      id: "file.ts",
      lineNumber: 12,
      align: "center",
      behavior: "instant",
    });
    expect(buildWorkspaceFileLineSelection("file.ts", { line: 12 })).toBeNull();
  });

  test("keeps a column-only reference as a collapsed editor caret", () => {
    expect(buildWorkspaceFileEditorSelection({ line: 12, column: 3 })).toEqual({
      start: { line: 11, character: 2 },
      end: { line: 11, character: 2 },
      direction: "forward",
    });
  });

  test("builds a selected line range and editable character range", () => {
    const location = {
      line: 12,
      column: 3,
      endLine: 14,
      endColumn: 8,
    };

    expect(resolveWorkspaceFileRevealRange(location)).toEqual({ start: 12, end: 14 });
    expect(buildWorkspaceFileScrollTarget("file.ts", location)).toEqual({
      type: "range",
      id: "file.ts",
      range: { start: 12, end: 14 },
      align: "center",
      behavior: "instant",
    });
    expect(buildWorkspaceFileLineSelection("file.ts", location)).toEqual({
      id: "file.ts",
      range: { start: 12, end: 14 },
    });
    expect(buildWorkspaceFileEditorSelection(location)).toEqual({
      start: { line: 11, character: 2 },
      end: { line: 13, character: 7 },
      direction: "forward",
    });
  });

  test("rejects a reversed range", () => {
    expect(resolveWorkspaceFileRevealRange({ line: 14, endLine: 12 })).toBeNull();
    expect(buildWorkspaceFileEditorSelection({ line: 14, endLine: 12 })).toBeNull();
  });
});

describe("workspace search context", () => {
  const input = {
    hostId: "remote",
    projectRoots: ["/repo", "/docs"],
    executionCwd: "/worktree",
    workspaceBrowserRoot: null,
    isWorktree: true,
  };
  test("a worktree replaces only the primary checkout while retaining secondary roots", () => {
    expect(resolveWorkspaceSearchContext(input)).toEqual({
      hostId: "remote",
      roots: ["/worktree", "/docs"],
      skillRoots: ["/worktree", "/docs"],
    });
  });
  test("file search collapses nested roots while skill config retains the execution cwd", () => {
    expect(
      resolveWorkspaceSearchContext({ ...input, isWorktree: false, executionCwd: "/repo/src" }),
    ).toEqual({
      hostId: "remote",
      roots: ["/repo", "/docs"],
      skillRoots: ["/repo/src", "/repo", "/docs"],
    });
  });
  test("projectless search uses its browser root", () => {
    expect(
      resolveWorkspaceSearchContext({
        ...input,
        projectRoots: [],
        isWorktree: false,
        workspaceBrowserRoot: "/outputs",
      })?.roots,
    ).toEqual(["/outputs"]);
  });
});
