import { expect, test, describe } from "vite-plus/test";
import { parseMcpAppLinkRequest } from "./mcp-app-navigation";
import {
  getMcpAppHtmlByteSize,
  normalizeMcpCspDomain,
  resolveMcpRenderableResource,
  resolveMcpWidgetMetadata,
} from "./mcp-app-resource-contract";
import {
  MCP_APP_REQUIRED_GUEST_PORT_NAMES,
  appendMcpAppSandboxInitId,
  buildMcpAppSandboxPartition,
  buildMcpAppSandboxSourceUrl,
  deriveMcpAppSandboxIdentity,
  parseMcpAppSandboxGuestInitMessage,
  parseMcpAppSandboxPartition,
  parseMcpAppSandboxSourceUrl,
} from "./mcp-app-sandbox-contract";
import type { ProtocolListMcpServerStatusResponse } from "../types";
import {
  createMcpAppScopeSnapshot,
  requireMcpAppScopedResource,
  requireMcpAppScopedTool,
} from "./mcp-app-scope";

describe("mcp app navigation", () => {
  test.each([
    "https://example.com/",
    "nodex://pages/page-1",
    "nodex://sessions/session-1",
    "nodex://views/view-1",
  ])("admits guest destination %s with an explicit popup mode", (href) => {
    expect(parseMcpAppLinkRequest({ href, openMode: "popup" })).toEqual({
      href,
      openMode: "popup",
    });
  });
  test.each([
    null,
    {},
    { href: "https://example.com", openMode: "window" },
    { href: "http://localhost:3000" },
    { href: "file:///tmp/report.html" },
    { href: "nodex://unknown/id" },
    { href: "codex://pages/id" },
    { href: "https://user:pass@example.com/" },
  ])("rejects malformed or unsupported guest destination %j", (value) => {
    expect(() => parseMcpAppLinkRequest(value)).toThrow();
  });
});

describe("MCP App resource contract", () => {
  test("normalizes resource CSP aliases and merges resource domains into connect domains", () => {
    const metadata = resolveMcpWidgetMetadata({
      ui: {
        csp: {
          connectDomains: ["https://api.example.com"],
          frameDomains: ["https://frames.example.com"],
        },
        permissions: { camera: true, clipboardWrite: true },
      },
      "openai/widgetCSP": {
        resource_domains: ["https://cdn.example.com", "blob:"],
        base_uri_domains: ["https://base.example.com"],
      },
    });

    expect(metadata.csp).toEqual({
      connectDomains: ["https://api.example.com", "https://cdn.example.com", "blob:"],
      resourceDomains: ["https://cdn.example.com", "blob:"],
      frameDomains: ["https://frames.example.com"],
      baseUriDomains: ["https://base.example.com"],
      includeDefaultDomains: false,
      isTrusted: true,
    });
    expect(metadata.requestedPermissions.camera).toBe(true);
    expect(metadata.requestedPermissions.clipboardWrite).toBe(true);
  });

  test("returns the complete untrusted CSP contract when metadata is absent", () => {
    expect(resolveMcpWidgetMetadata(null).csp).toEqual({
      baseUriDomains: [],
      connectDomains: [],
      frameDomains: [],
      includeDefaultDomains: false,
      isTrusted: false,
      resourceDomains: [],
    });
  });

  test("rejects unsafe CSP domains and admits only scoped special schemes", () => {
    expect(normalizeMcpCspDomain("https://example.com; script-src *", { kind: "connect" })).toBe(
      null,
    );
    expect(normalizeMcpCspDomain("https://user:secret@example.com", { kind: "connect" })).toBe(
      null,
    );
    expect(normalizeMcpCspDomain("wss://events.example.com", { kind: "connect" })).toBe(
      "wss://events.example.com",
    );
    expect(normalizeMcpCspDomain("blob:", { kind: "connect" })).toBe("blob:");
    expect(normalizeMcpCspDomain("blob:", { kind: "resource" })).toBe("blob:");
    expect(normalizeMcpCspDomain("http://localhost:5173", { kind: "connect" })).toBe(null);
    expect(normalizeMcpCspDomain("static.example.com", { kind: "resource" })).toBe(
      "https://static.example.com",
    );
    expect(
      normalizeMcpCspDomain("http://localhost:5173", {
        kind: "connect",
        allowLocalDevelopment: true,
      }),
    ).toBe("http://localhost:5173");
  });

  test("supports skybridge HTML and falls back to listing metadata", () => {
    const resource = resolveMcpRenderableResource(
      "ui://calendar/widget",
      {
        contents: [
          {
            uri: "ui://calendar/widget",
            mimeType: "text/html+skybridge",
            text: "<main>Calendar</main>",
          },
        ],
        originCallId: null,
      },
      {
        "openai/widgetHeightHint": 420,
      },
    );

    expect(resource?.mimeType).toBe("text/html+skybridge");
    expect(resource?.metadata.heightHint).toBe(420);
  });

  test("measures HTML by UTF-8 bytes", () => {
    expect(getMcpAppHtmlByteSize("é")).toBe(2);
  });

  test("decodes base64 resource bodies as UTF-8 and merges permission fallback", () => {
    const html = "<main>日历</main>";
    const bytes = new TextEncoder().encode(html);
    const binary = String.fromCharCode(...bytes);
    const resource = resolveMcpRenderableResource(
      "ui://calendar/widget",
      {
        contents: [
          {
            uri: "ui://calendar/widget",
            mimeType: "text/html",
            blob: btoa(binary),
            _meta: { ui: { permissions: { camera: true } } },
          },
        ],
        originCallId: null,
      },
      {
        ui: { permissions: { microphone: true } },
      },
    );

    expect(resource?.html).toBe(html);
    expect(resource?.metadata.requestedPermissions).toMatchObject({
      camera: true,
      microphone: true,
    });
  });
});

describe("MCP App sandbox contract", () => {
  test("derives stable isolated identities", async () => {
    const input = {
      locale: "en-US",
      originScope: { kind: "mcp_server", server: "calendar" } as const,
      widgetDomain: "https://calendar.example.com",
    };
    const first = await deriveMcpAppSandboxIdentity(input);
    const second = await deriveMcpAppSandboxIdentity(input);
    const other = await deriveMcpAppSandboxIdentity({
      ...input,
      locale: "zh-CN",
    });

    expect(first).toEqual(second);
    expect(first.subdomain.length).toBeLessThanOrEqual(63);
    expect(first.subdomain).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
    expect(first.sandboxId).toMatch(/^source-[0-9a-f]{16}$/u);
    expect(first.sandboxId).not.toBe(other.sandboxId);
    expect(first.subdomain).toBe(other.subdomain);
  });

  test("round-trips source and partition identities", () => {
    const sandboxId = "source-0123456789abcdef";
    const partition = buildMcpAppSandboxPartition(sandboxId);
    const baseSource = buildMcpAppSandboxSourceUrl({
      subdomain: "mcp-calendar-fixture",
      locale: "zh-CN",
    });
    const source = appendMcpAppSandboxInitId(baseSource, "init_fixture_1");

    expect(parseMcpAppSandboxPartition(partition)).toBe(sandboxId);
    expect(parseMcpAppSandboxSourceUrl(source)).toMatchObject({
      initId: "init_fixture_1",
      locale: "zh-CN",
      subdomain: "mcp-calendar-fixture",
    });
    expect(parseMcpAppSandboxSourceUrl(baseSource)?.initId).toBe(null);
  });

  test("accepts the trusted remote transport and rejects extra query keys", () => {
    const source = appendMcpAppSandboxInitId(
      buildMcpAppSandboxSourceUrl({
        subdomain: "mcp-calendar-fixture",
        locale: "en-US",
      }),
      "init_fixture_1",
    );
    const withExtra = new URL(source);
    withExtra.searchParams.set("extra", "1");

    expect(parseMcpAppSandboxSourceUrl(withExtra.toString())).toBe(null);
    expect(parseMcpAppSandboxSourceUrl(source.replace("nodex-mcp-sandbox:", "https:"))).not.toBe(
      null,
    );
    expect(parseMcpAppSandboxSourceUrl(source.replace("nodex-mcp-sandbox:", "ftp:"))).toBe(null);
  });

  test("accepts only the enumerated complete port set", () => {
    const valid = {
      type: "init",
      initId: "init-fixture",
      origin: "nodex-mcp-sandbox://mcp-fixture.web-sandbox.oaiusercontent.com",
      portNames: [...MCP_APP_REQUIRED_GUEST_PORT_NAMES],
    };

    expect(parseMcpAppSandboxGuestInitMessage(valid)?.portNames).toEqual(
      MCP_APP_REQUIRED_GUEST_PORT_NAMES,
    );
    expect(
      parseMcpAppSandboxGuestInitMessage({
        ...valid,
        portNames: [...MCP_APP_REQUIRED_GUEST_PORT_NAMES.slice(1)],
      }),
    ).toBe(null);
    expect(
      parseMcpAppSandboxGuestInitMessage({
        ...valid,
        portNames: [...MCP_APP_REQUIRED_GUEST_PORT_NAMES, "invoke"],
      }),
    ).toBe(null);
  });
});

describe("mcp app scope", () => {
  function statuses(server = "calendar"): ProtocolListMcpServerStatusResponse {
    return {
      data: [
        {
          toolListMeta: null,
          name: server,
          runtimeStatus: null,
          pluginId: null,
          httpOrigin: null,
          serverInfo: null,
          serverCapabilities: null,
          toolsError: null,
          authStatus: "unsupported",
          resources: [{ name: "widget", uri: "ui://calendar/widget" }],
          resourceTemplates: [],
          tools: {
            list: {
              name: "list",
              inputSchema: { type: "object" },
              _meta: { ui: { resourceUri: "ui://calendar/widget" } },
            },
            upload: {
              name: "upload",
              inputSchema: { type: "object" },
              _meta: { "openai/fileParams": ["file"] },
            },
          },
        },
      ],
      nextCursor: null,
    };
  }

  describe("MCP App scope", () => {
    test("removes tools that accept file parameters", () => {
      const scope = createMcpAppScopeSnapshot({
        currentToolName: "list",
        originResourceUri: "ui://calendar/widget",
        server: "calendar",
        statuses: statuses(),
        threadId: "thread-1",
      });

      expect([...scope.allowedTools.keys()]).toEqual(["list"]);
      expect(() => requireMcpAppScopedTool(scope, "upload")).toThrow(/outside its scope/u);
    });

    test("binds codex_apps resources to the origin widget", () => {
      const scope = createMcpAppScopeSnapshot({
        currentToolName: "list",
        originResourceUri: "ui://calendar/widget",
        server: "codex_apps",
        statuses: statuses("codex_apps"),
        threadId: "thread-1",
      });

      expect(() => requireMcpAppScopedResource(scope, "ui://other/widget")).toThrow(
        /outside its widget scope/u,
      );
    });

    test("scopes codex_apps tools to the trusted connector target", () => {
      const data = statuses("codex_apps");
      const server = data.data[0];
      if (!server) throw new Error("Missing test server");
      server.tools = {
        origin: {
          name: "origin",
          inputSchema: { type: "object" },
          _meta: {
            connectorId: "calendar",
            _codex_apps: { resource_uri: "/calendar/account-a/origin" },
          },
        },
        sibling: {
          name: "sibling",
          inputSchema: { type: "object" },
          _meta: {
            connectorId: "calendar",
            _codex_apps: { resource_uri: "/calendar/account-a/sibling" },
          },
        },
        otherTarget: {
          name: "otherTarget",
          inputSchema: { type: "object" },
          _meta: {
            connectorId: "calendar",
            _codex_apps: { resource_uri: "/calendar/account-b/other" },
          },
        },
      };
      const scope = createMcpAppScopeSnapshot({
        currentToolName: "origin",
        originResourceUri: "ui://calendar/widget",
        server: "codex_apps",
        statuses: data,
        threadId: "thread-1",
      });

      expect([...scope.allowedTools.keys()]).toEqual(["origin", "sibling"]);
      expect(() => requireMcpAppScopedTool(scope, "otherTarget")).toThrow(/outside its scope/u);
    });
  });
});
