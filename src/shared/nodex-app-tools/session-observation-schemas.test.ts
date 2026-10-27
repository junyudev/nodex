import { describe, expect, it } from "vitest";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  sessionObservationSchemas,
  sessionObservationToolCatalog,
} from "./session-observation-schemas";

const single = [{ sessionId: "one" }];
const multiple = [...single, { sessionId: "two" }];

describe("Session wait admission", () => {
  it("defaults single waits to ten minutes and retains two-minute multi-target waits", () => {
    expect(sessionObservationSchemas.wait_sessions.parse({ targets: single }).timeoutMs).toBe(
      600_000,
    );
    expect(sessionObservationSchemas.wait_sessions.parse({ targets: multiple }).timeoutMs).toBe(
      120_000,
    );
    expect(
      sessionObservationSchemas.wait_sessions.parse({ targets: single, timeoutMs: 0 }).timeoutMs,
    ).toBe(0);
  });

  it("allows an hour for one target without widening multi-target or invalid budgets", () => {
    expect(
      sessionObservationSchemas.wait_sessions.parse({ targets: single, timeoutMs: 3_600_000 })
        .timeoutMs,
    ).toBe(3_600_000);
    for (const input of [
      { targets: single, timeoutMs: 3_600_001 },
      { targets: multiple, timeoutMs: 120_001 },
      { targets: single, timeoutMs: -1 },
      { targets: single, timeoutMs: 0.5 },
      { targets: [{ sessionId: "one" }, { sessionId: "one" }] },
    ])
      expect(sessionObservationSchemas.wait_sessions.safeParse(input).success).toBe(false);
  });

  it("exports a valid MCP input schema despite contextual timeout defaults", () => {
    const tool = sessionObservationToolCatalog.find((tool) => tool.name === "wait_sessions");
    expect(ToolSchema.safeParse(tool).success).toBe(true);
    expect(tool?.inputSchema.type).toBe("object");
  });
});
