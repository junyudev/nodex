import { describe, expect, test } from "vite-plus/test";

import { resolvePageFileOwnerDisclosure } from "./page-file-owner-disclosure";

describe("Page File owner disclosure", () => {
  test("omits redundant ownership for a File owned by its containing Page", () => {
    expect(
      resolvePageFileOwnerDisclosure({
        containingPageId: "page-current",
        ownerPageId: "page-current",
        ownerTitle: "Current Page",
        ownerReadable: true,
        canOpen: true,
      }),
    ).toBeNull();
  });

  test("never exposes an unreadable owner identity", () => {
    expect(
      resolvePageFileOwnerDisclosure({
        containingPageId: "page-current",
        ownerPageId: "page-secret-uuid",
        ownerTitle: null,
        ownerReadable: false,
        canOpen: true,
      }),
    ).toEqual({
      label: "From another Page",
      ownerTitle: null,
      openable: false,
    });
  });

  test("uses a readable Page title and exposes navigation only when available", () => {
    expect(
      resolvePageFileOwnerDisclosure({
        containingPageId: "page-current",
        ownerPageId: "page-owner",
        ownerTitle: "Research notes",
        ownerReadable: true,
        canOpen: true,
      }),
    ).toEqual({
      label: "From Research notes",
      ownerTitle: "Research notes",
      openable: true,
    });
  });
});
