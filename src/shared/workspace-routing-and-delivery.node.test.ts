import { describe, expect, test, it } from "vite-plus/test";
import {
  buildAppFilesystemPath,
  buildAppFilesystemUrl,
  buildEnvironmentAwareFilesystemUrl,
  isAbsoluteAppFilesystemPath,
  normalizeAppFilesystemPath,
  restoreNativeAppFilesystemPath,
} from "./app-protocol";
import {
  APP_RENDERER_ORIGIN,
  APP_RENDERER_URL,
  buildTopLevelRendererCsp,
} from "./app-renderer-policy";
import {
  parseAuthorizedDeliveryPacket,
  type AuthorizedDeliveryPacket,
} from "./authorized-delivery-packet";
import {
  contentRoutingContextKey,
  contentRoutingIdentityKey,
  libraryContentRoute,
  parseContentRoutingContext,
  projectIdFromContentRoutingContext,
  projectContentRoute,
} from "./content-routing-context";
import {
  GIT_WORKER_PROTOCOL_VERSION,
  isGitWorkerMessageForView,
  isGitWorkerMessageFromHost,
  isGitWorkerMessageFromThread,
  isGitWorkerMessageFromView,
} from "./git-worker-protocol";
import { isSpaceIpcChannel } from "./space-ipc-policy";
import {
  canonicalWorkbenchFilePath,
  workbenchFileResourceId,
  workbenchFilesResourceKey,
} from "./workbench-resource-identity";

describe("app protocol", () => {
  describe("app filesystem URL codec", () => {
    test.each([
      ["/Users/asc/My Image #1?.png", "/@fs/Users/asc/My%20Image%20%231%3F.png"],
      ["/tmp/你好.png", "/@fs/tmp/%E4%BD%A0%E5%A5%BD.png"],
      ["C:\\Users\\asc\\image.png", "/@fs/C:/Users/asc/image.png"],
      ["/C:/Users/asc/image.png", "/@fs/C:/Users/asc/image.png"],
      ["\\\\server\\share\\image.png", "/@fs//server/share/image.png"],
      ["mixed\\folder/image%20name.png", "/@fsmixed/folder/image%2520name.png"],
      ["", "/@fs"],
    ])("encodes %s without applying source authorization", (filePath, expected) => {
      expect(buildAppFilesystemPath(filePath)).toBe(expected);
    });

    test("builds full and environment-aware URLs", () => {
      expect(buildAppFilesystemUrl("/tmp/image.png")).toBe("app://fs/@fs/tmp/image.png");
      expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "http:")).toBe(
        "/@fs/tmp/image.png",
      );
      expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "https:")).toBe(
        "/@fs/tmp/image.png",
      );
      expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "app:")).toBe(
        "app://fs/@fs/tmp/image.png",
      );
    });

    test("keeps codec normalization and absolute-path authorization separate", () => {
      expect(normalizeAppFilesystemPath("C:\\work/mixed\\image.png")).toBe(
        "/C:/work/mixed/image.png",
      );
      expect(isAbsoluteAppFilesystemPath("/tmp/image.png")).toBe(true);
      expect(isAbsoluteAppFilesystemPath("C:\\work\\image.png")).toBe(true);
      expect(isAbsoluteAppFilesystemPath("\\\\server\\share\\image.png")).toBe(true);
      expect(isAbsoluteAppFilesystemPath("//server/share/image.png")).toBe(true);
      expect(isAbsoluteAppFilesystemPath("relative/image.png")).toBe(false);
      expect(isAbsoluteAppFilesystemPath("//not-a-complete-unc")).toBe(false);
    });

    test("removes exactly one renderer drive slash and preserves other paths", () => {
      expect(restoreNativeAppFilesystemPath("/C:/work/image.png")).toBe("C:/work/image.png");
      expect(restoreNativeAppFilesystemPath("//server/share/image.png")).toBe(
        "//server/share/image.png",
      );
      expect(restoreNativeAppFilesystemPath("/tmp/image.png")).toBe("/tmp/image.png");
    });
  });

  test.each(["C:\\media\\image.png", "D:/media/image.png", "\\\\server\\share\\image.png"])(
    "keeps Windows media on the native protocol in development: %s",
    (path) => {
      expect(buildEnvironmentAwareFilesystemUrl(path, "http:")).toBe(buildAppFilesystemUrl(path));
      expect(buildEnvironmentAwareFilesystemUrl(path, "https:")).toBe(buildAppFilesystemUrl(path));
    },
  );
});

describe("top-level renderer CSP", () => {
  test("uses the privileged packaged app origin", () => {
    expect(APP_RENDERER_ORIGIN).toBe("app://-");
    expect(APP_RENDERER_URL).toBe("app://-/index.html");
  });

  test("denies inline and JavaScript eval while allowing the bundled WASM kernel", () => {
    const csp = buildTopLevelRendererCsp({ mode: "production" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://api.statsigcdn.com");
    expect(csp).toContain("https://cloudflare-dns.com");
    expect(csp).toContain("https://prodregistryv2.org");
    expect(csp).toContain("img-src 'self' app: blob: data: https:");
    expect(csp).toContain("media-src 'self' app: blob: data:");
    expect(csp.split(/[;\s]+/u)).not.toContain("file:");
    expect(csp).not.toContain("nodex-asset:");
  });

  test("embeds Page File guests without granting byte-fetch capability", () => {
    const directives = new Map(
      buildTopLevelRendererCsp({ mode: "production" })
        .split("; ")
        .map((directive) => {
          const [name, ...sources] = directive.split(" ");
          return [name, sources];
        }),
    );
    expect(directives.get("frame-src")).toContain("nodex-page-file:");
    expect(directives.get("child-src")).toContain("nodex-page-file:");
    expect(directives.get("connect-src")).not.toContain("nodex-page-file:");
  });

  test("keeps authenticated WebSocket connections in Main", () => {
    const csp = buildTopLevelRendererCsp({ mode: "production" });
    const connections = csp
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "))!
      .split(" ")
      .slice(1);
    expect(
      connections.some((source) => source.startsWith("ws:") || source.startsWith("wss:")),
    ).toBe(false);
  });

  test("limits development connections to the Vite origin", () => {
    const csp = buildTopLevelRendererCsp({ mode: "development" });
    expect(csp).toContain("http://localhost:*");
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("connect-src *");
  });

  test("narrows development connections to the resolved local Vite origin", () => {
    const csp = buildTopLevelRendererCsp({
      mode: "development",
      developmentOrigin: "http://localhost:51285/",
    });

    expect(csp).toContain("http://localhost:51285");
    expect(csp).toContain("ws://localhost:51285");
    expect(csp).not.toContain("51284");
    expect(csp).not.toContain("localhost:*");
  });

  test("does not trust a non-local development origin", () => {
    const csp = buildTopLevelRendererCsp({
      mode: "development",
      developmentOrigin: "https://example.com:51285/",
    });

    expect(csp).not.toContain("example.com");
    expect(csp).toContain("http://localhost:*");
  });
});

describe("authorized delivery packet", () => {
  const packet = (): AuthorizedDeliveryPacket => ({
    packet_version: 5,
    delivery_address: {
      kind: "project",
      library_id: "library-1",
      project_id: "project-1",
    },
    manifest: {
      event_version: 8,
      identity: {
        store_epoch: "epoch-1",
        commit_seq: 9,
        manifest_hash: "1".repeat(64),
      },
      operation_id: "operation-1",
      committed_at: "2026-08-09T00:00:00.000Z",
    },
    atoms: [],
    document_effects: [
      {
        reference: {
          effect_order: 2,
          page_id: "page-1",
          document_id: "document-1",
          generation: 1,
          base_head_seq: 3,
          result_head_seq: 4,
          update_id: "update-1",
          update_hash: "2".repeat(64),
          update_byte_length: 2,
          resource_kind: "document_update",
        },
        inline_update: [4, 5],
        history_fence: { headSeq: 4, blockIds: ["block:moved"], documentWide: false },
      },
    ],
    projection_effects: [],
    coverage: {
      atom_ids: [],
      document_effect_orders: [2],
      inline_document_effect_orders: [2],
      projection_scope_keys: [],
    },
    packet_hash: "3".repeat(64),
  });

  describe("authorized delivery packet boundary", () => {
    test("accepts projectless Automation delivery while rejecting invalid actor coordinates", () => {
      const value: AuthorizedDeliveryPacket = {
        ...packet(),
        atoms: [
          {
            descriptor: {
              atom_id: "5".repeat(64),
              atom_order: 0,
              kind: "automation_changed",
              payload_hash: "6".repeat(64),
              required_resources: [{ kind: "library", library_id: "library-1" }],
            },
            payload: {
              module: "automation",
              library_id: "library-1",
              project_id: null,
              event: {
                kind: "automation_changed",
                automation_ids: ["automation-1"],
                database_ids: [],
                document_ids: [],
                lease_ids: [],
                page_ids: [],
                reminder_lease_ids: [],
                run_ids: [],
                snooze_ids: [],
              },
            },
          },
        ],
        coverage: { ...packet().coverage, atom_ids: ["5".repeat(64)] },
      };
      expect(parseAuthorizedDeliveryPacket(value)).toBe(value);
      for (const projectId of [undefined, "", " ", 42]) {
        expect(() =>
          parseAuthorizedDeliveryPacket({
            ...value,
            atoms: [
              { ...value.atoms[0], payload: { ...value.atoms[0]!.payload, project_id: projectId } },
            ],
          }),
        ).toThrow("Authorized delivery packet is invalid");
      }
    });

    test("rejects history evidence outside its exact Document transition", () => {
      const value = packet();
      expect(() =>
        parseAuthorizedDeliveryPacket({
          ...value,
          document_effects: [
            {
              ...value.document_effects[0],
              history_fence: { headSeq: 5, blockIds: [], documentWide: true },
            },
          ],
        }),
      ).toThrow("Authorized delivery packet is invalid");
      expect(() =>
        parseAuthorizedDeliveryPacket({
          ...value,
          document_effects: [
            {
              ...value.document_effects[0],
              history_fence: { headSeq: 4, blockIds: ["block:a", "block:a"], documentWide: false },
            },
          ],
        }),
      ).toThrow("Authorized delivery packet is invalid");
    });
    test("accepts packet v4 with a complete Document effect", () => {
      const value = packet();
      expect(
        parseAuthorizedDeliveryPacket(value, {
          eventVersion: 8,
          libraryId: "library-1",
          storeEpoch: "epoch-1",
        }),
      ).toBe(value);
    });

    test("rejects legacy packets and coverage that omits a delivered resource", () => {
      expect(() =>
        parseAuthorizedDeliveryPacket({
          ...packet(),
          packet_version: 2,
        }),
      ).toThrow("Authorized delivery packet is invalid");
      expect(() =>
        parseAuthorizedDeliveryPacket({
          ...packet(),
          coverage: {
            ...packet().coverage,
            document_effect_orders: [],
          },
        }),
      ).toThrow("Authorized delivery packet is invalid");
    });

    test("pins Store, event, and Library authority when the caller supplies them", () => {
      expect(() =>
        parseAuthorizedDeliveryPacket(packet(), {
          eventVersion: 8,
          libraryId: "library-2",
          storeEpoch: "epoch-1",
        }),
      ).toThrow("Authorized delivery packet is invalid");
      expect(() =>
        parseAuthorizedDeliveryPacket(packet(), {
          eventVersion: 7,
          libraryId: "library-1",
          storeEpoch: "epoch-1",
        }),
      ).toThrow("Authorized delivery packet is invalid");
      expect(() =>
        parseAuthorizedDeliveryPacket(packet(), {
          eventVersion: 8,
          libraryId: "library-1",
          storeEpoch: "epoch-2",
        }),
      ).toThrow("Authorized delivery packet is invalid");
    });
  });
});

describe("ContentRoutingContext", () => {
  test("keeps Project and Library route selection explicit", () => {
    expect(projectContentRoute("project-1")).toEqual({
      kind: "project",
      projectId: "project-1",
    });
    expect(parseContentRoutingContext(libraryContentRoute)).toEqual({
      kind: "library",
    });
  });

  test("rejects embedded physical Library identities in presentation routes", () => {
    expect(() =>
      parseContentRoutingContext({
        kind: "library",
        libraryId: "forged-library",
      }),
    ).toThrow("libraryId is not supported");
    expect(() => parseContentRoutingContext({ kind: "project", projectId: " project-1" })).toThrow(
      "canonical non-empty identity",
    );
  });

  test("resolves optional Project routing separately from physical Library identity", () => {
    expect(projectIdFromContentRoutingContext(projectContentRoute("project-1"))).toBe("project-1");
    expect(projectIdFromContentRoutingContext(libraryContentRoute)).toBeNull();
    expect(contentRoutingContextKey(projectContentRoute("project-1"))).toBe("project:project-1");
    expect(contentRoutingContextKey(libraryContentRoute)).toBe("library");
    expect(() => contentRoutingContextKey({ kind: "forged" } as never)).toThrow(
      "kind is unsupported",
    );
    expect(
      contentRoutingIdentityKey({
        libraryId: "library-1",
        routingContext: libraryContentRoute,
      }),
    ).not.toBe(
      contentRoutingIdentityKey({
        libraryId: "library-2",
        routingContext: libraryContentRoute,
      }),
    );
  });
});

describe("Git worker protocol", () => {
  it("validates path source-state requests and nullable visibility results", () => {
    const request = (params: unknown) => ({
      type: "worker-request",
      workerId: "git",
      request: { id: "states", method: "path-source-states", params, enqueuedAtMs: 1 },
    });
    expect(isGitWorkerMessageFromView(request({ cwd: "/repo", paths: ["/repo/report.pdf"] }))).toBe(
      true,
    );
    for (const params of [
      { paths: [] },
      { cwd: "/repo", paths: [42] },
      { cwd: "/repo", paths: ["x".repeat(4097)] },
    ])
      expect(isGitWorkerMessageFromView(request(params))).toBe(false);
    const response = (isGitSourcePath: unknown) => ({
      type: "worker-response",
      workerId: "git",
      id: "states",
      method: "path-source-states",
      result: { type: "ok", value: [{ path: "/repo/report.pdf", isGitSourcePath }] },
    });
    for (const state of [true, false, null])
      expect(isGitWorkerMessageFromThread(response(state))).toBe(true);
    for (const state of [undefined, "ignored", 0])
      expect(isGitWorkerMessageFromThread(response(state))).toBe(false);
  });
  it("requires a nullable origin URL in stable repository metadata", () => {
    const metadata = {
      cwd: "/repo",
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      isGitRepository: true,
      currentBranch: "main",
      defaultBranch: "main",
      originUrl: null,
      errorMessage: null,
    };
    const response = (value: unknown) => ({
      type: "worker-response",
      workerId: "git",
      id: "metadata",
      method: "stable-metadata",
      result: { type: "ok", value },
    });
    for (const originUrl of [null, "git@github.com:example/project.git"])
      expect(isGitWorkerMessageForView(response({ ...metadata, originUrl }))).toBe(true);
    for (const originUrl of [undefined, 42, {}])
      expect(isGitWorkerMessageForView(response({ ...metadata, originUrl }))).toBe(false);
  });
  it("accepts bounded typed request, response, and lifecycle envelopes", () => {
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-1",
          method: "probe",
          params: { nonce: "hello" },
          enqueuedAtMs: 42,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-push",
          method: "push",
          params: { cwd: "/repo", force: true },
          enqueuedAtMs: 45,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-3",
          method: "review-diff",
          params: {
            cwd: "/repo",
            source: "unstaged",
            snapshotGeneration: 3,
            files: [{ path: "file.ts", status: "modified" }],
          },
          enqueuedAtMs: 44,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromHost({
        type: "worker-shutdown",
        workerId: "git",
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-2",
          method: "status-summary",
          params: { cwd: "/repo" },
          enqueuedAtMs: 43,
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageFromThread({
        type: "worker-ready",
        workerId: "git",
        epoch: 1,
        protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "worker-response",
        workerId: "git",
        id: "request-1",
        method: "probe",
        result: {
          type: "ok",
          value: {
            nonce: "hello",
            protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
          },
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "git-live-query-event",
        workerId: "git",
        event: {
          type: "git-live-query-updated",
          subscriptionId: "subscription-1",
          generation: 1,
          requiresRecovery: false,
          phase: "complete",
          method: "base-branch",
          result: {
            cwd: "/repo",
            local: "main",
            remote: "origin/main",
            errorMessage: null,
          },
        },
      }),
    ).toBe(true);
    expect(
      isGitWorkerMessageForView({
        type: "worker-response",
        workerId: "git",
        id: "request-2",
        method: "status-summary",
        result: {
          type: "ok",
          value: {
            type: "success",
            stagedCount: 1,
            unstagedCount: 2,
            untrackedCount: null,
            snapshotGeneration: 3,
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed, oversized, and version-skewed envelopes", () => {
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-1",
          method: "probe",
          params: { nonce: "" },
          enqueuedAtMs: 42,
        },
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request-cancel",
        workerId: "git",
        id: "x".repeat(257),
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromThread({
        type: "worker-ready",
        workerId: "git",
        epoch: 1,
        protocolVersion: GIT_WORKER_PROTOCOL_VERSION + 1,
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageForView({
        type: "worker-restarted",
        workerId: "git",
        epoch: 1,
      }),
    ).toBe(false);
    expect(
      isGitWorkerMessageFromView({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "request-3",
          method: "review-diff",
          params: {
            cwd: "/repo",
            source: "unstaged",
            snapshotGeneration: 3,
            files: Array.from({ length: 513 }, () => ({
              path: "file.ts",
              status: "modified",
            })),
          },
          enqueuedAtMs: 44,
        },
      }),
    ).toBe(false);
  });
});

describe("space ipc policy", () => {
  test("Space administration and content require a Space", () => {
    expect(isSpaceIpcChannel("space-admin:devices")).toBe(true);
    expect(isSpaceIpcChannel("space-admin:link-device")).toBe(true);
    expect(isSpaceIpcChannel("inbox:window")).toBe(true);
    expect(isSpaceIpcChannel("work:start")).toBe(true);
    expect(isSpaceIpcChannel("settings:inbox:get")).toBe(true);
  });

  test("chat rewrites stay on their Space and cannot fall through to the personal Runtime", () => {
    expect(isSpaceIpcChannel("agent-runtime:session:rewrite-message")).toBe(true);
  });

  test("device-wide queries and commands run on this desktop in every Space", () => {
    for (const channel of [
      "electron-window:focus:get",
      "surface-history:bind",
      "codex-command-keymap-state",
      "set-codex-command-keybinding",
      "global-dictation:keyboard-layout:update",
      "codex:dictation:state:read",
      "product-analytics:record",
      "product-analytics:notice:read",
      "terminal-shells:list",
    ] as const)
      expect(isSpaceIpcChannel(channel), channel).toBe(false);
    // The desktop's own Agents and native chats still belong to the personal Space.
    for (const channel of [
      "codex:sidebar:sync",
      "codex:composer-skills:list",
      "agent-runtime:subscription-usage:read",
      "thread-execution:location",
    ] as const)
      expect(isSpaceIpcChannel(channel), channel).toBe(true);
  });

  test("keeps built-in Agent profile settings on this Desktop", () => {
    expect(isSpaceIpcChannel("settings:agent-profiles:get")).toBe(false);
    expect(isSpaceIpcChannel("settings:agent-profiles:update")).toBe(false);
  });
});

describe("Workbench resource identity", () => {
  test("resolves equivalent absolute paths without changing filename spelling or host", () => {
    expect(workbenchFileResourceId("local", "src/../文件.ts", "/workspace")).toBe(
      workbenchFileResourceId("local", "/workspace/文件.ts"),
    );
    expect(workbenchFileResourceId("local", "/workspace/a.ts")).not.toBe(
      workbenchFileResourceId("remote", "/workspace/a.ts"),
    );
    expect(workbenchFileResourceId("local", "/workspace/A.ts")).not.toBe(
      workbenchFileResourceId("local", "/workspace/a.ts"),
    );
    expect(canonicalWorkbenchFilePath("/workspace/ a.ts ")).toBe("/workspace/ a.ts ");
    expect(canonicalWorkbenchFilePath("/workspace/name\\part.ts")).toBe("/workspace/name\\part.ts");
    expect(() => workbenchFileResourceId("local", "relative.ts")).toThrow();
  });

  test("normalizes Windows separators without walking above a drive or share root", () => {
    expect(canonicalWorkbenchFilePath("C:\\work\\..\\a.ts")).toBe("C:/a.ts");
    expect(canonicalWorkbenchFilePath("C:/../../a.ts")).toBe("C:/a.ts");
    expect(canonicalWorkbenchFilePath(canonicalWorkbenchFilePath("//host/share/../a.ts"))).toBe(
      "//host/share/a.ts",
    );
    expect(canonicalWorkbenchFilePath("\\\\host\\share\\..\\a.ts")).toBe("//host/share/a.ts");
  });

  test("distinguishes file explorer roots while a file remains independent of its project placement", () => {
    const config = { projectId: "project", hostId: "local", workspaceRoot: "/one", cwd: "/one" };
    expect(workbenchFilesResourceKey(config)).not.toBe(
      workbenchFilesResourceKey({ ...config, cwd: "/two", workspaceRoot: "/two" }),
    );
    expect(workbenchFilesResourceKey({ ...config, path: "/one/file.ts" })).toBe(
      workbenchFilesResourceKey({
        ...config,
        projectId: "other",
        cwd: "/two",
        path: "/one/file.ts",
      }),
    );
  });
});
