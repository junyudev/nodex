import { encodeBoundedOperationId } from "../operation-identity";
import { describe, expect, test } from "vite-plus/test";
import {
  ProjectSessionPlaceCommandSchema,
  ProjectSessionSummaryWindowInputSchema,
} from "./session-order";

describe("Session ordering inputs", () => {
  test("admits bounded task windows in either order and rejects unsupported modes", () => {
    for (const order of ["activity", "manual"])
      expect(ProjectSessionSummaryWindowInputSchema.parse({ order, first: 200 })).toEqual({
        order,
        first: 200,
      });
    for (const input of [
      { order: "recent" },
      { first: 201 },
      { first: 0 },
      { includeArchived: "true" },
    ])
      expect(ProjectSessionSummaryWindowInputSchema.safeParse(input).success).toBe(false);
  });
  test("requires one Session anchor and rejects the removed bulk order payload", () => {
    const operationId = encodeBoundedOperationId("session.place", 0, "one");
    expect(
      ProjectSessionPlaceCommandSchema.parse({
        operationId,
        payload: { sessionId: "one", placement: { kind: "after", sessionId: "two" } },
      }).payload.placement,
    ).toEqual({ kind: "after", sessionId: "two" });
    for (const payload of [
      { projectId: "project", orderedSessionIds: ["one"] },
      { sessionId: "one", placement: { kind: "start", sessionId: "two" } },
      { sessionId: "one", placement: { kind: "before", sessionId: "" } },
    ])
      expect(ProjectSessionPlaceCommandSchema.safeParse({ operationId, payload }).success).toBe(
        false,
      );
  });
});
