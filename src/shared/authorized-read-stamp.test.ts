import { describe, expect, test } from "vite-plus/test";

import {
  canonicalizeAuthorityResources,
  parseAuthorizedReadStamp,
  type AuthorityResource,
} from "./authorized-read-stamp";
import { revocationsFromVisibilityDelta } from "./local-commit-delivery";
import { authorizedReadStampFixture } from "./testing/authorized-read-stamp-fixture";

const address = {
  kind: "project",
  library_id: "library-1",
  project_id: "project-1",
} as const;

describe("AuthorizedReadStamp boundary", () => {
  test("accepts independent File reads and delivers exact File revocations", () => {
    const file = { kind: "file", file_id: "file-1" } as const;
    const canvas = { kind: "canvas", canvas_id: "canvas-1" } as const;
    expect(canonicalizeAuthorityResources([file, canvas, file])).toEqual([canvas, file]);
    const stamp = authorizedReadStampFixture({ deliveryAddress: address, subject: file });
    expect(parseAuthorizedReadStamp(stamp)).toEqual(stamp);
    expect(
      revocationsFromVisibilityDelta({
        authorization_scope: address,
        roots: [file],
        change: { kind: "revoke", reason: "access_revoked" },
        delta_hash: "a".repeat(64),
      }),
    ).toEqual([
      {
        authorization_scope: address,
        resource_kind: "file",
        resource_id: "file-1",
        reason: "access_revoked",
      },
    ]);
    expect(() =>
      parseAuthorizedReadStamp({ ...stamp, subject: { ...file, page_id: "page-1" } }),
    ).toThrow();
  });

  test("rejects resource kinds outside the generated ResourceKey union", () => {
    const stamp = authorizedReadStampFixture({
      deliveryAddress: address,
      subject: { kind: "page", page_id: "page-1" },
    });

    expect(() =>
      parseAuthorizedReadStamp({
        ...stamp,
        authorization_dependencies: [{ kind: "unknown", unknown_id: "root-1" }],
      }),
    ).toThrow("Authorized read stamp is invalid");
  });

  test("rejects dependencies outside canonical ResourceKey order", () => {
    const dependencies: readonly AuthorityResource[] = [
      { kind: "page", page_id: "page-1" },
      { kind: "library", library_id: "library-1" },
    ];
    const stamp = authorizedReadStampFixture({
      deliveryAddress: address,
      subject: { kind: "page", page_id: "page-1" },
    });

    expect(() =>
      parseAuthorizedReadStamp({
        ...stamp,
        authorization_dependencies: dependencies,
      }),
    ).toThrow("Authorized read stamp is invalid");
  });
});
