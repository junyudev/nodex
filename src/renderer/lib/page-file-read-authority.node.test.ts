import { describe, expect, test } from "vite-plus/test";

import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import {
  isPageFileReferenceChangeForDocument,
  pageFileReferenceInvalidationsForDocument,
  pageFileReadInvalidationsFromChange,
} from "./page-file-read-authority";

type DeliveryAtom = AuthorizedDeliveryPacket["atoms"][number];

const atom = (event: DeliveryAtom["payload"]): DeliveryAtom => ({
  descriptor: {
    atom_id: "atom:test",
    atom_order: 0,
    kind: "owned_document_changed",
    payload_hash: "a".repeat(64),
    required_resources: [],
  },
  payload: event,
});

describe("Page File read authority", () => {
  test("matches only the exact Document reference-change event", () => {
    const referenceChange = atom({
      module: "owned_document",
      library_id: "library:test",
      event: {
        kind: "page_file_references_changed",
        document_id: "document:target",
        generation: 2,
        head_seq: 9,
        change: { kind: "exact", added_file_ids: ["file-a"], removed_file_ids: [] },
      },
    });
    expect(isPageFileReferenceChangeForDocument(referenceChange, "document:target")).toBe(true);
    expect(isPageFileReferenceChangeForDocument(referenceChange, "document:other")).toBe(false);

    expect(
      isPageFileReferenceChangeForDocument(
        atom({
          module: "owned_document",
          library_id: "library:test",
          event: {
            kind: "document_resync_required",
            document_id: "document:target",
            generation: 2,
            head_seq: 9,
            update_id: "update:test",
            update_hash: "a".repeat(64),
          },
        }),
        "document:target",
      ),
    ).toBe(false);
    expect(
      isPageFileReferenceChangeForDocument(
        atom({
          module: "library",
          library_id: "library:test",
          event: {
            kind: "library_changed",
            page_ids: [],
            database_ids: [],
            view_ids: [],
            parent_keys: [],
            page_file_manifest_invalidations: {},
            page_file_body_usage_revisions: {},
            page_file_content_invalidations: {},
          },
        }),
        "document:target",
      ),
    ).toBe(false);
  });

  test("projects reset reference events as page-wide authority revocation", () => {
    const referenceChange = atom({
      module: "owned_document",
      library_id: "library:test",
      event: {
        kind: "page_file_references_changed",
        document_id: "document:target",
        generation: 2,
        head_seq: 9,
        change: { kind: "reset" },
      },
    });

    expect(pageFileReferenceInvalidationsForDocument(referenceChange, "document:target")).toEqual([
      {
        mode: "revoke",
        fileIds: null,
        metadata: true,
        content: true,
      },
    ]);
  });

  test("separates newly readable and revoked File identities", () => {
    const referenceChange = atom({
      module: "owned_document",
      library_id: "library:test",
      event: {
        kind: "page_file_references_changed",
        document_id: "document:target",
        generation: 2,
        head_seq: 9,
        change: {
          kind: "exact",
          added_file_ids: ["file-a", "file-b"],
          removed_file_ids: ["file-c"],
        },
      },
    });

    expect(pageFileReferenceInvalidationsForDocument(referenceChange, "document:target")).toEqual([
      {
        mode: "refresh",
        fileIds: ["file-a", "file-b"],
        metadata: true,
        content: true,
      },
      {
        mode: "revoke",
        fileIds: ["file-c"],
        metadata: true,
        content: true,
      },
    ]);
  });

  test("keeps metadata-only and content invalidations separate", () => {
    expect(
      pageFileReadInvalidationsFromChange({
        manifestRevision: 3,
        manifestFileIds: ["file-renamed"],
        bodyUsageRevision: null,
        contentRevision: 4,
        contentFileIds: ["file-replaced"],
      }),
    ).toEqual([
      {
        mode: "refresh",
        fileIds: ["file-renamed", "file-replaced"],
        metadata: true,
        content: false,
      },
      {
        mode: "refresh",
        fileIds: ["file-replaced"],
        metadata: false,
        content: true,
      },
    ]);
  });

  test("lets a content-only signal refresh both metadata and bytes", () => {
    expect(
      pageFileReadInvalidationsFromChange({
        manifestRevision: null,
        manifestFileIds: null,
        bodyUsageRevision: null,
        contentRevision: 4,
        contentFileIds: ["file-replaced"],
      }),
    ).toEqual([
      {
        mode: "refresh",
        fileIds: ["file-replaced"],
        metadata: true,
        content: true,
      },
    ]);
  });
});
