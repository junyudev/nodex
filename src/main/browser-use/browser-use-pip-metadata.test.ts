import { describe, expect, test, vi } from "vite-plus/test";
import { parseRemoteHostedPipNotification } from "./browser-use-pip-metadata";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import {
  BROWSER_USE_SITE_STATUS_CACHE_TTL_MS,
  makeSiteStatusPolicyRuntime,
  type SiteStatusPolicyRuntimeDependencies,
} from "./site-status-policy-service";
import {
  admitBrowserPipResource,
  emptyBrowserPipResourceState,
  releaseBrowserPipResources,
  validateBrowserPipImage,
  type BrowserPipResourceLease,
} from "./browser-pip-image-resource-governor";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeBrowserUsePolicyRuntime } from "./browser-use-policy-store";

describe("browser-use-pip-metadata", () => {
  function browserNotification(overrides: Record<string, unknown> = {}): unknown {
    return {
      method: "item/completed",
      params: {
        item: {
          result: {
            _meta: {
              "codex/toolSurface": {
                backend: "iab",
                browserId: "browser-1",
                browserFamily: "chrome",
                kind: "browserUse",
                openTabIds: ["tab-1"],
                screenshot: {
                  tabId: "tab-1",
                  url: "data:image/png;base64,YQ==",
                },
                ...overrides,
              },
            },
          },
          server: "node_repl",
          type: "mcpToolCall",
        },
        threadId: "thread-1",
      },
    };
  }

  describe("parseRemoteHostedPipNotification", () => {
    test("parses a completed node_repl Browser surface without projecting it to transcript state", () => {
      expect(parseRemoteHostedPipNotification(browserNotification())).toEqual({
        kind: "browser-use",
        surface: {
          backend: "iab",
          browserFamily: "chrome",
          browserId: "browser-1",
          openTabIds: ["tab-1"],
          screenshot: {
            tabId: "tab-1",
            url: "data:image/png;base64,YQ==",
          },
        },
        threadId: "thread-1",
      });
    });

    test("rejects non-node_repl calls, unsafe screenshots, and duplicate tab identities", () => {
      const wrongServer = browserNotification() as {
        params: { item: { server: string } };
      };
      wrongServer.params.item.server = "browser";
      expect(parseRemoteHostedPipNotification(wrongServer)).toBeNull();
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({
            screenshot: { tabId: "tab-1", url: "https://example.com/a.png" },
          }),
        ),
      ).toBeNull();
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({
            openTabIds: ["tab-1", "tab-1"],
          }),
        ),
      ).toBeNull();
      expect(
        parseRemoteHostedPipNotification(browserNotification({ browserId: "browser\0forged" })),
      ).toBeNull();
    });

    test("requires an exact extension instance and family only for Chrome surfaces", () => {
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({ backend: "chrome", extensionInstanceId: "profile-a" }),
        ),
      ).not.toBeNull();
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({ backend: "chrome", browserFamily: undefined }),
        ),
      ).toBeNull();
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({ backend: "chrome", extensionInstanceId: undefined }),
        ),
      ).toBeNull();
      expect(
        parseRemoteHostedPipNotification(
          browserNotification({ backend: "cdp", extensionInstanceId: "profile-a" }),
        ),
      ).toBeNull();
    });

    test("parses thread and turn terminal lifecycle", () => {
      expect(
        parseRemoteHostedPipNotification({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
        }),
      ).toEqual({
        completed: false,
        kind: "turn-ended",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      expect(
        parseRemoteHostedPipNotification({
          method: "thread/archived",
          params: { threadId: "thread-1" },
        }),
      ).toEqual({ deleted: false, kind: "thread-ended", threadId: "thread-1" });
    });

    test("identifies direct and node_repl Computer Use activity", () => {
      expect(
        parseRemoteHostedPipNotification({
          method: "item/started",
          params: {
            item: { id: "computer-1", server: "computer-use", type: "mcpToolCall" },
            threadId: "thread-1",
          },
        }),
      ).toEqual({ active: true, itemId: "computer-1", kind: "computer-use", threadId: "thread-1" });
      expect(
        parseRemoteHostedPipNotification({
          method: "item/completed",
          params: {
            item: {
              id: "node-1",
              result: { _meta: { "codex/toolSurface": { app: null, kind: "computerUse" } } },
              server: "node_repl",
              type: "mcpToolCall",
            },
            threadId: "thread-1",
          },
        }),
      ).toEqual({ active: true, itemId: "node-1", kind: "computer-use", threadId: "thread-1" });
    });
  });
});

describe("site-status-policy-service", () => {
  const response = (agent: boolean) =>
    new Response(JSON.stringify({ feature_status: { agent } }), { status: 200 });

  const makeRuntime = (overrides: Partial<SiteStatusPolicyRuntimeDependencies> = {}) =>
    Effect.gen(function* () {
      const logger = { warn: vi.fn() };
      const scope = yield* Scope.make();
      const dependencies: SiteStatusPolicyRuntimeDependencies = {
        apiBaseUrl: "https://chatgpt.com/backend-api",
        logger,
        request: () => Effect.succeed(response(false)),
        ...overrides,
      };
      const runtime = yield* makeSiteStatusPolicyRuntime(dependencies).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { logger, runtime, scope };
    });

  it.effect("requires a complete HTTP(S) URL and otherwise fails open", () =>
    Effect.gen(function* () {
      let requests = 0;
      const { runtime, scope } = yield* makeRuntime({
        request: () => Effect.sync(() => (requests += 1)).pipe(Effect.as(response(false))),
      });

      assert.isFalse(yield* runtime.isCommentModeBlocked("example.com"));
      assert.isFalse(yield* runtime.isCommentModeBlocked("file:///tmp/index.html"));
      assert.isFalse(runtime.cachedCommentModeBlocked("not a URL"));
      assert.strictEqual(requests, 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("sends the full URL and caches a successful decision by normalized hostname", () =>
    Effect.gen(function* () {
      let nowMs = 1_000;
      const inputs: Array<{ path: string; refreshOn401: boolean | undefined }> = [];
      const { runtime, scope } = yield* makeRuntime({
        now: () => nowMs,
        request: (input) =>
          Effect.sync(() => {
            inputs.push({ path: input.path, refreshOn401: input.refreshOn401 });
            return response(true);
          }),
      });

      assert.isTrue(
        yield* runtime.isCommentModeBlocked("https://www.example.com/private?q=1#section"),
      );
      assert.isTrue(yield* runtime.isCommentModeBlocked("https://example.com/other"));
      assert.lengthOf(inputs, 1);
      const endpoint = new URL(inputs[0]!.path, "https://chatgpt.com");
      assert.strictEqual(
        endpoint.searchParams.get("site_url"),
        "https://www.example.com/private?q=1#section",
      );
      assert.isTrue(inputs[0]!.refreshOn401);

      nowMs += BROWSER_USE_SITE_STATUS_CACHE_TTL_MS;
      assert.isTrue(yield* runtime.isCommentModeBlocked("https://example.com/after-expiry"));
      assert.lengthOf(inputs, 2);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("coalesces concurrent checks for the same hostname", () =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<Response>();
      let requests = 0;
      const { runtime, scope } = yield* makeRuntime({
        request: () =>
          Effect.sync(() => {
            requests += 1;
          }).pipe(Effect.andThen(Deferred.await(pending))),
      });
      const first = yield* Effect.forkChild(
        runtime.isCommentModeBlocked("https://example.com/first"),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(
        runtime.isCommentModeBlocked("https://www.example.com/second"),
        { startImmediately: true },
      );
      yield* Effect.yieldNow;
      assert.strictEqual(requests, 1);
      yield* Deferred.succeed(pending, response(true));
      assert.deepEqual(yield* Effect.all([Fiber.await(first), Fiber.await(second)]), [
        Exit.succeed(true),
        Exit.succeed(true),
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("caches valid false decisions but retries malformed and failed responses", () =>
    Effect.gen(function* () {
      const responses = [
        response(false),
        new Response("not-json", { status: 200 }),
        new Response("server-error", { status: 500 }),
        response(true),
      ];
      let requests = 0;
      const request = () =>
        Effect.sync(() => {
          requests += 1;
          const next = responses.shift();
          if (next === undefined) throw new Error("Unexpected request");
          return next;
        });

      const first = yield* makeRuntime({ request });
      assert.isFalse(yield* first.runtime.isCommentModeBlocked("https://allowed.example"));
      assert.isFalse(yield* first.runtime.isCommentModeBlocked("https://allowed.example/path"));
      assert.strictEqual(requests, 1);
      yield* Scope.close(first.scope, Exit.void);

      const second = yield* makeRuntime({ request });
      assert.isFalse(yield* second.runtime.isCommentModeBlocked("https://failed.example"));
      assert.isFalse(yield* second.runtime.isCommentModeBlocked("https://failed.example"));
      assert.isTrue(yield* second.runtime.isCommentModeBlocked("https://failed.example"));
      assert.strictEqual(requests, 4);
      assert.deepEqual(
        second.logger.warn.mock.calls.map(([, fields]) => fields),
        [{ code: "site-status-request-failed" }, { code: "site-status-http-error", status: 500 }],
      );
      yield* Scope.close(second.scope, Exit.void);
    }),
  );
});

describe("browser-pip-image-resource-governor", () => {
  const pngDataUrl = (width: number, height: number): string => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  };

  const jpegDataUrl = (width: number, height: number): string => {
    const bytes = Buffer.alloc(13);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x09, 0x08]);
    bytes.writeUInt16BE(height, 7);
    bytes.writeUInt16BE(width, 9);
    bytes.set([0xff, 0xd9], 11);
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  };

  const lease = (
    presentationId: string,
    sessionKey: string,
    taskId: string,
    updatedAt: number,
  ): BrowserPipResourceLease => ({
    compressedBytes: 24,
    estimatedDecodedBytes: 16,
    presentationId,
    sessionKey,
    taskId,
    updatedAt,
  });

  describe("Browser PiP image resource governor", () => {
    test("accepts canonical PNG headers and rejects disguised or oversized raster payloads", () => {
      expect(validateBrowserPipImage(pngDataUrl(10, 20))).toMatchObject({
        accepted: true,
        image: { estimatedDecodedBytes: 800, height: 20, mime: "image/png", width: 10 },
      });
      expect(validateBrowserPipImage(jpegDataUrl(12, 21))).toMatchObject({
        accepted: true,
        image: { estimatedDecodedBytes: 1_008, height: 21, mime: "image/jpeg", width: 12 },
      });
      expect(validateBrowserPipImage("data:image/png;base64,YQ==")).toEqual({
        accepted: false,
        reason: "header-mismatch",
      });
      expect(validateBrowserPipImage(pngDataUrl(8_193, 1))).toEqual({
        accepted: false,
        reason: "dimensions-too-large",
      });
      expect(validateBrowserPipImage("data:image/svg+xml;base64,PHN2Zz4=")).toEqual({
        accepted: false,
        reason: "unsupported-mime",
      });
    });

    test("evicts the oldest unrelated lease and releases each selected identity once", () => {
      const limits = {
        maximumDecodedBytesPerProcess: 32,
        maximumDecodedBytesPerSession: 32,
        maximumDecodedBytesPerThread: 32,
        maximumPresentationsPerProcess: 2,
        maximumPresentationsPerSession: 2,
        maximumPresentationsPerThread: 2,
      };
      const first = admitBrowserPipResource(
        emptyBrowserPipResourceState(),
        lease("one", "session-a", "thread-a", 1),
        limits,
      );
      const second = admitBrowserPipResource(
        first.state,
        lease("two", "session-b", "thread-b", 2),
        limits,
      );
      const third = admitBrowserPipResource(
        second.state,
        lease("three", "session-c", "thread-c", 3),
        limits,
      );

      expect(third.reason).toBeNull();
      expect(third.evicted.map((entry) => entry.presentationId)).toEqual(["one"]);
      expect([...third.state.leases.keys()]).toEqual(["two", "three"]);
      const released = releaseBrowserPipResources(
        third.state,
        (entry) => entry.taskId === "thread-b",
      );
      expect(released.released.map((entry) => entry.presentationId)).toEqual(["two"]);
      expect([...released.state.leases.keys()]).toEqual(["three"]);
    });

    test("keeps retained state constant across replacement and task-lifecycle pressure", () => {
      let state = emptyBrowserPipResourceState();

      for (let update = 1; update <= 1_000; update += 1) {
        const admission = admitBrowserPipResource(
          state,
          lease("current-tab", "current-session", "current-thread", update),
        );
        expect(admission.reason).toBeNull();
        expect(admission.evicted).toEqual([]);
        state = admission.state;
        expect(state.leases.size).toBe(1);
      }

      expect(state.leases.get("current-tab")?.updatedAt).toBe(1_000);
      state = releaseBrowserPipResources(state, (entry) => entry.taskId === "current-thread").state;
      expect(state.leases.size).toBe(0);

      for (let cycle = 1; cycle <= 100; cycle += 1) {
        const taskId = `task-${cycle}`;
        const admission = admitBrowserPipResource(
          state,
          lease(`presentation-${cycle}`, `session-${cycle}`, taskId, cycle),
        );
        expect(admission.reason).toBeNull();
        state = releaseBrowserPipResources(
          admission.state,
          (entry) => entry.taskId === taskId,
        ).state;
        expect(state.leases.size).toBe(0);
      }
    });
  });
});

describe("browser-use-policy-store", () => {
  it.layer(NodeServices.layer)("Browser Use policy runtime", (it) => {
    const makeRuntime = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-policy-" });
      const filePath = path.join(root, "browser", "config.toml");
      const runtime = yield* makeBrowserUsePolicyRuntime(filePath, () => 1_234);
      return { filePath, fs, path, root, runtime };
    });

    it.effect("atomically persists exact plugin keys and serializes concurrent mutations", () =>
      Effect.gen(function* () {
        const { filePath, fs, runtime } = yield* makeRuntime;
        yield* Effect.all(
          [
            runtime.updateModes({
              approvalMode: "neverAsk",
              historyApprovalMode: "alwaysAsk",
              downloadApprovalMode: "neverAsk",
              uploadApprovalMode: "alwaysAsk",
              fullCdpAccessEnabled: true,
            }),
            runtime.updateOriginRule({
              action: "add",
              kind: "denied",
              origin: "example.com/path",
              resource: "download",
            }),
          ],
          { concurrency: "unbounded" },
        );
        yield* runtime.updateOriginRule({
          action: "add",
          kind: "allowed",
          origin: "https://example.com",
          resource: "download",
        });

        assert.deepInclude(runtime.snapshot(), {
          approvalMode: "neverAsk",
          downloadApprovalMode: "neverAsk",
          fullCdpAccessEnabled: true,
          allowedDownloadOrigins: ["https://example.com"],
          deniedDownloadOrigins: [],
        });
        const raw = yield* fs.readFileString(filePath);
        assert.include(raw, 'approval_mode = "never_ask"');
        assert.include(raw, "full_cdp_access_enabled = true");
        assert.include(raw, "[downloads]");
      }),
    );

    it.effect("hard-denies general and resource-specific origins", () =>
      Effect.gen(function* () {
        const { runtime } = yield* makeRuntime;
        yield* runtime.updateOriginRule({
          action: "add",
          kind: "denied",
          origin: "https://blocked.example",
          resource: "origin",
        });
        yield* runtime.updateOriginRule({
          action: "add",
          kind: "denied",
          origin: "https://files.example",
          resource: "upload",
        });
        assert.isTrue(runtime.isExplicitlyDenied("download", "https://blocked.example/report.pdf"));
        assert.isTrue(runtime.isExplicitlyDenied("upload", "https://files.example/form"));
        assert.isFalse(runtime.isExplicitlyDenied("download", "https://files.example/report.pdf"));
      }),
    );

    it.effect(
      "quarantines invalid TOML without treating non-origin pages as explicit denials",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "nodex-browser-policy-invalid-",
          });
          const filePath = path.join(root, "config.toml");
          yield* fs.writeFileString(filePath, "[origins\n");
          const runtime = yield* makeBrowserUsePolicyRuntime(filePath, () => 4_321);
          assert.isFalse(runtime.snapshot().fullCdpAccessEnabled);
          assert.isFalse(runtime.isExplicitlyDenied("origin", "file:///tmp/private"));
          assert.isFalse(runtime.isExplicitlyDenied("origin", "about:blank"));
          assert.deepEqual(yield* fs.readDirectory(root), ["config.toml.corrupt-4321"]);
        }),
    );
  });
});
