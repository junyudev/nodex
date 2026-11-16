import { describe, expect, it } from "vite-plus/test";
import {
  localAgentFoundDetail,
  localAgentInstance,
  localAgentSuggestions,
} from "./local-agents-model";

const agy = {
  id: "antigravity",
  executable: "/Users/me/.local/bin/agy",
  version: "1.5.4",
  supported: true,
} as const;

describe("Agents found on this computer", () => {
  it("offers a supported Agent only until the Profile runs it", () => {
    expect(localAgentSuggestions([agy], null)).toEqual([]);
    expect(localAgentSuggestions([agy], [])).toEqual([agy]);
    expect(localAgentSuggestions([agy], [{ agentDefinitionId: "antigravity-acp" }])).toEqual([]);
    expect(localAgentSuggestions([{ ...agy, supported: false }], [])).toEqual([]);
  });

  it("runs the found command's ACP server with the existing sign-in", () => {
    expect(localAgentInstance(agy, "id-1")).toEqual({
      id: "id-1",
      agentDefinitionId: "antigravity-acp",
      displayName: "Google Antigravity",
      enabled: true,
      source: { kind: "local", executable: "/Users/me/.local/bin/agy", args: ["acp"] },
      environment: [],
      credentials: { kind: "inherit-host-profile" },
      proxy: "inherit-host",
      customModels: [],
    });
    expect(localAgentFoundDetail(agy)).toBe("agy 1.5.4");
    expect(localAgentFoundDetail({ ...agy, version: null })).toBe("agy");
  });
});
