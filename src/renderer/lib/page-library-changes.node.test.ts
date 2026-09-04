import type { components } from "@nodex/core-protocol";
import { describe, expect, test } from "vitest";

import {
  pageFileBodyUsageRevisionFromLibraryEvent,
  pageFileContentChangeFromLibraryEvent,
  pageFileContentRevisionFromLibraryEvent,
  pageFileManifestChangeFromLibraryEvent,
  pageFileManifestRevisionFromLibraryEvent,
} from "./page-library-changes";

type LibraryEvent = components["schemas"]["LibraryEvent"];

const event = (overrides: Partial<LibraryEvent> = {}): LibraryEvent => ({
  kind: "library_changed",
  page_ids: [],
  database_ids: [],
  view_ids: [],
  parent_keys: [],
  file_revisions: {},
  page_file_manifest_invalidations: {},
  page_file_body_usage_revisions: {},
  page_file_content_invalidations: {},
  ...overrides,
});

describe("Page File Library subscriptions", () => {
  test("ignores ordinary Page changes and exposes only exact manifest revisions", () => {
    expect(pageFileManifestRevisionFromLibraryEvent(event(), "page-1")).toBeNull();

    expect(
      pageFileManifestRevisionFromLibraryEvent(
        event({
          file_revisions: {},
          page_file_manifest_invalidations: {
            "page-1": { kind: "exact", revision: 7, file_ids: ["file-a"] },
            "page-2": { kind: "reset", revision: 3 },
          },
        }),
        "page-1",
      ),
    ).toBe(7);
  });

  test("projects only a valid exact Page File body usage revision", () => {
    const libraryEvent = event({
      page_file_body_usage_revisions: {
        "page-1": 9,
      },
    });

    expect(pageFileBodyUsageRevisionFromLibraryEvent(libraryEvent, "page-1")).toBe(9);
    expect(pageFileBodyUsageRevisionFromLibraryEvent(libraryEvent, "page-2")).toBeNull();
    expect(
      pageFileBodyUsageRevisionFromLibraryEvent(
        event({
          page_file_body_usage_revisions: {
            "page-1": -1,
          },
        }),
        "page-1",
      ),
    ).toBeNull();
  });

  test("projects current File content invalidation only to its placement Page", () => {
    const libraryEvent = event({
      page_file_content_invalidations: {
        "page-2": { kind: "exact", revision: 41, file_ids: ["file-a"] },
      },
    });

    expect(pageFileContentRevisionFromLibraryEvent(libraryEvent, "page-2")).toBe(41);
    expect(pageFileContentRevisionFromLibraryEvent(libraryEvent, "page-1")).toBeNull();
  });

  test("projects exact File IDs from generated invalidation variants", () => {
    const libraryEvent = event({
      file_revisions: {},
      page_file_manifest_invalidations: {
        "page-1": { kind: "exact", revision: 12, file_ids: ["file-a", "file-b"] },
      },
      page_file_content_invalidations: {
        "page-1": { kind: "exact", revision: 13, file_ids: ["file-b"] },
      },
    });

    expect(pageFileManifestChangeFromLibraryEvent(libraryEvent, "page-1")).toEqual({
      revision: 12,
      fileIds: ["file-a", "file-b"],
    });
    expect(pageFileContentChangeFromLibraryEvent(libraryEvent, "page-1")).toEqual({
      revision: 13,
      fileIds: ["file-b"],
    });
  });

  test("projects generated reset variants as page-wide invalidation", () => {
    const libraryEvent = event({
      file_revisions: {},
      page_file_manifest_invalidations: { "page-1": { kind: "reset", revision: 3 } },
      page_file_content_invalidations: { "page-1": { kind: "reset", revision: 4 } },
    });

    expect(pageFileManifestChangeFromLibraryEvent(libraryEvent, "page-1")?.fileIds).toBeNull();
    expect(pageFileContentChangeFromLibraryEvent(libraryEvent, "page-1")?.fileIds).toBeNull();
  });
});
