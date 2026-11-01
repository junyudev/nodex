import { describe, expect, test } from "vite-plus/test";
import { bindLibraryModuleApply, bindLibraryModuleRead } from "./library-module-transport";
import {
  libraryFileReadValueSchema,
  libraryFileOperationSchema,
  readFileBytesSchema,
  toCoreLibraryFileRead,
} from "./library-files-transport";
import { createUuidV7 } from "./uuid-v7";

describe("Library File transport boundaries", () => {
  test("preserves exact history and Canvas coordinates without admitting a second source", () => {
    const sources = [
      { kind: "direct" },
      { kind: "page", page_id: "page-a" },
      { kind: "document_revision", document_id: "doc-a", revision_id: "revision-a" },
      { kind: "recovery_draft", document_id: "doc-a", draft_id: "draft-a" },
      { kind: "canvas", canvas_id: "canvas-a", scene_file_id: "slot-a" },
      {
        kind: "canvas_revision",
        document_id: "doc-a",
        revision_id: "revision-a",
        scene_file_id: "slot-b",
      },
      {
        kind: "canvas_recovery",
        document_id: "doc-a",
        draft_id: "draft-a",
        scene_file_id: "slot-c",
      },
    ] as const;
    for (const source of sources) {
      const read = { mode: "file_presentation", file_id: "file-a", source, version: 3 } as const;
      expect(bindLibraryModuleRead({ read }).read).toEqual(read);
      expect(toCoreLibraryFileRead(read)).toEqual({
        kind: "file_presentation",
        file_id: "file-a",
        source,
        version: 3,
      });
      expect(readFileBytesSchema.parse({ fileId: "file-a", source, version: 3 }).source).toEqual(
        source,
      );
      expect(() =>
        readFileBytesSchema.parse({
          fileId: "file-a",
          source: { ...source, owner_page_id: "other" },
        }),
      ).toThrow();
    }
  });

  test("keeps Page entry replacement separate from global content replacement and fences both transfer sides", () => {
    const bind = (operation: unknown) =>
      bindLibraryModuleApply({ operationId: createUuidV7(), storeEpoch: "epoch-a", operation })
        .operation;
    const local = {
      kind: "apply_page_file_entries",
      page_id: "page-a",
      expected_manifest_revision: 0,
      changes: [
        {
          kind: "replace",
          file_id: "file-a",
          replacement_file_id: "file-b",
          mime_type: "image/png",
          prepared_blob_receipt_id: "receipt-a",
        },
      ],
    };
    const put = {
      kind: "put_page_file_entry",
      page_id: "page-a",
      expected_manifest_revision: 1,
      file_id: "new-file",
      logical_path: "image.png",
      mime_type: "image/png",
      prepared_blob_receipt_id: "receipt-a",
      replace_entry: false,
    };
    expect(bind(put)).toEqual(put);
    expect(() => bind({ ...put, replace_entry: undefined })).toThrow();
    expect(() => bind({ ...put, expected_manifest_revision: undefined })).toThrow();
    expect(bind(local)).toEqual(local);
    expect(() =>
      bind({ ...local, changes: [{ ...local.changes[0], expected_head_version: 1 }] }),
    ).toThrow();
    const global = {
      kind: "apply_file_change",
      change: {
        kind: "replace_content",
        file_id: "file-a",
        expected_revision: 2,
        expected_head_version: 1,
        mime_type: "image/png",
        prepared_blob_receipt_id: "receipt-a",
      },
    };
    expect(bind(global)).toEqual(global);
    expect(() => bind({ ...global, page_id: "page-a" })).toThrow();
    expect(() =>
      bind({
        kind: "transfer_page_file_entry",
        file_id: "file-a",
        source_page_id: "page-a",
        source_manifest_revision: 1,
        target_page_id: "page-b",
        target_logical_path: "image.png",
        copy: false,
      }),
    ).toThrow();
    expect(() =>
      bind({ ...local, changes: Array.from({ length: 101 }, () => local.changes[0]) }),
    ).toThrow();
  });

  test("requires an explicit Page selector and bounds result windows", () => {
    for (const selector of [
      { kind: "file_id", file_id: "file-a" },
      { kind: "path", logical_path: "design/image.png" },
    ]) {
      const read = { mode: "resolve_page_file", page_id: "page-a", selector };
      expect(bindLibraryModuleRead({ read }).read).toEqual(read);
    }
    expect(() =>
      bindLibraryModuleRead({
        read: {
          mode: "resolve_page_file",
          page_id: "page-a",
          selector: { kind: "path", logical_path: "a.png", file_id: "file-a" },
        },
      }),
    ).toThrow();
    expect(() =>
      bindLibraryModuleRead({
        read: { mode: "files", lifecycle: "live", usage: "all", limit: 201 },
      }),
    ).toThrow();
  });

  test("validates attachment evidence on both inventory and selected-item reads", () => {
    const file = {
      file_id: "file-a",
      library_id: "library-a",
      default_name: "output.html",
      head_version: 1,
      revision: 1,
      lifecycle: "live",
      mime_type: "text/html",
      byte_length: 12,
      blob_etag: "a".repeat(64),
      created_by_actor_id: "project-a",
      created_by_turn_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    };
    const parse = (item: unknown, inventory: boolean) =>
      libraryFileReadValueSchema.parse(
        inventory
          ? {
              kind: "page_file_inventory",
              value: {
                page_id: "page-a",
                revision: 1,
                body_usage_revision: 0,
                files: [item],
                next_cursor: null,
                has_more: false,
                total: 1,
                unplaced_total: 1,
                placed_total: 0,
              },
            }
          : { kind: "resolved_page_file", value: item },
      );
    const time = "2026-11-01T10:15:00+08:00";
    const actors = [
      { kind: "person" },
      { kind: "external" },
      { kind: "unknown" },
      ...["codex", "claude", "opencode", "acp"].map((backend) => ({
        kind: "agent",
        session_id: "session-product-a",
        backend,
      })),
    ];
    for (const inventory of [true, false]) {
      const item = { file, logical_path: "output.html", body_count: 0 };
      for (const actor of actors) {
        const attachment = {
          attached_by: actor,
          attached_at: actor.kind === "unknown" ? null : time,
        };
        expect(() => parse({ ...item, attachment }, inventory)).not.toThrow();
        expect(() =>
          parse(
            {
              ...item,
              attachment: { ...attachment, attached_at: actor.kind === "unknown" ? time : null },
            },
            inventory,
          ),
        ).toThrow();
      }
      expect(() =>
        parse({ ...item, logical_path: null, attachment: null }, inventory),
      ).not.toThrow();
      for (const attachment of [
        undefined,
        null,
        { attached_by: { kind: "person" }, attached_at: "2026-11-01 10:15:00" },
        { attached_by: { kind: "agent", session_id: "project-a" }, attached_at: time },
        {
          attached_by: { kind: "agent", session_id: "chat", backend: "gemini" },
          attached_at: time,
        },
        { attached_by: { kind: "person", session_id: "forged" }, attached_at: time },
      ])
        expect(() => parse({ ...item, attachment }, inventory)).toThrow();
      expect(() =>
        parse(
          {
            ...item,
            logical_path: null,
            attachment: { attached_by: { kind: "person" }, attached_at: time },
          },
          inventory,
        ),
      ).toThrow();
    }
  });

  test("entry commands cannot supply attachment actors or times", () => {
    const operation = {
      kind: "apply_page_file_entries",
      page_id: "page-a",
      expected_manifest_revision: 0,
      changes: [
        {
          kind: "attach",
          file_id: "file-a",
          logical_path: "output.html",
          source: { kind: "direct" },
          collision_policy: "reject",
        },
      ],
    };
    for (const forged of [
      { attached_by: { kind: "person" } },
      { attached_at: "2026-11-01T00:00:00Z" },
    ]) {
      expect(() => libraryFileOperationSchema.parse({ ...operation, ...forged })).toThrow();
      expect(() =>
        libraryFileOperationSchema.parse({
          ...operation,
          changes: [{ ...operation.changes[0], ...forged }],
        }),
      ).toThrow();
    }
  });

  test("accepts frozen presentation without current global metadata", () => {
    const value = {
      kind: "file_presentation",
      value: {
        file_id: "file-a",
        version: 1,
        default_name: "old.png",
        mime_type: "image/png",
        byte_length: 4,
        blob_etag: "a".repeat(64),
      },
    };
    expect(libraryFileReadValueSchema.parse(value)).toEqual(value);
    expect(() =>
      libraryFileReadValueSchema.parse({ ...value, value: { ...value.value, head_version: 7 } }),
    ).toThrow();
    expect(() =>
      libraryFileReadValueSchema.parse({
        ...value,
        value: { ...value.value, byte_length: 65 * 1024 * 1024 },
      }),
    ).toThrow();
  });
});
