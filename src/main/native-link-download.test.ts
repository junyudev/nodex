import { EventEmitter } from "node:events";
import type { DownloadItem, Session, WebContents, WebContentsView } from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { WebContentsDestructionSubscriptions } from "./platform/electron/WebContentsDestructionSubscriptions";
import { startNativeLinkDownload } from "./native-link-download";

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
