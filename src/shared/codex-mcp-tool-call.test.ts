import { describe, expect, test } from "vite-plus/test";
import type {
  ProtocolAppInfo,
  ProtocolListMcpServerStatusResponse,
  ProtocolMcpToolCallItem,
  ProtocolMcpToolCallResult,
} from "./types";
import { projectCodexCanonicalTurnItemViews } from "./codex-canonical-item-projector";
import {
  completeCodexMcpToolCallForTurn,
  CODEX_BROWSER_USE_CHROME_LOGO_DATA_URL,
  formatCodexMcpVisualSourceName,
  normalizeCodexMcpToolCallContentBlock,
  projectCodexMcpToolCall,
  projectCodexMcpToolCallResult,
  resolveCodexMcpAppResourceMetadata,
  resolveCodexMcpResourceUriFromMetadata,
  resolveCodexMcpToolCallSource,
  resolveCodexMcpVisualSource,
} from "./codex-mcp-tool-call";

function buildMcpItem(overrides: Partial<ProtocolMcpToolCallItem> = {}): ProtocolMcpToolCallItem {
  return {
    type: "mcpToolCall",
    id: "call-1",
    server: "docs",
    tool: "search",
    status: "inProgress",
    arguments: { query: "projection contract" },
    appContext: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
    ...overrides,
  };
}

function buildStatuses(
  tools: ProtocolListMcpServerStatusResponse["data"][number]["tools"],
): ProtocolListMcpServerStatusResponse {
  return {
    data: [
      {
        name: "docs",
        runtimeStatus: null,
        pluginId: null,
        serverInfo: null,
        tools,
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
      },
    ],
    nextCursor: null,
  };
}

function buildApp(
  id: string,
  name: string,
  overrides: Partial<ProtocolAppInfo> = {},
): ProtocolAppInfo {
  return {
    id,
    name,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

describe("Codex MCP tool-call projection", () => {
  test("keeps appContext only on canonical raw state and projects its URI with exact precedence", () => {
    const appContext = {
      connectorId: "connector-docs",
      linkId: "link-1",
      resourceUri: "ui://context.html",
      appName: "Docs",
      templateId: "template-1",
      actionName: "Search",
    };
    const item = buildMcpItem({
      appContext,
      mcpAppResourceUri: "ui://deprecated.html",
      readOnlyHint: true,
    });
    const normalized = projectCodexCanonicalTurnItemViews({
      threadId: "thread-1",
      turnId: "turn-1",
      items: [item],
      observedAtMs: 1_000,
      turnStatus: "inProgress",
    })[0];

    expect(normalized?.rawItem).toBe(item);
    expect(item.appContext).toBe(appContext);
    expect(normalized?.mcpToolCall?.mcpAppResourceUri).toBe("ui://context.html");
    expect(normalized?.mcpToolCall?.readOnlyHint).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(normalized?.mcpToolCall, "mcpAppResourceUri")).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(normalized?.mcpToolCall, "appContext")).toBe(false);

    const live = projectCodexCanonicalTurnItemViews({
      threadId: "thread-1",
      turnId: "turn-1",
      items: [item],
      observedAtMs: 1_000,
      turnStatus: "completed",
    })[0];
    expect(live?.rawItem).toBe(item);
    expect(live?.mcpToolCall?.invocation.arguments).toBe(item.arguments);
    expect(live?.mcpToolCall?.completed).toBe(true);

    const deprecated = projectCodexMcpToolCall(
      buildMcpItem({
        mcpAppResourceUri: "ui://deprecated.html",
      }),
      "inProgress",
    );
    expect(deprecated.mcpAppResourceUri).toBe("ui://deprecated.html");

    const absent = projectCodexMcpToolCall(buildMcpItem(), "inProgress");
    expect(Object.prototype.hasOwnProperty.call(absent, "mcpAppResourceUri")).toBe(true);
    expect(absent.mcpAppResourceUri).toBe(undefined);
  });

  test("uses protocol error precedence while preserving raw identities and independent source metadata", () => {
    const result: ProtocolMcpToolCallResult = {
      content: [{ type: "text", text: "success" }],
      structuredContent: { ok: true },
      _meta: {
        "codex/toolSurface": {
          kind: "browserUse",
          backend: "cdp",
        },
      },
    };
    const error = { message: "tool failed" };
    const view = projectCodexMcpToolCall(
      buildMcpItem({
        server: "node_repl",
        result,
        error,
      }),
      "inProgress",
    );

    expect(view.result?.type).toBe("error");
    expect(view.result?.type === "error" ? view.result.rawError : null).toBe(error);
    expect(view.source?.kind).toBe("browserUse");
    expect(view.source?.kind === "browserUse" ? view.source.backend : null).toBe("cdp");

    const success = projectCodexMcpToolCallResult(result, null);
    expect(success?.type).toBe("success");
    expect(success?.type === "success" ? success.raw : null).toBe(result);
    expect(success?.type === "success" ? success.structuredContent : null).toBe(
      result.structuredContent,
    );
  });

  test("normalizes only schema-valid content and keeps unknown raw block identity", () => {
    const invalidImage = { type: "image", data: "encoded-without-mime" };
    const invalid = normalizeCodexMcpToolCallContentBlock(invalidImage);
    expect(invalid.type).toBe("unknown");
    expect(invalid.type === "unknown" ? invalid.raw : null).toBe(invalidImage);

    const rawResource = {
      type: "resource",
      resource: {
        uri: "ui://embedded.html",
        mimeType: "text/html",
        text: "<main>Embedded</main>",
        annotations: {
          audience: ["assistant"],
          priority: 0.5,
          lastModified: "2026-07-10",
          ignored: true,
        },
        _meta: { ignoredByProjection: true },
      },
      _meta: { ignoredByProjection: true },
    };
    const resource = normalizeCodexMcpToolCallContentBlock(rawResource);
    expect(resource.type).toBe("embedded_resource");
    expect(resource.type === "embedded_resource" ? resource.resource.uri : null).toBe(
      "ui://embedded.html",
    );
    expect(
      resource.type === "embedded_resource"
        ? resource.resource.annotations?.audience?.join(",")
        : null,
    ).toBe("assistant");
    expect(
      resource.type === "embedded_resource"
        ? Object.prototype.hasOwnProperty.call(resource.resource, "meta")
        : true,
    ).toBe(false);
    expect(
      resource.type === "embedded_resource"
        ? Object.prototype.hasOwnProperty.call(resource.resource, "name")
        : false,
    ).toBe(true);
    expect(
      resource.type === "embedded_resource"
        ? Object.prototype.hasOwnProperty.call(resource.resource.annotations, "ignored")
        : true,
    ).toBe(false);

    const partiallyValidAnnotations = normalizeCodexMcpToolCallContentBlock({
      type: "text",
      text: "annotated",
      annotations: {
        audience: [],
        priority: 1,
      },
    });
    expect(partiallyValidAnnotations.type).toBe("text");
    expect(
      partiallyValidAnnotations.type === "text"
        ? Object.prototype.hasOwnProperty.call(partiallyValidAnnotations.annotations, "audience")
        : false,
    ).toBe(true);
    expect(
      partiallyValidAnnotations.type === "text"
        ? partiallyValidAnnotations.annotations?.audience
        : null,
    ).toBe(undefined);
    expect(
      partiallyValidAnnotations.type === "text"
        ? partiallyValidAnnotations.annotations?.priority
        : null,
    ).toBe(1);
  });

  test("marks an in-progress call complete when its owning turn is terminal", () => {
    const item = buildMcpItem({ status: "inProgress" });
    const active = projectCodexMcpToolCall(item, "inProgress");
    expect(active.completed).toBe(false);
    expect(completeCodexMcpToolCallForTurn(active, "completed").completed).toBe(true);
    expect(projectCodexMcpToolCall(item, "completed").completed).toBe(true);
    expect(projectCodexMcpToolCall(item, "interrupted").completed).toBe(true);
    expect(projectCodexMcpToolCall(item, "failed").completed).toBe(true);
  });

  test("accepts node_repl tool-surface variants and rejects invalid or unrelated metadata", () => {
    expect(
      resolveCodexMcpToolCallSource("node_repl", {
        "codex/toolSurface": { kind: "browserUse", backend: "iab" },
      })?.kind,
    ).toBe("browserUse");
    expect(
      resolveCodexMcpToolCallSource("node_repl", {
        "codex/toolSurface": { kind: "browserUse", backend: "chrome" },
      })?.kind,
    ).toBe("browserUse");
    const nullApp = resolveCodexMcpToolCallSource("node_repl", {
      "codex/toolSurface": { kind: "computerUse", app: null },
    });
    expect(nullApp?.kind).toBe("computerUse");
    expect(nullApp?.kind === "computerUse" ? nullApp.app : undefined).toBe(null);
    const app = resolveCodexMcpToolCallSource("node_repl", {
      "codex/toolSurface": {
        kind: "computerUse",
        app: { kind: "appId", appId: "com.apple.Safari" },
      },
    });
    expect(app?.kind === "computerUse" && app.app?.kind === "appId" ? app.app.appId : null).toBe(
      "com.apple.Safari",
    );
    const displayName = resolveCodexMcpToolCallSource("node_repl", {
      "codex/toolSurface": {
        kind: "computerUse",
        app: { kind: "displayName", displayName: "Safari" },
      },
    });
    expect(
      displayName?.kind === "computerUse" && displayName.app?.kind === "displayName"
        ? displayName.app.displayName
        : null,
    ).toBe("Safari");
    expect(
      resolveCodexMcpToolCallSource("node_repl", {
        "codex/toolSurface": { kind: "computerUse", app: { kind: "appId", appId: "" } },
      }),
    ).toBe(null);
    expect(
      resolveCodexMcpToolCallSource("docs", {
        "codex/toolSurface": { kind: "browserUse", backend: "chrome" },
      }),
    ).toBe(null);
  });
});

describe("Codex MCP app resource metadata", () => {
  test("uses exact URI key order without trimming or invented aliases", () => {
    expect(
      resolveCodexMcpResourceUriFromMetadata({
        ui: { resourceUri: "" },
        "ui/resourceUri": "ui://flat.html",
        "openai/outputTemplate": "ui://template.html",
      }),
    ).toBe("");
    expect(
      resolveCodexMcpResourceUriFromMetadata({
        "ui/resourceUri": "ui://flat.html",
        "openai/outputTemplate": "ui://template.html",
      }),
    ).toBe("ui://flat.html");
    expect(
      resolveCodexMcpResourceUriFromMetadata({
        "openai/outputTemplate": " ui://untrimmed.html ",
      }),
    ).toBe(" ui://untrimmed.html ");
    expect(
      resolveCodexMcpResourceUriFromMetadata({
        resourceUri: "ui://invented-alias.html",
      }),
    ).toBe(null);
  });

  test("prefers direct tool metadata, then named tool metadata, then raw result metadata", () => {
    const result: ProtocolMcpToolCallResult = {
      content: [],
      structuredContent: null,
      _meta: { "openai/outputTemplate": "ui://result.html" },
    };
    const payload = projectCodexMcpToolCall(buildMcpItem({ result }), "completed");
    const direct = buildStatuses({
      search: {
        name: "different-name",
        inputSchema: {},
        _meta: { ui: { resourceUri: "ui://direct.html" } },
      },
      alias: {
        name: "search",
        inputSchema: {},
        _meta: { "ui/resourceUri": "ui://named.html" },
      },
    });
    expect(
      resolveCodexMcpAppResourceMetadata({
        payload,
        mcpServerStatuses: direct,
      })?.resourceUri,
    ).toBe("ui://direct.html");

    const named = buildStatuses({
      search: {
        name: "different-name",
        inputSchema: {},
      },
      alias: {
        name: "search",
        inputSchema: {},
        _meta: { "ui/resourceUri": "ui://named.html" },
      },
    });
    expect(
      resolveCodexMcpAppResourceMetadata({
        payload,
        mcpServerStatuses: named,
      })?.resourceUri,
    ).toBe("ui://named.html");
    expect(
      resolveCodexMcpAppResourceMetadata({
        payload,
        mcpServerStatuses: null,
      })?.resourceUri,
    ).toBe("ui://result.html");
  });
});

describe("Codex MCP visual source projection", () => {
  const baseInput = {
    functionName: "docs__search",
    invocation: {
      server: "docs",
      tool: "search",
      arguments: {},
    },
    source: null,
  };

  test("uses exact special, AppInfo, then trimmed server precedence", () => {
    const docsApp = buildApp("connector_docs", "Docs", {
      logoUrl: "https://example.test/docs-light.png",
      logoUrlDark: "https://example.test/docs-dark.png",
    });
    const browser = resolveCodexMcpVisualSource({
      ...baseInput,
      resolvedApps: [docsApp],
      source: { kind: "browserUse", backend: "chrome" },
    });
    expect(browser?.key).toBe("browser-use:chrome");
    expect(browser?.logoUrl).toBe(CODEX_BROWSER_USE_CHROME_LOGO_DATA_URL);
    expect(browser?.name).toBe("Chrome");

    const app = resolveCodexMcpVisualSource({ ...baseInput, resolvedApps: [docsApp] });
    expect(app?.key).toBe("app:connector_docs");
    expect(app?.logoUrl).toBe("https://example.test/docs-light.png");
    expect(app?.logoUrlDark).toBe("https://example.test/docs-dark.png");

    const server = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: { ...baseInput.invocation, server: "  openai_docs  " },
      resolvedApps: [],
    });
    expect(server?.key).toBe("server:openai_docs");
    expect(server?.name).toBe("OpenAI Docs");
    expect(
      resolveCodexMcpVisualSource({
        ...baseInput,
        invocation: { ...baseInput.invocation, server: "   " },
        resolvedApps: [],
      }),
    ).toBe(null);
  });

  test("matches the first AppInfo by exact alias and prefix token rules", () => {
    const first = buildApp("connector_google_drive", "Google Drive", {
      pluginDisplayNames: ["GDrive"],
    });
    const second = buildApp("drive", "Drive");

    const exactServer = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: { ...baseInput.invocation, server: "google-drive" },
      resolvedApps: [first, second],
    });
    expect(exactServer?.key).toBe("app:connector_google_drive");

    const toolPrefix = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: { ...baseInput.invocation, server: "unrelated", tool: "gdrive_search_files" },
      resolvedApps: [first, second],
    });
    expect(toolPrefix?.key).toBe("app:connector_google_drive");

    const functionPartPrefix = resolveCodexMcpVisualSource({
      ...baseInput,
      functionName: "host__google_drive_search",
      invocation: { ...baseInput.invocation, server: "unrelated", tool: "search" },
      resolvedApps: [first, second],
    });
    expect(functionPartPrefix?.key).toBe("app:connector_google_drive");
  });

  test("keeps browser, computer-use, and native app identities distinct", () => {
    const browser = resolveCodexMcpVisualSource({
      ...baseInput,
      resolvedApps: [],
      source: { kind: "browserUse", backend: "iab" },
    });
    expect(browser?.key).toBe("browser-use");
    expect(browser?.name).toBe("browser-use");
    expect(browser?.logoUrl).toBe(null);

    const nativeChrome = resolveCodexMcpVisualSource({
      ...baseInput,
      resolvedApps: [],
      source: { kind: "computerUse", app: { kind: "appId", appId: "com.google.Chrome" } },
    });
    expect(nativeChrome?.key).toBe("native-app:chrome");
    expect(nativeChrome?.logoUrl).toBe(null);
    expect(nativeChrome?.nativeAppReference?.kind).toBe("appId");

    const genericComputer = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: { ...baseInput.invocation, server: "computer-use" },
      resolvedApps: [],
      source: { kind: "computerUse", app: null },
    });
    expect(genericComputer?.key).toBe("computer-use");
    expect(genericComputer?.name).toBe("Computer Use");
  });

  test("uses exact platform app arguments and ignores invented top-level aliases", () => {
    const macApp = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: {
        server: "computer-use",
        tool: "click",
        arguments: { currentApp: { bundleIdentifier: "com.apple.Safari" } },
      },
      platform: "macOS",
      resolvedApps: [],
    });
    expect(macApp?.key).toBe("native-app:com.apple.Safari");
    expect(macApp?.nativeAppReference?.kind).toBe("appId");

    const windowsApp = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: {
        server: "computer-use",
        tool: "click",
        arguments: { bundleId: "process:C:\\Program Files\\Google\\Chrome\\chrome.exe" },
      },
      platform: "windows",
      resolvedApps: [],
    });
    expect(windowsApp?.key).toBe("native-app:chrome");

    const ignoredAliases = resolveCodexMcpVisualSource({
      ...baseInput,
      invocation: {
        server: "computer-use",
        tool: "click",
        arguments: {
          application: "Safari",
          currentApp: "Safari",
          name: "Safari",
          title: "Safari",
        },
      },
      platform: "macOS",
      resolvedApps: [],
    });
    expect(ignoredAliases?.key).toBe("computer-use");
    expect(ignoredAliases?.nativeAppReference).toBe(null);
  });

  test("formats source names with the exact title and brand vocabulary", () => {
    expect(formatCodexMcpVisualSourceName("node_repl")).toBe("Node Repl");
    expect(formatCodexMcpVisualSourceName("github_api_and_sql")).toBe("GitHub API and SQL");
    expect(formatCodexMcpVisualSourceName("context7")).toBe("Context7");
  });
});
