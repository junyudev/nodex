import { EventEmitter } from "node:events";
import { it, assert } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { Session, WebContents } from "electron";
import { makePageFileHtmlHost } from "./page-file-html-host";
import {
  PageFileHtmlResolutionError,
  type PageFileHtmlResolver,
  type ResolvedPageFileHtml,
} from "./page-file-html-resolver";
import { PAGE_FILE_HTML_LIMITS } from "./page-file-html-policy";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";

const input = {
  routingContext: { kind: "library" } as const,
  pageId: "page",
  fileId: "report",
  logicalPath: "report.html",
  colorScheme: "light" as const,
};
type Handler = (request: Request) => Response | Promise<Response>;
const metadata = (path: string, size = 4): ResolvedPageFileHtml => ({
  path,
  storeEpoch: "epoch",
  presentation: {
    file_id: path,
    default_name: path,
    mime_type: path === "report.html" ? "text/html" : "application/octet-stream",
    version: 1,
    blob_etag: path,
    byte_length: size,
  },
});

const fixture = (resolver: PageFileHtmlResolver) =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const owner = Object.assign(new EventEmitter(), {
      id: 1,
      isDestroyed: () => false,
    }) as unknown as WebContents;
    const stranger = Object.assign(new EventEmitter(), {
      id: 2,
      isDestroyed: () => false,
    }) as unknown as WebContents;
    const host = yield* makePageFileHtmlHost({
      resolver,
      openExternal: async () => {},
      fromPartition: (partition) => {
        const native = Object.assign(new EventEmitter(), {
          setPermissionCheckHandler: () => {},
          setPermissionRequestHandler: () => {},
          clearData: async () => {},
          setProxy: async () => {},
          resolveProxy: async () => "PROXY 127.0.0.1:0",
          webRequest: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {} },
          protocol: {
            handle: (_scheme: string, handler: Handler) => {
              handlers.set(partition, handler);
            },
            unhandle: () => {},
          },
        });
        return native as unknown as Session;
      },
    });
    const result = yield* host.admit(owner, input);
    if (result.status !== "admitted") throw new Error(result.message);
    const claim = result.admission;
    const handler = handlers.get(claim.partition)!;
    const request = (path = "report.html", method = "GET") =>
      Promise.resolve(handler(new Request(new URL(path, claim.url), { method })));
    return { host, owner, stranger, claim, request };
  });

it.effect("binds admission to its renderer before the Space guest gate is acquired", () =>
  Effect.gen(function* () {
    const { host, owner, stranger, claim, request } = yield* fixture({
      resolve: (_input, path) => Effect.succeed(metadata(path ?? "report.html")),
      read: () => Effect.succeed(new Uint8Array([1, 2, 3, 4])),
    });
    const rejected: boolean[] = [];
    const event = {
      defaultPrevented: false,
      preventDefault: () => {
        rejected.push(true);
      },
    };
    host
      .createHost(stranger)
      .handleWillAttach(event, {}, { partition: claim.partition, src: claim.url });
    assert.deepEqual(rejected, [true]);
    host
      .createHost(owner)
      .handleWillAttach(event, {}, { partition: claim.partition, src: claim.url });
    assert.deepEqual(rejected, [true]);
    assert.equal((yield* Effect.promise(() => request())).status, 200);
    owner.emit("did-start-navigation", {}, "https://renderer.invalid/another-space", false, true);
    assert.equal((yield* Effect.promise(() => request())).status, 410);
  }).pipe(Effect.scoped, Effect.provide(WebContentsDestructionSubscriptions.live)),
);

it.effect("bounds cumulative bytes before starting a read that would exceed the budget", () =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(PAGE_FILE_HTML_LIMITS.resourceBytes);
    let reads = 0;
    const { request } = yield* fixture({
      resolve: (_input, path) =>
        Effect.succeed(metadata(path ?? "report.html", path ? bytes.byteLength : 4)),
      read: () =>
        Effect.sync(() => {
          reads++;
          return bytes;
        }),
    });
    for (let index = 0; index < 4; index++)
      assert.equal((yield* Effect.promise(() => request("resource.bin", "HEAD"))).status, 200);
    const rejected = yield* Effect.promise(() => request("resource.bin", "HEAD"));
    assert.equal(rejected.status, 413);
    assert.equal(yield* Effect.promise(() => rejected.text()), "");
    assert.equal(reads, 4);
  }).pipe(Effect.scoped, Effect.provide(WebContentsDestructionSubscriptions.live)),
);

it.effect("bounds request count even for invalid paths and never reads beyond it", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { request } = yield* fixture({
      resolve: () => Effect.succeed(metadata("report.html")),
      read: () =>
        Effect.sync(() => {
          reads++;
          return new Uint8Array(4);
        }),
    });
    for (let index = 0; index < PAGE_FILE_HTML_LIMITS.requests; index++)
      assert.equal((yield* Effect.promise(() => request("report.html", "POST"))).status, 405);
    assert.equal((yield* Effect.promise(() => request())).status, 429);
    assert.equal(reads, 0);
  }).pipe(Effect.scoped, Effect.provide(WebContentsDestructionSubscriptions.live)),
);

it.effect(
  "bounds concurrent reads and release interrupts every pending request before returning bytes",
  () =>
    Effect.gen(function* () {
      let pending = 0;
      let interrupted = 0;
      const { request, host, owner, stranger, claim } = yield* fixture({
        resolve: (_input, path) => Effect.succeed(metadata(path ?? "report.html")),
        read: () =>
          Effect.sync(() => {
            pending++;
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      const requests = Array.from({ length: PAGE_FILE_HTML_LIMITS.concurrency }, () => request());
      yield* Effect.promise(() =>
        expect.poll(() => pending).toBe(PAGE_FILE_HTML_LIMITS.concurrency),
      );
      assert.equal((yield* Effect.promise(() => request())).status, 429);
      assert.isFalse(host.release(stranger, claim.grant));
      assert.isTrue(host.release(owner, claim.grant));
      const responses = yield* Effect.promise(() => Promise.all(requests));
      assert.deepEqual(
        responses.map((response) => response.status),
        Array.from({ length: PAGE_FILE_HTML_LIMITS.concurrency }, () => 410),
      );
      assert.equal(interrupted, PAGE_FILE_HTML_LIMITS.concurrency);
      assert.equal((yield* Effect.promise(() => request())).status, 410);
    }).pipe(Effect.scoped, Effect.provide(WebContentsDestructionSubscriptions.live)),
);

it.effect(
  "withholds bytes if the document relation or resource binding changes during a read",
  () =>
    Effect.gen(function* () {
      for (const change of ["document-removed", "resource-replaced"] as const) {
        let changed = false;
        const { request } = yield* fixture({
          resolve: (_input, path) =>
            Effect.suspend(() => {
              if (!path && changed && change === "document-removed")
                return Effect.fail(new PageFileHtmlResolutionError());
              const value = metadata(path ?? "report.html");
              return Effect.succeed(
                path && changed
                  ? { ...value, presentation: { ...value.presentation, file_id: "replacement" } }
                  : value,
              );
            }),
          read: () =>
            Effect.sync(() => {
              changed = true;
              return new Uint8Array([1, 2, 3, 4]);
            }),
        });
        const response = yield* Effect.promise(() => request("trace.json"));
        assert.equal(response.status, 404);
        assert.equal(yield* Effect.promise(() => response.text()), "");
      }
    }).pipe(Effect.scoped, Effect.provide(WebContentsDestructionSubscriptions.live)),
);
