import { describe, expect, it } from "vite-plus/test";
import { createBoundedOperationId } from "../operation-identity";
import {
  ProjectCreateInputSchema,
  ProjectUpdateCommandInputSchema,
  ProjectUpdateInputSchema,
} from "./projects";

describe("Project mutation schemas", () => {
  it("rejects the removed legacy icon authority on create and update", () => {
    expect(ProjectCreateInputSchema.safeParse({ icon: "🚀" }).success).toBe(false);
    expect(ProjectUpdateInputSchema.safeParse({ icon: "🚀" }).success).toBe(false);
  });

  it("rejects malformed revision fences instead of treating them as omitted", () => {
    for (const expectedBindingRevision of [0, -1, 1.5, "2", null]) {
      expect(
        ProjectUpdateInputSchema.safeParse({
          expectedBindingRevision,
          name: "Nodex",
        }).success,
      ).toBe(false);
    }
    expect(
      ProjectUpdateInputSchema.safeParse({
        expectedBindingRevision: 2,
        name: "Nodex",
      }).success,
    ).toBe(true);
  });

  it("keeps Database-owned Page-key updates out of Project metadata", () => {
    expect(
      ProjectUpdateInputSchema.safeParse({
        expectedPageKeyNamespaceRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      ProjectUpdateInputSchema.safeParse({
        pageKeyPrefix: "LAB",
        expectedPageKeyNamespaceRevision: 2,
      }).success,
    ).toBe(false);
  });

  it("requires one bounded caller identity around a strict Project update", () => {
    const input = {
      operationId: createBoundedOperationId("workspace.project.update", 1_800_000_000_000),
      projectId: "project:one",
      updates: { name: "Renamed", expectedBindingRevision: 1 },
    };

    expect(ProjectUpdateCommandInputSchema.parse(input)).toEqual(input);
    expect(
      ProjectUpdateCommandInputSchema.safeParse({ ...input, operationId: "operation:legacy" })
        .success,
    ).toBe(false);
    expect(
      ProjectUpdateCommandInputSchema.safeParse({
        ...input,
        updates: { name: "Missing revision" },
      }).success,
    ).toBe(false);
    expect(ProjectUpdateCommandInputSchema.safeParse({ ...input, projectId: " " }).success).toBe(
      false,
    );
    expect(ProjectUpdateCommandInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(
      false,
    );
  });
});
