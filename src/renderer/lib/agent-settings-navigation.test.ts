import { describe, expect, it } from "vite-plus/test";
import { ACP_ADD_AGENT_ID } from "@/features/acp-agents/acp-agent-model";
import { agentSettingsAnchor, agentSettingsKindForAnchor } from "./agent-settings-navigation";

describe("Agent settings navigation", () => {
  it("opens the section of every Agent kind, and the ACP section at one instance", () => {
    for (const kind of ["codex", "claude", "opencode", "acp"] as const) {
      expect(agentSettingsKindForAnchor(agentSettingsAnchor(kind))).toBe(kind);
    }
    const instance = agentSettingsAnchor("acp", "personal");
    expect(instance).not.toBe("acp");
    expect(agentSettingsKindForAnchor(instance)).toBe("acp");
    expect(agentSettingsAnchor("claude", "work")).toBe("claude");
  });

  it("opens Other agents for Add agent and no section for anything else", () => {
    expect(agentSettingsKindForAnchor(ACP_ADD_AGENT_ID)).toBe("acp");
    for (const anchor of [null, undefined, "", "agent", "codex-home"]) {
      expect(agentSettingsKindForAnchor(anchor)).toBeNull();
    }
  });
});
