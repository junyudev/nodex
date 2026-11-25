import {
  describe,
  expect,
  test,
  vi as vibrowserimageattachment,
  vi as vibrowserextensionsprovider,
} from "vite-plus/test";
import { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  makeBrowserDownloadRuntime,
  type BrowserDownloadRuntimeOptions,
} from "./browser-download-service";
import { BrowserAnnotations } from "./BrowserAnnotations";
import type {
  BrowserAnnotationSave,
  BrowserSavedAnnotation,
  BrowserAnnotationAnchor,
} from "../../shared/browser-annotation";
import { computeBrowserAnnotationEvidenceCrop } from "./browser-annotation-evidence";
import { MAX_MANAGED_IMAGE_BYTES } from "../../shared/managed-assets";
import { fetchBrowserImage } from "./browser-image-attachment";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBrowserExtensionsRuntime } from "./browser-extensions-provider";

describe("browser-download-service", () => {
  class FakeDownloadItem extends EventEmitter {
    cancelled = false;
    paused = false;
    savePath = "";
    receivedBytes = 0;
    totalBytes = 100;
    canResume() {
      return this.paused;
    }
    cancel() {
      this.cancelled = true;
    }
    getFilename() {
      return "report.pdf";
    }
    getReceivedBytes() {
      return this.receivedBytes;
    }
    getTotalBytes() {
      return this.totalBytes;
    }
    url = "https://example.com/download?secret=1";
    chain: string[] | null = null;
    getURL() {
      return this.url;
    }
    getURLChain() {
      return this.chain ?? [this.url];
    }
    isPaused() {
      return this.paused;
    }
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    setSavePath(path: string) {
      this.savePath = path;
    }
  }

  class FakeSession extends EventEmitter {}

  const identity = {
    browserConversationId: "conversation-1",
    browserViewScopeId: "window-session-1",
    browserTabId: "browser-tab-1",
  };

  it.layer(NodeServices.layer)("Browser download runtime", (it) => {
    const fixture = (
      options: {
        readonly agentControlled?: boolean;
        readonly history?: string;
        readonly now?: () => number;
        readonly unknownPage?: boolean;
        readonly onDownloadDone?: BrowserDownloadRuntimeOptions["onDownloadDone"];
      } = {},
    ) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-download-" });
        const session = new FakeSession();
        const snapshots: Array<readonly unknown[]> = [];
        const scope = yield* Scope.make();
        const historyFilePath = options.history ?? path.join(root, "browser-downloads.json");
        const runtime = yield* makeBrowserDownloadRuntime({
          downloadsDirectory: path.join(root, "downloads"),
          historyFilePath,
          idFactory: () => "download-1",
          isAgentControlled: () => options.agentControlled === true,
          logger: { warn: vi.fn() },
          now: options.now ?? (() => 100),
          onDownloadDone: options.onDownloadDone,
          onSnapshot: (snapshot) => snapshots.push(snapshot.downloads),
          resolveIdentity: () => (options.unknownPage ? null : identity),
          session: session as never,
          shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
        }).pipe(Effect.provideService(Scope.Scope, scope));
        return { fs, historyFilePath, root, runtime, scope, session, snapshots };
      });

    it.effect("tracks progress, persists sanitized origins, and reloads history", () =>
      Effect.gen(function* () {
        const test = yield* fixture();
        const item = new FakeDownloadItem();
        const event = { preventDefault: vi.fn() };
        test.session.emit("will-download", event, item, { id: 7 });

        assert.isFalse(event.preventDefault.mock.calls.length > 0);
        assert.isTrue(item.savePath.endsWith("report.pdf"));
        assert.deepInclude(test.runtime.snapshot().downloads[0], {
          sourceOrigin: "https://example.com",
          status: "starting",
        });
        assert.deepEqual(
          yield* test.runtime.handleAction({ action: "pause", downloadId: "download-1" }),
          { ok: true },
        );
        item.receivedBytes = 50;
        item.emit("updated", {}, "progressing");
        assert.deepEqual(
          yield* test.runtime.handleAction({ action: "resume", downloadId: "download-1" }),
          { ok: true },
        );
        assert.deepInclude(test.runtime.snapshot().downloads[0], {
          receivedBytes: 50,
          status: "progressing",
        });
        yield* Scope.close(test.scope, Exit.void);

        const replacementScope = yield* Scope.make();
        const replacement = yield* makeBrowserDownloadRuntime({
          downloadsDirectory: `${test.root}/downloads`,
          historyFilePath: test.historyFilePath,
          logger: { warn: vi.fn() },
          resolveIdentity: () => identity,
          session: new FakeSession() as never,
          shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
        }).pipe(Effect.provideService(Scope.Scope, replacementScope));
        assert.deepInclude(replacement.snapshot().downloads[0], {
          id: "download-1",
          receivedBytes: 50,
          status: "progressing",
        });
        yield* Scope.close(replacementScope, Exit.void);
      }),
    );

    it.effect("requires and consumes an exact short-lived agent download grant", () =>
      Effect.gen(function* () {
        const test = yield* fixture({ agentControlled: true });
        const denied = new FakeDownloadItem();
        const deniedEvent = { preventDefault: vi.fn() };
        test.session.emit("will-download", deniedEvent, denied, { id: 7 });
        assert.strictEqual(deniedEvent.preventDefault.mock.calls.length, 1);
        assert.isTrue(denied.cancelled);

        test.runtime.grantAgentDownload(
          { ...identity, webContentsId: 7 },
          "https://example.com/download?secret=1",
        );
        const allowed = new FakeDownloadItem();
        const allowedEvent = { preventDefault: vi.fn() };
        test.session.emit("will-download", allowedEvent, allowed, { id: 7 });
        assert.strictEqual(allowedEvent.preventDefault.mock.calls.length, 0);

        const replay = new FakeDownloadItem();
        const replayEvent = { preventDefault: vi.fn() };
        test.session.emit("will-download", replayEvent, replay, { id: 7 });
        assert.strictEqual(replayEvent.preventDefault.mock.calls.length, 1);
        yield* Scope.close(test.scope, Exit.void);
      }),
    );

    it.effect("matches only the final URL and retains unmatched grants until expiry", () =>
      Effect.gen(function* () {
        let now = 100;
        const test = yield* fixture({ agentControlled: true, now: () => now });
        const original = "https://example.com/download?secret=1";
        test.runtime.grantAgentDownload({ ...identity, webContentsId: 7 }, original);
        const redirected = new FakeDownloadItem();
        redirected.url = "https://cdn.example/report.pdf";
        redirected.chain = [original, redirected.url];
        test.session.emit("will-download", { preventDefault: vi.fn() }, redirected, { id: 7 });
        assert.isTrue(redirected.cancelled);
        const exact = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, exact, { id: 7 });
        assert.isFalse(exact.cancelled);
        test.runtime.grantAgentDownload({ ...identity, webContentsId: 7 }, original);
        now += 10_001;
        const expired = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, expired, { id: 7 });
        assert.isTrue(expired.cancelled);
        yield* Scope.close(test.scope, Exit.void);
      }),
    );

    it.effect("binds download grants to the validated physical page", () =>
      Effect.gen(function* () {
        const test = yield* fixture({ agentControlled: true });
        test.runtime.grantAgentDownload(
          { ...identity, webContentsId: 7 },
          "https://example.com/download?secret=1",
        );
        const replacement = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, replacement, { id: 8 });
        assert.isTrue(replacement.cancelled);
        const original = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, original, { id: 7 });
        assert.isFalse(original.cancelled);
        yield* Scope.close(test.scope, Exit.void);
      }),
    );

    it.effect("rejects unknown download pages", () =>
      Effect.gen(function* () {
        const test = yield* fixture({ unknownPage: true });
        const item = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, item, { id: 7 });
        assert.isTrue(item.cancelled);
        yield* Scope.close(test.scope, Exit.void);
      }),
    );

    for (const status of ["completed", "cancelled", "interrupted"] as const) {
      it.effect(`signals ${status} only for admitted downloads from the exact guest`, () =>
        Effect.gen(function* () {
          const onDownloadDone = vi.fn();
          const test = yield* fixture({ agentControlled: true, onDownloadDone });
          const denied = new FakeDownloadItem();
          test.session.emit("will-download", { preventDefault: vi.fn() }, denied, { id: 7 });
          denied.emit("done", {}, status);
          assert.isTrue(denied.cancelled);
          assert.strictEqual(onDownloadDone.mock.calls.length, 0);

          test.runtime.grantAgentDownload({ ...identity, webContentsId: 7 }, denied.url);
          const admitted = new FakeDownloadItem();
          test.session.emit("will-download", { preventDefault: vi.fn() }, admitted, { id: 7 });
          assert.isFalse(admitted.cancelled);
          assert.strictEqual(onDownloadDone.mock.calls.length, 0);
          admitted.emit("done", {}, status);
          yield* Effect.yieldNow;
          assert.deepEqual(onDownloadDone.mock.calls, [[7, status]]);
          yield* Scope.close(test.scope, Exit.void);
        }),
      );
    }

    it.effect("never signals a download rejected for missing page identity", () =>
      Effect.gen(function* () {
        const onDownloadDone = vi.fn();
        const test = yield* fixture({ unknownPage: true, onDownloadDone });
        const item = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, item, { id: 7 });
        item.emit("done", {}, "completed");
        yield* Effect.yieldNow;
        assert.isTrue(item.cancelled);
        assert.strictEqual(onDownloadDone.mock.calls.length, 0);
        yield* Scope.close(test.scope, Exit.void);
      }),
    );

    it.effect("stops signalling terminal results when the download runtime is released", () =>
      Effect.gen(function* () {
        const onDownloadDone = vi.fn();
        const test = yield* fixture({ onDownloadDone });
        const item = new FakeDownloadItem();
        test.session.emit("will-download", { preventDefault: vi.fn() }, item, { id: 7 });
        yield* Scope.close(test.scope, Exit.void);
        item.emit("done", {}, "completed");
        yield* Effect.yieldNow;
        assert.strictEqual(onDownloadDone.mock.calls.length, 0);
      }),
    );

    it.effect("quarantines malformed history without disabling download admission", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-download-corrupt-" });
        const historyFilePath = path.join(root, "browser-downloads.json");
        yield* fs.writeFileString(historyFilePath, "{broken");
        const test = yield* fixture({ history: historyFilePath });
        assert.deepEqual(test.runtime.snapshot(), { downloads: [] });
        assert.isTrue(
          (yield* fs.readDirectory(root)).includes("browser-downloads.json.corrupt-100"),
        );
        assert.strictEqual(test.session.listenerCount("will-download"), 1);
        yield* Scope.close(test.scope, Exit.void);
        assert.strictEqual(test.session.listenerCount("will-download"), 0);
      }),
    );
  });
});

describe("BrowserAnnotations", () => {
  describe("BrowserAnnotations", () => {
    const url = "https://example.com/";
    const draft: BrowserAnnotationSave = {
      editorId: "editor-1",
      sessionId: "session-1",
      destination: "session:chat-1",
      pageUrl: url,
      note: "Make this easier to read",
      intent: "comment",
      designChanges: [],
      anchors: [
        {
          id: "anchor-1",
          kind: "element",
          pageUrl: url,
          selector: "#heading",
          rect: { x: 10, y: 20, width: 30, height: 40 },
        },
      ],
    };
    function fixture() {
      let records: BrowserSavedAnnotation[] = [];
      const owner = new BrowserAnnotations((value) => {
        records = value;
      }, "tab-1");
      owner.destination = draft.destination;
      owner.sessionId = draft.sessionId;
      const save = (input = draft) => {
        const result = owner.save(input, url, "Example");
        if (!result.ok) throw new Error(result.message);
        return result.annotation;
      };
      return { owner, save, records: () => records };
    }
    describe("Browser annotations", () => {
      test("acknowledges a saved note once and numbers new notes monotonically", () => {
        const { owner, save, records } = fixture();
        const first = save();
        expect(first).toMatchObject({ number: 1, note: draft.note, evidenceState: "pending" });
        expect(save()).toBe(first);
        expect(records()).toHaveLength(1);
        owner.remove([first.id]);
        expect(save({ ...draft, editorId: "editor-2" }).number).toBe(2);
        expect(owner.save(draft, url, "Example")).toMatchObject({ ok: false });
      });
      test("keeps the note when evidence fails and attaches evidence when ready", () => {
        const { owner, save, records } = fixture();
        const first = save();
        owner.evidence(first.id, first, "Screenshot unavailable");
        expect(records()[0]).toMatchObject({
          note: draft.note,
          evidenceState: "failed",
          evidenceError: "Screenshot unavailable",
        });
        const second = save({ ...draft, editorId: "editor-2" });
        const evidence = {
          attachmentId: "shot",
          source: "nodex://assets/shot.png",
          mimeType: "image/png" as const,
          width: 40,
          height: 40,
        };
        owner.evidence(second.id, second, evidence);
        expect(records()[1]).toMatchObject({ note: draft.note, evidenceState: "ready", evidence });
      });
      test("a refused direct send retains its hidden note and a late capture can still finish", () => {
        const { owner, save, records } = fixture();
        const annotation = save({ ...draft, deliveryState: "sending" });
        expect(records()[0]?.deliveryState).toBe("sending");
        owner.retain([annotation.id]);
        owner.evidence(annotation.id, annotation, "Screenshot unavailable");
        expect(records()[0]).toMatchObject({
          note: draft.note,
          deliveryState: "saved",
          evidenceState: "failed",
        });
      });
      test("editing keeps the number and retires a late capture; removing retires it too", () => {
        const { owner, save, records } = fixture();
        const first = save();
        const edited = save({
          ...draft,
          annotationId: first.id,
          editorId: "edit",
          note: "Updated note",
        });
        owner.evidence(first.id, first, "Late failure");
        expect(records()).toEqual([edited]);
        expect(edited).toMatchObject({ id: first.id, number: 1, note: "Updated note" });
        owner.remove([edited.id]);
        owner.evidence(edited.id, edited, "Late failure");
        expect(records()).toEqual([]);
      });
      test("clears only the admitted set, leaving a concurrently saved note", () => {
        const { owner, save, records } = fixture();
        const first = save();
        const admitted = [first.id];
        const second = save({ ...draft, editorId: "editor-2" });
        owner.remove(admitted);
        expect(records()).toEqual([second]);
        owner.remove(records().map((record) => record.id));
        expect(records()).toEqual([]);
      });
      test.each([
        { sessionId: "stale" },
        { destination: "session:another-chat" },
        { pageUrl: "https://other.example/" },
        { anchors: [{ ...draft.anchors[0]!, pageUrl: "https://other.example/" }] },
        { note: "  " },
        { annotationId: "missing" },
        { intent: "designChange" as const },
      ])("refuses invalid or stale editor input %j without saving", (patch) => {
        const { owner, records } = fixture();
        expect(owner.save({ ...draft, ...patch }, url, "Example")).toMatchObject({
          ok: false,
          message: expect.any(String),
        });
        expect(records()).toEqual([]);
      });
      test("a page change keeps saved notes scoped to their original URL", () => {
        const { owner, save, records } = fixture();
        save();
        expect(
          owner.save({ ...draft, editorId: "new" }, "https://other.example/", "Other"),
        ).toMatchObject({ ok: false });
        expect(records()[0]?.pageUrl).toBe(url);
        owner.destination = null;
        expect(owner.save({ ...draft, editorId: "new" }, url, "Example")).toMatchObject({
          ok: false,
        });
      });
    });
  });

  describe("browser-annotation-evidence", () => {
    function anchor(rect: BrowserAnnotationAnchor["rect"]): BrowserAnnotationAnchor {
      return {
        id: crypto.randomUUID(),
        kind: "region",
        pageUrl: "https://example.com/",
        rect,
      };
    }

    describe("computeBrowserAnnotationEvidenceCrop", () => {
      test("maps viewport coordinates into captured-image pixels", () => {
        expect(
          computeBrowserAnnotationEvidenceCrop({
            anchors: [anchor({ x: 100, y: 50, width: 200, height: 100 })],
            imageSize: { width: 2_000, height: 1_000 },
            viewport: { width: 1_000, height: 500 },
            padding: 20,
          }),
        ).toEqual({
          x: 180,
          y: 80,
          width: 440,
          height: 240,
        });
      });

      test("unions multiple anchors and clamps the crop to image bounds", () => {
        expect(
          computeBrowserAnnotationEvidenceCrop({
            anchors: [
              anchor({ x: -10, y: -5, width: 30, height: 20 }),
              anchor({ x: 90, y: 80, width: 30, height: 40 }),
            ],
            imageSize: { width: 100, height: 100 },
            viewport: { width: 100, height: 100 },
            padding: 10,
          }),
        ).toEqual({
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        });
      });

      test("rejects empty, invalid, or fully out-of-frame evidence", () => {
        expect(
          computeBrowserAnnotationEvidenceCrop({
            anchors: [],
            imageSize: { width: 100, height: 100 },
            viewport: { width: 100, height: 100 },
          }),
        ).toBeNull();
        expect(
          computeBrowserAnnotationEvidenceCrop({
            anchors: [anchor({ x: 1, y: 1, width: 2, height: 2 })],
            imageSize: { width: 0, height: 100 },
            viewport: { width: 100, height: 100 },
          }),
        ).toBeNull();
        expect(
          computeBrowserAnnotationEvidenceCrop({
            anchors: [anchor({ x: 200, y: 200, width: 10, height: 10 })],
            imageSize: { width: 100, height: 100 },
            viewport: { width: 100, height: 100 },
            padding: 0,
          }),
        ).toBeNull();
      });
    });
  });
});

describe("browser-image-attachment", () => {
  const vi = vibrowserimageattachment;
  describe("fetchBrowserImage", () => {
    test("uses the page referrer and returns a supported bounded image", async () => {
      const fetch = vi.fn(
        async () =>
          new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { "content-type": "image/png; charset=binary" },
            status: 200,
          }),
      );

      await expect(
        fetchBrowserImage({
          fetch,
          pageUrl: "https://example.test/gallery",
          sourceUrl: "https://cdn.example.test/photo.png",
        }),
      ).resolves.toMatchObject({
        bytes: new Uint8Array([137, 80, 78, 71]),
        mimeType: "image/png",
        name: "photo.png",
      });
      expect(fetch).toHaveBeenCalledWith("https://cdn.example.test/photo.png", {
        referrer: "https://example.test/gallery",
      });
    });

    test("rejects credential-bearing and local-file sources before fetching", async () => {
      const fetch = vi.fn();

      await expect(
        fetchBrowserImage({
          fetch,
          pageUrl: "https://example.test",
          sourceUrl: "https://user:secret@example.test/image.png",
        }),
      ).rejects.toThrow("not allowed");
      await expect(
        fetchBrowserImage({
          fetch,
          pageUrl: "https://example.test",
          sourceUrl: "file:///Users/example/private.png",
        }),
      ).rejects.toThrow("not allowed");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects unsupported MIME types and declared oversized bodies", async () => {
      await expect(
        fetchBrowserImage({
          fetch: async () =>
            new Response("not an image", {
              headers: { "content-type": "text/html" },
            }),
          pageUrl: "https://example.test",
          sourceUrl: "https://example.test/image",
        }),
      ).rejects.toThrow("supported image");

      await expect(
        fetchBrowserImage({
          fetch: async () =>
            new Response(new Uint8Array([1]), {
              headers: {
                "content-length": String(MAX_MANAGED_IMAGE_BYTES + 1),
                "content-type": "image/png",
              },
            }),
          pageUrl: "https://example.test",
          sourceUrl: "https://example.test/image.png",
        }),
      ).rejects.toThrow("10MB");
    });
  });
});

describe("browser-extensions-provider", () => {
  const vi = vibrowserextensionsprovider;
  const withExtensionDirectory = <A, E, R>(
    run: (root: string) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-extension-"));
        fs.writeFileSync(
          path.join(root, "manifest.json"),
          JSON.stringify({ manifest_version: 3, name: "Example", version: "1.0.0" }),
        );
        return root;
      }),
      run,
      (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
    );

  it.effect("lists and loads unpacked extensions through Electron's public API", () =>
    withExtensionDirectory((root) =>
      Effect.gen(function* () {
        const loadExtension = vi.fn(async () => ({
          id: "extension-id",
          name: "Example",
          path: root,
          url: "chrome-extension://extension-id/",
          version: "1.0.0",
          manifest: { version: "1.0.0" },
        }));
        const runtime = makeBrowserExtensionsRuntime({
          getAllExtensions: () => [],
          loadExtension,
          removeExtension: vi.fn(),
        });

        assert.isTrue(runtime.capability().available);
        assert.deepInclude(yield* runtime.load(root), {
          id: "extension-id",
          version: "1.0.0",
        });
        assert.deepEqual(loadExtension.mock.calls[0], [root, { allowFileAccess: false }]);
      }),
    ),
  );

  it.effect("reports an explicit unavailable capability", () =>
    Effect.gen(function* () {
      const snapshot = yield* makeBrowserExtensionsRuntime(null).snapshot;
      assert.isFalse(snapshot.capability.available);
      assert.strictEqual(snapshot.capability.provider, "unavailable");
      assert.isEmpty(snapshot.extensions);
    }),
  );
});
