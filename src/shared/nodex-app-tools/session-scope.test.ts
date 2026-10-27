import { describe, expect, it } from "vitest";
import { resolveSessionScope } from "./session-scope";
import { sessionObservationSchemas } from "./session-observation-schemas";

describe("Session discovery scope", () => {
  it("defaults to the caller Project or projectless lane with explicit Profile opt-in", () => {
    expect(resolveSessionScope({}, "project:caller")).toEqual({ projectId: "project:caller" });
    expect(resolveSessionScope({}, null)).toEqual({ projectlessOnly: true });
    expect(resolveSessionScope({ projectId: "project:other" }, "project:caller")).toEqual({
      projectId: "project:other",
    });
    expect(resolveSessionScope({ scope: "profile" }, "project:caller")).toEqual({});
    expect(resolveSessionScope({ scope: "profile" }, null)).toEqual({});
  });
  it("rejects ambiguous Profile and Project scopes at the public boundary", () => {
    expect(
      sessionObservationSchemas.list_sessions.safeParse({ scope: "profile", projectId: "project" })
        .success,
    ).toBe(false);
    expect(sessionObservationSchemas.list_sessions.parse({}).includeSubagents).toBe(true);
  });
});
