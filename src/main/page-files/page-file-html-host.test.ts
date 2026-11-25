import { describe, expect, test } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Session, WebContents } from "electron";
import { makePageFileHtmlHost } from "./page-file-html-host";
import {
  PageFileHtmlResolutionError,
  type PageFileHtmlResolver,
  type ResolvedPageFileHtml,
  makePageFileHtmlResolver,
} from "./page-file-html-resolver";
import {
  PAGE_FILE_HTML_LIMITS,
  decodePageFileHtmlPath,
  isAllowedPageFileHtmlRequest,
  pageFileHtmlMimeType,
  pageFileHtmlRequestPath,
  pageFileHtmlResponse,
  PAGE_FILE_HTML_CSP,
} from "./page-file-html-policy";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import { configurePageFileHtmlNetwork } from "./page-file-html-network";
import type { LibraryModule } from "../library-application/LibraryModule";
import type { LibraryModuleReadRequest, LibraryReadValue } from "../../shared/library-module";
import type { LibraryFile, ReadFileBytesInput } from "../../shared/library-files";

describe("page-file-html-host", () => {
  describe("page-file-html-host", () => {
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
        owner.emit(
          "did-start-navigation",
          {},
          "https://renderer.invalid/another-space",
          false,
          true,
        );
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
          const requests = Array.from({ length: PAGE_FILE_HTML_LIMITS.concurrency }, () =>
            request(),
          );
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
                      ? {
                          ...value,
                          presentation: { ...value.presentation, file_id: "replacement" },
                        }
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
  });

  describe("page-file-html-network", () => {
    it.live("refuses direct fallback or loopback bypass before guest admission", () =>
      Effect.gen(function* () {
        for (const bypass of ["direct", "fallback", "loopback"] as const) {
          const result = yield* Effect.result(
            configurePageFileHtmlNetwork({
              setProxy: async () => {},
              resolveProxy: async (url) => {
                if (bypass === "direct") return "DIRECT";
                if (bypass === "fallback") return "PROXY 127.0.0.1:0; DIRECT";
                return url.includes("example.invalid") ? "PROXY 127.0.0.1:0" : "DIRECT";
              },
            }),
          );
          assert.equal(result._tag, "Failure");
        }
      }),
    );

    it.live("waits for proxy propagation before admitting a guest", () =>
      Effect.gen(function* () {
        const verified = new Set<string>();
        let loopbackReady = false;
        yield* configurePageFileHtmlNetwork({
          setProxy: async () => {},
          resolveProxy: async (url) => {
            if (url === "http://127.0.0.1" && !loopbackReady) {
              loopbackReady = true;
              verified.clear();
              return "DIRECT";
            }
            verified.add(url);
            return "PROXY 127.0.0.1:0";
          },
        });
        assert.sameMembers(
          [...verified],
          ["https://example.invalid", "http://127.0.0.1", "http://[::1]"],
        );
      }),
    );

    it.effect("admits only after every network route uses the unreachable proxy", () =>
      Effect.gen(function* () {
        let configured = false;
        yield* configurePageFileHtmlNetwork({
          setProxy: async () => {
            configured = true;
          },
          resolveProxy: async () => {
            assert.isTrue(configured);
            return "PROXY 127.0.0.1:0";
          },
        });
      }),
    );
  });

  describe("page-file-html-policy", () => {
    describe("Page File request policy", () => {
      test.each([
        "/",
        "/a//b",
        "/../secret",
        "/a/./b",
        "/%2e%2e/secret",
        "/a%2fb",
        "/a%5cb",
        "/a\\b",
        "/%FF",
        "/%00",
        `/${"x".repeat(256)}`,
        `/${Array.from({ length: 33 }, () => "a").join("/")}`,
      ])("rejects ambiguous or unbounded paths: %s", (path) => {
        expect(decodePageFileHtmlPath(path)).toBeNull();
      });
      test("decodes once and preserves Page-root URL resolution", () => {
        expect(decodePageFileHtmlPath("/profile/%E6%8A%A5%E5%91%8A.html")).toBe(
          "profile/报告.html",
        );
        expect(decodePageFileHtmlPath("/a%252fb")).toBe("a%2fb");
        expect(
          pageFileHtmlRequestPath("nodex-page-file://grant/a/../secret", "nodex-page-file://grant"),
        ).toBeNull();
        expect(new URL("trace.json", "nodex-page-file://grant/profile/report.html").pathname).toBe(
          "/profile/trace.json",
        );
      });
      test("admits only its own origin and local data/blob resources", () => {
        const origin = "nodex-page-file://grant";
        for (const url of [
          origin + "/trace.json",
          "data:image/png;base64,AA==",
          `blob:${origin}/id`,
        ])
          expect(isAllowedPageFileHtmlRequest(url, origin)).toBe(true);
        for (const url of [
          "https://example.com",
          "http://localhost:80",
          "ws://localhost",
          "wss://example.com",
          "file:///etc/passwd",
          "app://renderer",
          "nodex://files/id",
          "nodex-page-file://other/a",
          "nodex-page-file://user@grant/a",
          "nodex-page-file://grant:3/a",
          "blob:nodex-page-file://other/id",
        ])
          expect(isAllowedPageFileHtmlRequest(url, origin)).toBe(false);
      });
      test("sets immutable policy headers without inferring executable MIME", async () => {
        const response = pageFileHtmlResponse(
          200,
          new TextEncoder().encode("<script>1</script>"),
          pageFileHtmlMimeType("text/plain"),
        );
        expect(response.headers.get("content-security-policy")).toBe(PAGE_FILE_HTML_CSP);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(pageFileHtmlMimeType("text/plain\r\nX-Injected: yes")).toBe(
          "application/octet-stream",
        );
      });
    });
  });
});

describe("page-file-html-resolver", () => {
  const file: LibraryFile = {
    created_by: { type: "member", member_id: "member-local" },
    file_id: "report",
    library_id: "library",
    default_name: "report.html",
    mime_type: "text/html",
    byte_length: 4,
    blob_etag: "etag",
    head_version: 7,
    revision: 1,
    lifecycle: "live",
    created_at: "now",
    updated_at: "now",
  };
  const input = {
    routingContext: { kind: "library" } as const,
    pageId: "page",
    fileId: "report",
    logicalPath: "profile/report.html",
    colorScheme: "light" as const,
  };
  function setup(logicalPath: string | null = input.logicalPath) {
    const requests: LibraryModuleReadRequest[] = [];
    const byteRequests: ReadFileBytesInput[] = [];
    let presentationEpoch = "epoch";
    const library: Pick<LibraryModule["Service"], "read" | "readFileBlob"> = {
      read: (_route, request) =>
        Effect.sync(() => {
          requests.push(request);
          const value: LibraryReadValue =
            request.read.mode === "resolve_page_file"
              ? {
                  kind: "resolved_page_file",
                  value: {
                    file,
                    logical_path: logicalPath,
                    attachment: logicalPath
                      ? {
                          attached_by: { type: "member", member_id: "member-local" },
                          attached_at: "2026-11-01T00:00:00.000Z",
                        }
                      : null,
                    body_count: 1,
                  },
                }
              : {
                  kind: "file_presentation",
                  value: {
                    file_id: file.file_id,
                    default_name: file.default_name,
                    mime_type: file.mime_type,
                    byte_length: file.byte_length,
                    blob_etag: file.blob_etag,
                    version: file.head_version,
                  },
                };
          return {
            ok: true as const,
            value: {
              profileId: "profile",
              libraryId: "library",
              storeEpoch: value.kind === "file_presentation" ? presentationEpoch : "epoch",
              commitSeq: 1,
              value,
            },
          };
        }),
      readFileBlob: (_route, request) =>
        Effect.sync(() => {
          byteRequests.push(request);
          return { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "text/html", etag: "etag" };
        }),
    };
    return {
      resolver: makePageFileHtmlResolver(library),
      requests,
      byteRequests,
      replaceStore: () => {
        presentationEpoch = "other";
      },
    };
  }

  it.effect(
    "uses Core's explicit Page path selector and Page-bound immutable version for bytes",
    () =>
      Effect.gen(function* () {
        const { resolver, requests, byteRequests } = setup();
        const resolved = yield* resolver.resolve(input);
        yield* resolver.read(input, resolved);
        assert.deepEqual(requests[0], {
          read: {
            mode: "resolve_page_file",
            page_id: "page",
            selector: { kind: "path", logical_path: "profile/report.html" },
          },
        });
        assert.deepEqual(byteRequests, [
          { fileId: "report", version: 7, source: { kind: "page", page_id: "page" } },
        ]);
        yield* resolver.resolve(input, "profile/trace.json");
        assert.deepEqual(requests[2], {
          read: {
            mode: "resolve_page_file",
            page_id: "page",
            selector: { kind: "path", logical_path: "profile/trace.json" },
          },
        });
      }),
  );

  it.effect("rejects stale document identity, missing explicit entry, and mixed Store epochs", () =>
    Effect.gen(function* () {
      const fixture = setup();
      assert.equal(
        (yield* Effect.result(fixture.resolver.resolve({ ...input, fileId: "other" })))._tag,
        "Failure",
      );
      const bodyOnly = setup(null);
      assert.equal(
        (yield* Effect.result(bodyOnly.resolver.resolve(input, "report.html")))._tag,
        "Failure",
      );
      fixture.replaceStore();
      assert.equal((yield* Effect.result(fixture.resolver.resolve(input)))._tag, "Failure");
    }),
  );

  it.effect(
    "admits body-only documents by exact File identity without inventing sibling names",
    () =>
      Effect.gen(function* () {
        const { resolver, requests } = setup(null);
        const document = yield* resolver.resolve({ ...input, logicalPath: null });
        assert.equal(document.path, "report.html");
        assert.deepEqual(requests[0], {
          read: {
            mode: "resolve_page_file",
            page_id: "page",
            selector: { kind: "file_id", file_id: "report" },
          },
        });
      }),
  );
});
