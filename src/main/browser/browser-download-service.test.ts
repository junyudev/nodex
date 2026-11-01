import { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { makeBrowserDownloadRuntime } from "./browser-download-service";

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

  it.effect("quarantines malformed history without disabling download admission", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-download-corrupt-" });
      const historyFilePath = path.join(root, "browser-downloads.json");
      yield* fs.writeFileString(historyFilePath, "{broken");
      const test = yield* fixture({ history: historyFilePath });
      assert.deepEqual(test.runtime.snapshot(), { downloads: [] });
      assert.isTrue((yield* fs.readDirectory(root)).includes("browser-downloads.json.corrupt-100"));
      assert.strictEqual(test.session.listenerCount("will-download"), 1);
      yield* Scope.close(test.scope, Exit.void);
      assert.strictEqual(test.session.listenerCount("will-download"), 0);
    }),
  );
});
