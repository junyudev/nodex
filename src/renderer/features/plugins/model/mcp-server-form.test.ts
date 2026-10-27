import { describe, expect, it } from "vitest";
import {
  capitalizeLowercaseName,
  mcpServerDeclaration,
  mcpServerForm,
  mcpServerFormComplete,
  mcpServerKey,
  NEW_MCP_SERVER,
} from "./mcp-server-form";

describe("MCP server form", () => {
  it("round-trips a command server, keeping fields it doesn't edit", () => {
    const declaration = {
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: "" },
      env_vars: ["HOME"],
      cwd: "~/code",
      enabled: false,
      tool_timeout_sec: 30,
    };
    expect(mcpServerDeclaration(mcpServerForm(declaration, "docs"))).toEqual(declaration);
  });

  it("drops blank pairs and empty optional fields from an HTTP server", () => {
    const form = mcpServerForm({ url: "https://mcp.example.com/mcp", oauth: { a: 1 } }, "remote");
    expect(form.transport).toBe("streamable_http");
    const edited = {
      ...form,
      http: {
        ...form.http,
        httpHeaders: [
          { key: " X-Team ", value: " core " },
          { key: "", value: "ignored" },
        ],
      },
    };
    expect(mcpServerDeclaration(edited)).toEqual({
      url: "https://mcp.example.com/mcp",
      oauth: { a: 1 },
      http_headers: { "X-Team": "core" },
    });
  });

  it("needs a name and a command or URL before it can be saved", () => {
    const blank = mcpServerForm(NEW_MCP_SERVER, "");
    expect(mcpServerFormComplete(blank)).toBe(false);
    expect(
      mcpServerFormComplete({ ...blank, label: "Docs", stdio: { ...blank.stdio, command: "npx" } }),
    ).toBe(true);
  });

  it("derives a unique key from a new server's name", () => {
    expect(mcpServerKey("My Docs!", [])).toBe("my_docs-");
    expect(mcpServerKey("docs", ["docs", "docs-2"])).toBe("docs-3");
    expect(mcpServerKey("  ", [])).toBe("custom-server");
  });

  it("capitalizes only all-lowercase names", () => {
    expect(capitalizeLowercaseName("figma")).toBe("Figma");
    expect(capitalizeLowercaseName("GitHub")).toBe("GitHub");
  });
});
