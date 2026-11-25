import { expect, test, describe, vi } from "vite-plus/test";
import {
  browserAnnotationDefaultAction,
  browserAnnotationKeyAction,
  browserAnnotationAvailability,
} from "./browser-annotation-interaction";
import {
  BrowserAnnotationAttachmentSchema,
  resolveBrowserAnnotationDestination,
  BrowserAnnotationSelectionEventSchema,
  serializeBrowserAnnotationAttachmentForPrompt,
  serializeBrowserAnnotationAttachmentsForAdditionalContext,
} from "./browser-annotation";
import {
  TESTED_BROWSER_APP_SERVER_PAIRS,
  isTestedBrowserAppServerPair,
  projectBundledAppServerRuntimeIdentity,
} from "./browser-app-server-compatibility";
import {
  BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS,
  BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
  BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  parseBrowserRuntimeManifest,
  type MacBrowserRuntimeManifest,
} from "./browser-runtime-metadata";
import {
  BROWSER_USE_PEER_AUTHORIZATION_ENV,
  resolveBrowserUseHostCapability,
} from "./browser-use-host-capability";
import {
  createBrowserWebMcpModelContext,
  type BrowserWebMcpTool,
} from "./browser-webmcp-model-context";
import { isChromeControlRuntimeSnapshot } from "./chrome-control-settings";

describe("browser annotation interaction", () => {
  const key = {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
  };
  test("batch saves by default and quick sends, with the modifier selecting the other action", () => {
    expect(browserAnnotationDefaultAction("batch")).toBe("save");
    expect(browserAnnotationDefaultAction("quick")).toBe("send");
    for (const flow of ["batch", "quick"] as const) {
      expect(browserAnnotationKeyAction({ ...key, flow })).toBe(flow === "batch" ? "save" : "send");
      expect(browserAnnotationKeyAction({ ...key, flow, metaKey: true })).toBe(
        flow === "batch" ? "send" : "save",
      );
      expect(browserAnnotationKeyAction({ ...key, flow, ctrlKey: true })).toBe(
        flow === "batch" ? "send" : "save",
      );
    }
  });
  test.each([{ shiftKey: true }, { isComposing: true }, { repeat: true }, { key: "a" }])(
    "does not submit %j",
    (patch) => {
      expect(browserAnnotationKeyAction({ ...key, flow: "batch", ...patch })).toBeNull();
    },
  );
  test("suspension and Agent control gate interaction without changing the requested mode", () => {
    const wanted = { enabled: true, suspended: false, agentControlled: false };
    expect(browserAnnotationAvailability({ ...wanted, suspended: true })).toBe(false);
    expect(browserAnnotationAvailability({ ...wanted, agentControlled: true })).toBe(false);
    expect(browserAnnotationAvailability(wanted)).toBe(true);
    expect(browserAnnotationAvailability({ ...wanted, enabled: false })).toBe(false);
  });
});

describe("browser annotation", () => {
  const attachment = {
    schemaVersion: 1 as const,
    id: "annotation-1",
    browserTabId: "tab-1",
    createdAt: 1,
    intent: "designChange" as const,
    note: "Increase the spacing",
    pageTitle: "Checkout",
    pageUrl: "https://example.com/checkout",
    anchors: [
      {
        id: "anchor-1",
        kind: "region" as const,
        pageUrl: "https://example.com/checkout",
        rect: { x: 10, y: 20, width: 100, height: 50 },
      },
    ],
    evidence: {
      attachmentId: "evidence.png",
      source: "nodex://assets/evidence.png",
      mimeType: "image/png" as const,
      width: 148,
      height: 98,
    },
  };

  describe("Browser annotation contracts", () => {
    test("serializes design intent, anchors, and evidence without image bytes", () => {
      expect(serializeBrowserAnnotationAttachmentForPrompt(attachment)).toBe(
        [
          "[Browser design change: Checkout]",
          "URL: https://example.com/checkout",
          "1. region: rect(10, 20, 100, 50)",
          "Frame: top",
          "Comment: Increase the spacing",
          "Screenshot evidence: evidence.png",
        ].join("\n"),
      );

      const additionalContext = JSON.parse(
        serializeBrowserAnnotationAttachmentsForAdditionalContext([attachment]),
      );
      expect(additionalContext.attachments[0]).toEqual(attachment);
      expect(JSON.stringify(additionalContext)).not.toContain("base64");
    });

    test("defaults old attachments to comment intent and rejects oversized anchors", () => {
      const { intent, ...legacyAttachment } = attachment;
      expect(intent).toBe("designChange");
      expect(BrowserAnnotationAttachmentSchema.parse(legacyAttachment).intent).toBe("comment");
      expect(() =>
        BrowserAnnotationSelectionEventSchema.parse({
          sessionId: "session-1",
          multiSelect: false,
          anchor: {
            ...attachment.anchors[0],
            rect: { x: 0, y: 0, width: 100_001, height: 1 },
          },
        }),
      ).toThrow();
    });

    test("serializes structured design before and after values", () => {
      const designed = {
        ...attachment,
        designChanges: [
          {
            anchorId: "anchor-1",
            property: "borderRadius" as const,
            before: "4px",
            after: "12px",
          },
        ],
      };
      expect(serializeBrowserAnnotationAttachmentForPrompt(designed)).toContain(
        "Design property: borderRadius\nBefore: 4px\nAfter: 12px",
      );
      expect(BrowserAnnotationAttachmentSchema.parse(designed).designChanges).toEqual(
        designed.designChanges,
      );
    });
  });

  test("uses one stable Session destination before and after its first Thread", () => {
    expect(resolveBrowserAnnotationDestination({ sessionId: "chat" })).toBe("session:chat");
    expect(resolveBrowserAnnotationDestination({ sessionId: "chat", threadId: "thread" })).toBe(
      "session:chat",
    );
    expect(resolveBrowserAnnotationDestination({ threadId: "child" })).toBe("thread:child");
    expect(
      resolveBrowserAnnotationDestination({
        projectDraft: { projectId: "project", draftId: "draft" },
      }),
    ).toBe("project-draft:project:draft");
    expect(resolveBrowserAnnotationDestination({})).toBeNull();
  });

  test("the Agent receives actionable frame, selector, role, name, selected and nearby text", () => {
    const message = serializeBrowserAnnotationAttachmentForPrompt({
      ...attachment,
      anchors: [
        {
          ...attachment.anchors[0]!,
          kind: "text",
          framePath: ["#frame"],
          frameUrl: "https://example.com/frame",
          selector: "#copy",
          shadowHosts: ["#host"],
          elementPath: "#host >>> #copy",
          role: "heading",
          name: "Checkout",
          selectedText: "Pay now",
          nearbyText: "Secure checkout",
        },
      ],
    });
    for (const fact of [
      "Frame: #frame",
      "Frame URL: https://example.com/frame",
      "Target selector: #host >>> #copy",
      "Target role: heading",
      "Target name: Checkout",
      "Selected text: Pay now",
      "Nearby text: Secure checkout",
    ])
      expect(message).toContain(fact);
  });
});

describe("Browser and app-server compatibility", () => {
  test("accepts only an exact conformance-tested artifact pair", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");

    expect(isTestedBrowserAppServerPair(pair.appServer, pair.browser)).toBe(true);
    expect(
      isTestedBrowserAppServerPair({ ...pair.appServer, runtimeVersion: "0.152.1" }, pair.browser),
    ).toBe(false);
    expect(
      isTestedBrowserAppServerPair(pair.appServer, {
        ...pair.browser,
        manifestSha256: "0".repeat(64),
      }),
    ).toBe(false);
  });

  test("does not infer compatibility from version ordering", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");

    expect(
      isTestedBrowserAppServerPair(
        {
          ...pair.appServer,
          entrypointSha256: "f".repeat(64),
          runtimeVersion: "0.151.0",
        },
        pair.browser,
      ),
    ).toBe(false);
  });

  test("keeps the tested package identity stable after platform signing", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");
    const metadata = {
      appServerRuntimeVersion: pair.appServer.runtimeVersion,
      releaseAsset: { entrypointSha256: pair.appServer.entrypointSha256 },
      protocolSchemaFingerprint: pair.appServer.protocolSchemaFingerprint,
      sourceRevision: { commit: pair.appServer.sourceCommit },
      targetArch: pair.appServer.targetArch,
      targetPlatform: pair.appServer.targetPlatform,
    } as Parameters<typeof projectBundledAppServerRuntimeIdentity>[0];

    expect(projectBundledAppServerRuntimeIdentity(metadata)).toEqual(pair.appServer);
  });

  test("admits multiple exact partners without inferring untested combinations", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");
    const otherAppServer = { ...pair.appServer, entrypointSha256: "a".repeat(64) };
    const otherBrowser = { ...pair.browser, manifestSha256: "b".repeat(64) };
    const pairs = [
      pair,
      { appServer: otherAppServer, browser: pair.browser },
      { appServer: pair.appServer, browser: otherBrowser },
    ];

    for (const orderedPairs of [pairs, pairs.toReversed()]) {
      expect(isTestedBrowserAppServerPair(pair.appServer, pair.browser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(otherAppServer, pair.browser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(pair.appServer, otherBrowser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(otherAppServer, otherBrowser, orderedPairs)).toBe(false);
    }
  });
});

describe("browser runtime metadata", () => {
  const HASH = "a".repeat(64);

  function makeManifest(): MacBrowserRuntimeManifest {
    return {
      artifacts: [
        {
          architecture: "arm64",
          executable: true,
          kind: "executable",
          path: "bin/codex",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: true,
          kind: "executable",
          path: "bin/node",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: true,
          kind: "executable",
          path: "bin/node_repl",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: false,
          kind: "native-addon",
          path: "peer/authorize.node",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: false,
          kind: "native-addon",
          path: "native/sky.node",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "native/remote-hosted-pip/pop-in-window-egg@3x.png",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "native/remote-hosted-pip/pop-out-window-egg@3x.png",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/browser/manifest.json",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/browser/client.js",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/browser/service.js",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/browser/docs/SKILL.md",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/.agents/plugins/marketplace.json",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/chrome/scripts/installManifest.mjs",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/chrome/scripts/extension-ids.json",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: true,
          kind: "executable",
          path: "marketplace/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/computer-use/manifest.json",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/computer-use/client.mjs",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "any",
          executable: false,
          kind: "data",
          path: "marketplace/plugins/computer-use/docs/SKILL.md",
          sha256: HASH,
          size: 1,
        },
        {
          architecture: "arm64",
          executable: true,
          kind: "executable",
          path: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          sha256: HASH,
          size: 1,
        },
      ],
      browserPlugin: {
        client: "marketplace/plugins/browser/client.js",
        docs: "marketplace/plugins/browser/docs/SKILL.md",
        id: "browser@openai-bundled",
        manifest: "marketplace/plugins/browser/manifest.json",
        marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
        marketplaceRoot: "marketplace",
        nodeModuleDirs: ["runtime/lib/node_modules"],
        root: "marketplace/plugins/browser",
        service: "marketplace/plugins/browser/service.js",
        version: "1.0.0",
      },
      buildFlavor: "test",
      capabilities: {
        browserUse: {
          backends: {
            chrome: {
              extensionIds: [
                "hehggadaopoacecdllhhajmbjkdcmajg",
                "odlomjlbamekndcpllcnffbgeohgkmjh",
              ],
              familyDescriptor: "marketplace/plugins/chrome/scripts/extension-ids.json",
              installManifest: "marketplace/plugins/chrome/scripts/installManifest.mjs",
              nativeHost: {
                artifactMinimumMacOSVersion: "13.0",
                hostName: "com.openai.codexextension",
                path: "marketplace/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
                productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
              },
              plugin: {
                id: "chrome@openai-bundled",
                manifest: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
                root: "marketplace/plugins/chrome",
                version: "1.0.0",
              },
              status: "available",
            },
            iab: { status: "available" },
          },
        },
        computerUse: {
          appBundle: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app",
          appBundleIdentifier: "com.openai.CodexComputerUse",
          artifactMinimumMacOSVersion: "14.4",
          ipcProtocol: "CodexComputerUseIPC-5",
          plugin: {
            docs: "marketplace/plugins/computer-use/docs/SKILL.md",
            id: "computer-use@openai-bundled",
            manifest: "marketplace/plugins/computer-use/manifest.json",
            marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
            marketplaceRoot: "marketplace",
            nodeModuleDirs: ["runtime/lib/node_modules"],
            root: "marketplace/plugins/computer-use",
            version: "1.0.1000550",
          },
          productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
          rpcService: "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
          serviceExecutable:
            "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
          status: "available",
        },
        nativePip: {
          addon: "native/sky.node",
          artifactMinimumMacOSVersion: "13.0",
          controlAssets: [
            "native/remote-hosted-pip/pop-in-window-egg@3x.png",
            "native/remote-hosted-pip/pop-out-window-egg@3x.png",
          ],
          exports: {
            expectedExportCount: BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS.length,
            expectedExports: [...BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS],
            groups: BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
          },
          productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
          status: "available",
        },
      },
      codexCompatibilityVersion: "0.144.6",
      desktopBuild: "test-build",
      desktopBuildNumber: "123",
      entrypoints: {
        codexCli: "bin/codex",
        node: "bin/node",
        nodeRepl: "bin/node_repl",
        peerAuthorization: "peer/authorize.node",
      },
      trust: {
        chromeSigningTeamId: "TESTTEAM",
        computerUseSigningTeamId: "TESTTEAM",
        nodeApiVersion: "127",
        signingTeamId: "TESTTEAM",
      },
      runtimeVersions: {
        codexCli: "0.144.6",
        cuaRuntime: "0.0.6/test",
        node: "24.0.0",
        peerAuthorization: "test",
      },
      schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
      supportedBackends: ["iab", "chrome"],
      targetArch: "arm64",
      targetPlatform: "darwin",
    };
  }

  describe("parseBrowserRuntimeManifest", () => {
    test("accepts a complete architecture-bound runtime contract", () => {
      expect(parseBrowserRuntimeManifest(makeManifest())).toEqual(makeManifest());
    });

    test("rejects unsupported targets", () => {
      expect(parseBrowserRuntimeManifest({ ...makeManifest(), targetArch: "x64" })).toBeNull();
      expect(
        parseBrowserRuntimeManifest({ ...makeManifest(), targetPlatform: "linux" }),
      ).toBeNull();
    });

    test("admits Computer Use through its trusted RPC service without a separate client launcher", () => {
      const manifest = makeManifest();
      if (manifest.capabilities.computerUse.status !== "available") {
        throw new Error("Computer Use fixture is unavailable");
      }
      manifest.artifacts = manifest.artifacts.filter(
        (artifact) => artifact.path !== "marketplace/plugins/computer-use/client.mjs",
      );

      expect(parseBrowserRuntimeManifest(manifest)).toEqual(manifest);
    });

    test("requires the current schema at load time", () => {
      expect(parseBrowserRuntimeManifest({ ...makeManifest(), schemaVersion: 7 })).toBeNull();
    });

    test("rejects a native add-on contract without its exact export set", () => {
      const manifest = structuredClone(makeManifest()) as unknown as {
        capabilities: { nativePip: { exports: { expectedExports?: string[] } } };
      };
      delete manifest.capabilities.nativePip.exports.expectedExports;

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });

    test("rejects a native add-on contract whose count or order differs from the exact set", () => {
      const wrongCount = structuredClone(makeManifest());
      wrongCount.capabilities.nativePip.exports.expectedExportCount += 1;
      expect(parseBrowserRuntimeManifest(wrongCount)).toBeNull();

      const wrongOrder = structuredClone(makeManifest());
      wrongOrder.capabilities.nativePip.exports.expectedExports.reverse();
      expect(parseBrowserRuntimeManifest(wrongOrder)).toBeNull();
    });

    test("rejects a native add-on contract with an incomplete capability group", () => {
      const manifest = structuredClone(makeManifest());
      (
        manifest.capabilities.nativePip.exports.groups as unknown as { presentation: string[] }
      ).presentation = [];

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });

    test("rejects paths that escape the bundle root", () => {
      const manifest = makeManifest();
      manifest.browserPlugin.client = "../client.js";

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });

    test("rejects plugin entrypoints missing from the artifact closure", () => {
      const manifest = makeManifest();
      manifest.artifacts = manifest.artifacts.filter(
        (artifact) => artifact.path !== manifest.browserPlugin.client,
      );

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });

    test("rejects binary entrypoints built for another architecture", () => {
      const manifest = makeManifest();
      manifest.artifacts[0] = { ...manifest.artifacts[0]!, architecture: "x64" };

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });

    test("rejects trust-all backend declarations and duplicate backends", () => {
      const manifest = makeManifest() as unknown as Record<string, unknown>;
      manifest.supportedBackends = ["iab", "iab"];

      expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
    });
  });
});

describe("browser use host capability", () => {
  describe("resolveBrowserUseHostCapability", () => {
    test("enables the packaged macOS host with production peer authorization", () => {
      expect(
        resolveBrowserUseHostCapability({
          browserRuntimeStatus: "available",
          environment: {},
          isPackaged: true,
          platform: "darwin",
        }),
      ).toEqual({
        availableBackends: ["iab"],
        peerAuthorizationMode: "packaged",
        status: "available",
      });
    });

    test("keeps development peer verification separate from unpackaged host availability", () => {
      expect(
        resolveBrowserUseHostCapability({
          browserRuntimeStatus: "available",
          environment: {
            [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
          },
          isPackaged: false,
          platform: "darwin",
        }),
      ).toEqual({
        availableBackends: ["iab"],
        peerAuthorizationMode: "development",
        status: "available",
      });

      expect(
        resolveBrowserUseHostCapability({
          browserRuntimeStatus: "available",
          environment: {},
          isPackaged: false,
          platform: "darwin",
        }),
      ).toEqual({
        availableBackends: ["iab"],
        peerAuthorizationMode: "disabled",
        status: "available",
      });
    });

    test("fails closed when the runtime or platform is unsupported", () => {
      expect(
        resolveBrowserUseHostCapability({
          browserRuntimeStatus: "unavailable",
          environment: {
            [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
          },
          isPackaged: false,
          platform: "darwin",
        }),
      ).toMatchObject({
        reason: "runtime-unavailable",
        status: "unavailable",
      });
      expect(
        resolveBrowserUseHostCapability({
          browserRuntimeStatus: "available",
          environment: {
            [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
          },
          isPackaged: false,
          platform: "linux",
        }),
      ).toMatchObject({
        reason: "platform-unsupported",
        status: "unavailable",
      });
    });
  });

  test("Windows Browser availability depends on verified native transport and local execution", () => {
    const local = {
      browserRuntimeStatus: "available",
      environment: {},
      isPackaged: false,
      platform: "win32",
    } as const;
    expect(resolveBrowserUseHostCapability(local)).toMatchObject({ status: "unavailable" });
    expect(
      resolveBrowserUseHostCapability({ ...local, windowsTransportReady: true }),
    ).toMatchObject({
      status: "available",
      peerAuthorizationMode: "packaged",
      availableBackends: ["iab"],
    });
    const optIn = {
      ...local,
      environment: { [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1" },
      windowsTransportReady: true,
    };
    expect(resolveBrowserUseHostCapability(optIn)).toMatchObject({
      peerAuthorizationMode: "development",
    });
    expect(resolveBrowserUseHostCapability({ ...optIn, isPackaged: true })).toMatchObject({
      peerAuthorizationMode: "packaged",
    });
    for (const execution of ["remote", "wsl"] as const)
      expect(resolveBrowserUseHostCapability({ ...optIn, execution })).toMatchObject({
        status: "unavailable",
      });
  });
});

describe("browser webmcp model context", () => {
  function createContext(
    overrides: Partial<Parameters<typeof createBrowserWebMcpModelContext>[0]> = {},
  ) {
    return createBrowserWebMcpModelContext({
      location: {
        href: "https://example.com/catalog",
        origin: "https://example.com",
        protocol: "https:",
      },
      isSecureContext: () => true,
      isOriginAgentCluster: () => true,
      ...overrides,
    });
  }
  const tool: BrowserWebMcpTool = {
    name: "search_catalog",
    description: "Search products",
    title: "Search catalog",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: (input) => ({ received: input }),
  };

  describe("Browser document WebMCP", () => {
    test("lists document-scoped registrations and executes a serialized snapshot input", async () => {
      const context = createContext();
      await context.registerTool(tool);
      const [registered] = context.codexGetTools();
      expect(registered).toMatchObject({
        name: tool.name,
        title: tool.title,
        origin: "https://example.com",
        pageUrl: "https://example.com/catalog",
        inputSchema: JSON.stringify(tool.inputSchema),
      });
      expect(await context.getTools()).toEqual([
        expect.not.objectContaining({ registrationId: expect.anything() }),
      ]);
      expect(await context.codexExecuteTool(registered!, '{"query":"lamp"}')).toBe(
        '{"received":{"query":"lamp"}}',
      );
      expect(createContext().codexGetTools()).toEqual([]);
    });

    test("aborting removes the registration and a replacement rejects an older snapshot", async () => {
      const changed = vi.fn();
      const context = createContext({ onToolsChanged: changed });
      const controller = new AbortController();
      await context.registerTool(tool, { signal: controller.signal });
      const [old] = context.codexGetTools();
      controller.abort();
      expect(context.codexGetTools()).toEqual([]);
      await context.registerTool(tool);
      expect(changed).toHaveBeenCalledTimes(3);
      await expect(context.codexExecuteTool(old!, "{}")).rejects.toThrow("stale");
      expect(await context.codexExecuteTool(context.codexGetTools()[0]!, "{}")).toBe(
        '{"received":{}}',
      );
    });

    test("rejects insecure or non-origin-isolated documents but permits secure file documents", async () => {
      await expect(
        createContext({ isSecureContext: () => false }).registerTool(tool),
      ).rejects.toMatchObject({ name: "SecurityError" });
      await expect(
        createContext({ isOriginAgentCluster: () => false }).registerTool(tool),
      ).rejects.toMatchObject({ name: "SecurityError" });
      const local = createContext({
        location: { protocol: "file:", href: "file:///test.html", origin: "null" },
        isOriginAgentCluster: () => false,
      });
      await expect(local.registerTool(tool)).resolves.toBeUndefined();
    });

    test("validates names, duplicates and JSON boundaries before invoking page callbacks", async () => {
      const execute = vi.fn(() => undefined);
      const context = createContext();
      await expect(
        context.registerTool({ ...tool, name: "bad name", execute }),
      ).rejects.toMatchObject({ name: "InvalidStateError" });
      await context.registerTool({ ...tool, execute });
      await expect(context.registerTool(tool)).rejects.toThrow("already registered");
      const [registered] = context.codexGetTools();
      await expect(context.codexExecuteTool(registered!, "null")).rejects.toThrow("object input");
      await expect(context.codexExecuteTool(registered!, "{")).rejects.toThrow(
        "JSON-stringified input",
      );
      expect(execute).not.toHaveBeenCalled();
      expect(await context.executeTool({ name: tool.name }, {})).toBe("null");
    });
  });
});

describe("Chrome control settings snapshot", () => {
  test("accepts the bounded five-gate projection and rejects malformed renderer events", () => {
    expect(
      isChromeControlRuntimeSnapshot({
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: true,
        providerReady: false,
        reason: "Waiting for extension",
        requested: true,
        revision: 4,
        status: "extension-disconnected",
      }),
    ).toBe(true);
    expect(
      isChromeControlRuntimeSnapshot({
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: true,
        providerReady: false,
        reason: "x".repeat(513),
        requested: true,
        revision: Number.POSITIVE_INFINITY,
        status: "ready-ish",
      }),
    ).toBe(false);
  });
});
