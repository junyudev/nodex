import { describe, expect, test } from "vite-plus/test";

import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import type { FileReadAuthority } from "./library-file-resources";
import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import {
  fileReadRevocationInvalidations,
  isFileSourceReferenceChangeForDocument,
  pageFileReferenceInvalidationsForDocument,
  pageFileReadInvalidationsFromChange,
} from "./file-read-authority";

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

describe("File read authority", () => {
  test("separates direct File grants from Page and captured Document authority", () => {
    const page: FileReadAuthority = {
      libraryId: "library",
      storeEpoch: "epoch",
      contentAccessContext: { kind: "project", projectId: "project" },
      readSource: { kind: "page", page_id: "page" },
    };
    const direct: FileReadAuthority = { ...page, readSource: { kind: "direct" } };
    const historical: FileReadAuthority = {
      ...page,
      readSource: { kind: "document_revision", document_id: "doc", revision_id: "old" },
    };
    const revoke = (kind: "file" | "page" | "document", id: string): ResourceRevocationMessage => ({
      version: 1,
      kind: "revocation",
      scope: { kind: "project", libraryId: "library", projectId: "project" },
      stream: { storeEpoch: "epoch", commitSeq: 10 },
      delivery: {
        storeEpoch: "epoch",
        commitSeq: 10,
        manifestHash: "a".repeat(64),
        operationId: "revoke",
        committedAt: "now",
        revocation: {
          authorization_scope: { kind: "project", library_id: "library", project_id: "project" },
          resource_kind: kind,
          resource_id: id,
          reason: "access_revoked",
        },
      },
    });
    expect(fileReadRevocationInvalidations(direct, null, revoke("file", "f"))).toEqual([
      { mode: "revoke", fileIds: ["f"], metadata: true, content: true },
    ]);
    expect(fileReadRevocationInvalidations(page, "doc", revoke("file", "f"))).toEqual([]);
    expect(fileReadRevocationInvalidations(direct, null, revoke("page", "page"))).toEqual([]);
    expect(fileReadRevocationInvalidations(page, "doc", revoke("page", "other"))).toEqual([]);
    const cleared = [{ mode: "revoke", fileIds: null, metadata: true, content: true }];
    expect(fileReadRevocationInvalidations(page, "doc", revoke("page", "page"))).toEqual(cleared);
    expect(fileReadRevocationInvalidations(historical, "doc", revoke("document", "doc"))).toEqual(
      cleared,
    );
    expect(fileReadRevocationInvalidations(historical, "doc", revoke("page", "page"))).toEqual(
      cleared,
    );
    expect(fileReadRevocationInvalidations(historical, "doc", revoke("file", "f"))).toEqual([]);
    expect(
      fileReadRevocationInvalidations(direct, null, {
        version: 1,
        kind: "reset",
        scope: { kind: "project", libraryId: "library", projectId: "project" },
        stream: { storeEpoch: "next", commitSeq: 11 },
        reason: "store_epoch_changed",
      }),
    ).toEqual(cleared);
  });

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
    expect(isFileSourceReferenceChangeForDocument(referenceChange, "document:target")).toBe(true);
    expect(isFileSourceReferenceChangeForDocument(referenceChange, "document:other")).toBe(false);

    expect(
      isFileSourceReferenceChangeForDocument(
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
      isFileSourceReferenceChangeForDocument(
        atom({
          module: "library",
          library_id: "library:test",
          event: {
            kind: "library_changed",
            page_ids: [],
            database_ids: [],
            view_ids: [],
            parent_keys: [],
            file_revisions: {},
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
