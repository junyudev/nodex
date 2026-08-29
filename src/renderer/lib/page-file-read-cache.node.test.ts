import { describe, expect, test, vi } from "vite-plus/test";

import type { LibraryPageFileSummary } from "../../shared/library-module";
import type { PageFileBytes } from "../../shared/page-files";
import { EMPTY_PAGE_FILE_READ_SNAPSHOT, PageFileReadCache } from "./page-file-read-cache";

const authority = {
  contentAccessContext: { kind: "project", projectId: "project-1" } as const,
  pageId: "page-1",
  storeEpoch: "store-1",
};

const metadata = (fileId: string, version = 1): LibraryPageFileSummary => ({
  fileId,
  ownerPageId: "page-1",
  logicalPath: `${fileId}.png`,
  mimeType: "image/png",
  byteLength: version,
  version,
  blobEtag: `etag-${fileId}-${version}`,
  state: "live",
  createdByActorId: "actor-1",
  createdByTurnId: null,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  bodyUsage: { kind: "placed", placementCount: 1 },
});

const bytes = (fileId: string, version = 1): PageFileBytes => ({
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

describe("PageFileReadCache", () => {
  test("deduplicates same-key metadata and content reads across scope leases", async () => {
    const metadataRead = deferred<LibraryPageFileSummary>();
    const bytesRead = deferred<PageFileBytes>();
    const readMetadata = vi.fn(() => metadataRead.promise);
    const readBytes = vi.fn(() => bytesRead.promise);
    const cache = new PageFileReadCache({
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
    const refresh = deferred<PageFileBytes>();
    const versions = new Map([
      ["file-a", 1],
      ["file-b", 1],
    ]);
    const readBytes = vi.fn((_, fileId: string) => {
      if (fileId === "file-a" && versions.get(fileId) === 2) return refresh.promise;
      return Promise.resolve(bytes(fileId, versions.get(fileId)));
    });
    const revoked: string[] = [];
    const cache = new PageFileReadCache({
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
    const cache = new PageFileReadCache({
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

  test("creates one object URL when bytes were already cached", async () => {
    const createObjectUrl = vi.fn((file: PageFileBytes) => `blob:${file.etag}`);
    const cache = new PageFileReadCache({
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
    const cache = new PageFileReadCache({
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
    const pending = deferred<PageFileBytes>();
    const createObjectUrl = vi.fn((file: PageFileBytes) => `blob:${file.etag}`);
    const cache = new PageFileReadCache({
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
    const cache = new PageFileReadCache({
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
      metadata: { fileId: "file-a" },
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
    const cache = new PageFileReadCache({
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
    const cache = new PageFileReadCache({
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
      expect(scope.snapshot(fileId)).toBe(EMPTY_PAGE_FILE_READ_SNAPSHOT);
    }

    expect(revokeObjectUrl).toHaveBeenCalledTimes(32);
    scope.release();
  });
});
