import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { agentRuntimeModelSelection, agentRuntimeProviderId } from "./agent-runtime-provider";

describe("Agent Runtime provider identity", () => {
  it("encodes the complete configured identity as one bounded provider slug", () => {
    const id = "配置 / 🔑 ".repeat(10).trim();
    const binding = { kind: "claude" as const, instanceConfigId: id };
    const expected = createHash("sha256")
      .update(JSON.stringify([binding.kind, id]))
      .digest("base64url");
    const actual = agentRuntimeProviderId(binding)!;
    expect(actual).toBe(`claude_${expected}`);
    expect(actual).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
    expect(agentRuntimeProviderId({ kind: "opencode", instanceConfigId: id })).not.toBe(actual);
    expect(agentRuntimeProviderId({ ...binding, instanceConfigId: `${id}!` })).not.toBe(actual);
  });

  it("requires an explicit configured native instance while retaining the canonical Codex instance", () => {
    expect(agentRuntimeProviderId({ kind: "codex" })).toBe("codex");
    expect(
      agentRuntimeProviderId({ kind: "acp", agentDefinitionId: "agent", instanceConfigId: null }),
    ).toBeNull();
    expect(agentRuntimeProviderId({ kind: "claude", instanceConfigId: " padded" })).toBeNull();
    expect(
      agentRuntimeModelSelection({ kind: "claude", instanceConfigId: "instance" }, " model ", [
        { id: "effort", value: "high" },
      ]),
    ).toEqual({
      instanceId: agentRuntimeProviderId({ kind: "claude", instanceConfigId: "instance" }),
      model: "model",
      options: [{ id: "effort", value: "high" }],
    });
  });
});
