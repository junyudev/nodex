import { describe, expect, it } from "vitest";
import {
  acpPluginSkillInstructions,
  acpPluginTransport,
  acpSessionMcpServers,
} from "./pluginDelivery.ts";

describe("ACP Plugin transport", () => {
  it.each([
    ["advertises HTTP", { http: true }, "http"],
    ["explicitly declines HTTP", { http: false }, "stdio"],
    ["only advertises ACP", { acp: true }, "stdio"],
    ["only advertises SSE", { sse: true }, "stdio"],
    ["has no MCP declaration", undefined, "stdio"],
  ] as const)("%s", (_, mcpCapabilities, expected) => {
    expect(acpPluginTransport(mcpCapabilities ? { mcpCapabilities } : {})).toBe(expected);
  });
});

it("delivers every plugin server, bridged over stdio when the agent does not advertise HTTP", () => {
  const catalog = { name: "nodex_plugin_skills", url: "http://catalog", bearerToken: "c" };
  const server = {
    pluginId: "notes@local",
    serverKey: "notes",
    name: "nodex-notes",
    url: "http://notes",
    bearerToken: "n",
  };
  const plugins = {
    delivery: {
      revision: "1",
      skillsRoot: null,
      skills: [],
      pluginIds: ["notes@local"],
      codexDisabledPluginIds: [],
      skillCatalog: catalog,
      mcpServers: [server],
    },
    stdio: ({ name }: { readonly name: string }) => ({
      name,
      command: "bridge",
      args: [],
      env: [],
    }),
  };
  expect(acpSessionMcpServers({ capabilities: {}, servers: [], plugins })).toEqual([
    { name: catalog.name, command: "bridge", args: [], env: [] },
    { name: server.name, command: "bridge", args: [], env: [] },
  ]);
  expect(
    acpSessionMcpServers({
      capabilities: { mcpCapabilities: { http: true } },
      servers: [],
      plugins,
    }).map(({ name }) => name),
  ).toEqual([catalog.name, server.name]);
});

it("guides skill discovery and supporting file reads only when the catalog is attached", () => {
  expect(acpPluginSkillInstructions(false)).toBeUndefined();
  expect(acpPluginSkillInstructions(true)).toMatch(
    /nodex_plugin_skills[\s\S]*list_plugin_skills[\s\S]*installationId[\s\S]*read_plugin_skill[\s\S]*file/,
  );
});
