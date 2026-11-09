import { AUTOMATION_INSTRUCTIONS } from "@nodex/agent-runtime/instructions";
import { describe, expect, it } from "vitest";
import { appToolCatalog } from "./catalog";

describe("Automation guidance every Agent receives", () => {
  it("names the tool, operation and field every provider can call", () => {
    const tool = appToolCatalog.find((candidate) => candidate.name === "automations_update");
    expect(AUTOMATION_INSTRUCTIONS).toContain("`automations_update`");
    const properties = tool?.inputSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(properties.operation?.enum).toContain("suggested_update");
    expect(AUTOMATION_INSTRUCTIONS).toContain("`suggested_update`");
    expect(properties).toHaveProperty("targetSessionId");
    expect(AUTOMATION_INSTRUCTIONS).toContain("`targetSessionId`");
  });
});
