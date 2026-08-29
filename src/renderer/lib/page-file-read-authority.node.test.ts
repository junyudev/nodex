import { describe, expect, test } from "vite-plus/test";

import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import { isPageFileReferenceChangeForDocument } from "./page-file-read-authority";

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
            page_file_manifest_revisions: {},
            page_file_body_usage_revisions: {},
            page_file_content_revisions: {},
          },
        }),
        "document:target",
      ),
    ).toBe(false);
  });
});
