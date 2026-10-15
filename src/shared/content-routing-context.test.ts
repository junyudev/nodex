import { describe, expect, test } from "vite-plus/test";

import {
  contentRoutingContextKey,
  contentRoutingIdentityKey,
  libraryContentRoute,
  parseContentRoutingContext,
  projectIdFromContentRoutingContext,
  projectContentRoute,
} from "./content-routing-context";

describe("ContentRoutingContext", () => {
  test("keeps Project and Library route selection explicit", () => {
    expect(projectContentRoute("project-1")).toEqual({
      kind: "project",
      projectId: "project-1",
    });
    expect(parseContentRoutingContext(libraryContentRoute)).toEqual({
      kind: "library",
    });
  });

  test("rejects embedded physical Library identities in presentation routes", () => {
    expect(() =>
      parseContentRoutingContext({
        kind: "library",
        libraryId: "forged-library",
      }),
    ).toThrow("libraryId is not supported");
    expect(() => parseContentRoutingContext({ kind: "project", projectId: " project-1" })).toThrow(
      "canonical non-empty identity",
    );
  });

  test("resolves optional Project routing separately from physical Library identity", () => {
    expect(projectIdFromContentRoutingContext(projectContentRoute("project-1"))).toBe("project-1");
    expect(projectIdFromContentRoutingContext(libraryContentRoute)).toBeNull();
    expect(contentRoutingContextKey(projectContentRoute("project-1"))).toBe("project:project-1");
    expect(contentRoutingContextKey(libraryContentRoute)).toBe("library");
    expect(() => contentRoutingContextKey({ kind: "forged" } as never)).toThrow(
      "kind is unsupported",
    );
    expect(
      contentRoutingIdentityKey({
        libraryId: "library-1",
        routingContext: libraryContentRoute,
      }),
    ).not.toBe(
      contentRoutingIdentityKey({
        libraryId: "library-2",
        routingContext: libraryContentRoute,
      }),
    );
  });
});
