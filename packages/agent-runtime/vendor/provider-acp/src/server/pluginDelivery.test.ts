import { describe, expect, it } from "vitest";
import { acpPluginSkillInstructions, acpPluginTransport } from "./pluginDelivery.ts";

describe("ACP Plugin transport", () => {
  it.each([
    ["advertises HTTP", { http: true }, "http"],
    ["explicitly declines HTTP", { http: false }, "stdio"],
    ["only advertises ACP", { acp: true }, "unverified"],
    ["only advertises SSE", { sse: true }, "unverified"],
    ["has no MCP declaration", undefined, "unverified"],
  ] as const)("%s", (_, mcpCapabilities, expected) => {
    expect(acpPluginTransport(mcpCapabilities ? { mcpCapabilities } : {})).toBe(expected);
  });
});

it("guides skill discovery and supporting file reads only when the catalog is attached", () => {
  expect(acpPluginSkillInstructions(false)).toBeUndefined();
  expect(acpPluginSkillInstructions(true)).toMatch(
    /nodex_plugin_skills[\s\S]*list_plugin_skills[\s\S]*installationId[\s\S]*read_plugin_skill[\s\S]*file/,
  );
});
