import { describe, expect, test, vi } from "vite-plus/test";
import {
  createBrowserWebMcpModelContext,
  type BrowserWebMcpTool,
} from "./browser-webmcp-model-context";

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
