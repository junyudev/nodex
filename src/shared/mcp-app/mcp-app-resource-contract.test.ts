import { describe, expect, test } from "vite-plus/test";
import {
  getMcpAppHtmlByteSize,
  normalizeMcpCspDomain,
  resolveMcpRenderableResource,
  resolveMcpWidgetMetadata,
} from "./mcp-app-resource-contract";

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
