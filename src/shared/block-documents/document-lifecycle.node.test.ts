import { describe, expect, test, it } from "vite-plus/test";
import {
  canonicalizeDocumentOperationBatch,
  canonicalizeDocumentOperationIntent,
  canonicalizeReplaceDocumentFromMarkdown,
  canonicalizeReplaceDocumentFromMarkdownIntent,
  DocumentOperationContractError,
  parseDocumentOperationBatch,
  parseDocumentOperationCommandResult,
  parseReplaceDocumentFromMarkdown,
} from "./document-operations";
import { committedLocalCommit } from "../testing/local-commit";
import {
  canonicalizeCanvasPresenceEvent,
  canonicalizeCanvasPresencePublication,
  canonicalizeCanvasPresencePublishRequest,
  canonicalizeCanvasPresenceRealtimeEvent,
  MAX_CANVAS_PRESENCE_SELECTION_IDS,
} from "./document-presence";
import {
  MAX_UNPINNED_DOCUMENT_REVISIONS,
  planDocumentRevisionRetention,
} from "./document-revision-retention";
import { encodeRecoveryBundle, recoveryPayloadHash, decodeRecoverySource } from "./recovery-bundle";
import type { RecoveryDraftCapture } from "./document-recovery";

describe("document operations", () => {
  const BASE = {
    mutationId: "operation-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "session-1",
    actor: { kind: "agent", id: "agent-1" },
    documentId: "document-1",
    generation: 1,
    expectedHeadSeq: 4,
  } as const;

  const rejectsContract = (value: unknown, kind: "batch" | "markdown"): boolean => {
    try {
      if (kind === "batch") {
        parseDocumentOperationBatch(value);
      } else {
        parseReplaceDocumentFromMarkdown(value);
      }
      return false;
    } catch (error) {
      return error instanceof DocumentOperationContractError;
    }
  };

  describe("Document operation contract", () => {
    test("parses every stable-ID operation without transport-specific fields", () => {
      const parsed = parseDocumentOperationBatch({
        ...BASE,
        operations: [
          { kind: "set_title", title: "Updated" },
          {
            kind: "set_rich_title",
            richTitle: [
              { type: "text", text: "Rich", styles: { bold: true } },
              { type: "linebreak" },
              { type: "link", text: "title", href: "https://nodex.local", styles: {} },
            ],
          },
          {
            kind: "insert_block",
            parentBlockId: "parent",
            beforeBlockId: "anchor",
            block: {
              id: "inserted",
              type: "paragraph",
              props: { textAlignment: "left" },
              content: [{ type: "text", text: "Hello", styles: {} }],
              children: [
                {
                  id: "inserted-child",
                  type: "paragraph",
                  props: {},
                  content: [],
                  children: [],
                },
              ],
            },
          },
          {
            kind: "update_block",
            blockId: "existing",
            patch: { props: { checked: true }, content: [] },
          },
          { kind: "move_block", blockId: "moving", beforeBlockId: "anchor" },
          { kind: "delete_block", blockId: "deleted" },
        ],
      });

      expect(parsed.operations.length).toBe(6);
      expect(parsed.operations[2]?.kind).toBe("insert_block");
      expect(
        parsed.operations[2]?.kind === "insert_block"
          ? parsed.operations[2].block.children[0]?.id
          : "",
      ).toBe("inserted-child");
    });

    test("rejects non-canonical or unsafe rich title payloads at the boundary", () => {
      expect(
        rejectsContract(
          {
            ...BASE,
            operations: [
              {
                kind: "set_rich_title",
                richTitle: [{ type: "attachment", name: "not-title-safe" }],
              },
            ],
          },
          "batch",
        ),
      ).toBe(true);
    });

    test("canonicalizes portable object key order but preserves operation order", () => {
      const first = {
        ...BASE,
        operations: [
          {
            kind: "update_block",
            blockId: "existing",
            patch: { props: { beta: 2, alpha: 1 } },
          },
          { kind: "set_title", title: "After" },
        ],
      };
      const reorderedKeys = {
        expectedHeadSeq: 4,
        generation: 1,
        documentId: "document-1",
        storeEpoch: "epoch-1",
        projectId: "project-1",
        mutationId: "operation-1",
        clientSessionId: "session-1",
        actor: { id: "agent-1", kind: "agent" },
        operations: [
          {
            blockId: "existing",
            patch: { props: { alpha: 1, beta: 2 } },
            kind: "update_block",
          },
          { title: "After", kind: "set_title" },
        ],
      };
      const reorderedOperations = {
        ...BASE,
        operations: [...first.operations].reverse(),
      };

      expect(canonicalizeDocumentOperationBatch(first)).toBe(
        canonicalizeDocumentOperationBatch(reorderedKeys),
      );
      expect(
        canonicalizeDocumentOperationBatch(first) ===
          canonicalizeDocumentOperationBatch(reorderedOperations),
      ).toBe(false);
    });

    test("keeps durable command intent stable across trusted transport identities", () => {
      const operation = {
        ...BASE,
        operations: [{ kind: "set_title" as const, title: "After" }],
      };
      const retriedOperation = {
        ...operation,
        clientSessionId: "replacement-window",
        actor: { kind: "http", id: "same-local-user" },
      };
      expect(canonicalizeDocumentOperationIntent(operation)).toBe(
        canonicalizeDocumentOperationIntent(retriedOperation),
      );
      expect(
        canonicalizeDocumentOperationBatch(operation) ===
          canonicalizeDocumentOperationBatch(retriedOperation),
      ).toBe(false);

      const replacement = { ...BASE, markdown: "Body" };
      expect(canonicalizeReplaceDocumentFromMarkdownIntent(replacement)).toBe(
        canonicalizeReplaceDocumentFromMarkdownIntent({
          ...replacement,
          clientSessionId: "browser-retry",
          actor: { kind: "ipc", id: "same-local-user" },
        }),
      );
    });

    test("rejects unknown fields, duplicate subtree IDs, invalid values, and self targets", () => {
      expect(
        rejectsContract(
          {
            ...BASE,
            unsupported: true,
            operations: [{ kind: "set_title", title: "No" }],
          },
          "batch",
        ),
      ).toBe(true);
      expect(
        rejectsContract(
          {
            ...BASE,
            operations: [
              {
                kind: "insert_block",
                block: {
                  id: "same",
                  type: "paragraph",
                  props: {},
                  children: [
                    {
                      id: "same",
                      type: "paragraph",
                      props: {},
                      children: [],
                    },
                  ],
                },
              },
            ],
          },
          "batch",
        ),
      ).toBe(true);
      expect(
        rejectsContract(
          {
            ...BASE,
            operations: [
              {
                kind: "update_block",
                blockId: "existing",
                patch: { props: { bad: Number.NaN } },
              },
            ],
          },
          "batch",
        ),
      ).toBe(true);
      expect(
        rejectsContract(
          {
            ...BASE,
            operations: [
              {
                kind: "move_block",
                blockId: "same",
                parentBlockId: "same",
              },
            ],
          },
          "batch",
        ),
      ).toBe(true);
    });

    test("keeps explicit Markdown replacement separate and CAS-bound", () => {
      const replacement = parseReplaceDocumentFromMarkdown({
        ...BASE,
        markdown: "First\n\nSecond",
      });
      expect(replacement.markdown).toBe("First\n\nSecond");
      expect(canonicalizeReplaceDocumentFromMarkdown(replacement)).toBe(
        canonicalizeReplaceDocumentFromMarkdown({
          markdown: "First\n\nSecond",
          ...BASE,
        }),
      );
      expect(rejectsContract({ ...BASE, markdown: "Body", operations: [] }, "markdown")).toBe(true);
    });

    test("strictly parses transport-neutral success and conflict results", () => {
      const success = parseDocumentOperationCommandResult({
        ok: true,
        localCommit: committedLocalCommit("epoch-1", 7),
        value: {
          mutationKind: "document_operation_batch",
          mutationId: "operation-1",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          documentId: "document-1",
          generation: 1,
          baseHeadSeq: 4,
          headSeq: 5,
          touchedBlockIds: ["block-1"],
          createdBlockIds: [],
          deletedBlockIds: [],
          updatedBlockIds: ["block-1"],
          movedBlockIds: [],
          writeFenceBlockIds: ["block-1"],
          titleChanged: false,
          coordination: "write_fence",
          commitSeq: 7,
          committedAt: "2026-07-11T00:00:00.000Z",
          duplicate: false,
        },
      });
      expect(success.ok).toBe(true);
      expect(success.ok ? success.value.headSeq : -1).toBe(5);

      const conflict = parseDocumentOperationCommandResult({
        ok: false,
        error: {
          code: "document_head_conflict",
          message: "Document head changed",
          retryable: false,
          mutationId: "operation-1",
          expectedHeadSeq: 4,
          actualHeadSeq: 5,
        },
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.ok ? -1 : conflict.error.actualHeadSeq).toBe(5);

      let rejected = false;
      try {
        parseDocumentOperationCommandResult({
          ok: false,
          error: {
            code: "document_head_conflict",
            message: "Missing evidence",
            retryable: false,
            expectedHeadSeq: 4,
          },
        });
      } catch (error) {
        rejected = error instanceof DocumentOperationContractError;
      }
      expect(rejected).toBe(true);
    });
  });
});

describe("document presence", () => {
  const publication = {
    engine: "canvas_scene" as const,
    documentId: "document-1",
    generation: 3,
    clock: 8,
    state: {
      pointer: {
        x: 12.5,
        y: -4,
        button: "up" as const,
        tool: "pointer" as const,
      },
      selectedElementIds: ["element-a", "element-b"],
      idle: "active" as const,
    },
  };

  describe("Canvas document presence contract", () => {
    test("accepts a bounded canonical publication without transport identity", () => {
      expect(canonicalizeCanvasPresencePublication(publication)).toEqual(publication);
      expect("clientSessionId" in publication).toBe(false);
      expect("user" in publication).toBe(false);
      expect(
        canonicalizeCanvasPresencePublishRequest({
          routingContext: { kind: "project", projectId: "project-1" },
          clientSessionId: "session-1",
          publication,
        }),
      ).toMatchObject({ publication });
      expect(() =>
        canonicalizeCanvasPresencePublishRequest({
          routingContext: { kind: "project", projectId: "project-1" },
          publication,
        }),
      ).toThrow("client session");
    });

    test("rejects non-finite pointers and noncanonical or oversized selections", () => {
      expect(() =>
        canonicalizeCanvasPresencePublication({
          ...publication,
          state: {
            ...publication.state,
            pointer: { ...publication.state.pointer, x: Number.NaN },
          },
        }),
      ).toThrow("pointer");
      expect(() =>
        canonicalizeCanvasPresencePublication({
          ...publication,
          state: {
            ...publication.state,
            selectedElementIds: ["element-b", "element-a"],
          },
        }),
      ).toThrow("sorted and unique");
      expect(() =>
        canonicalizeCanvasPresencePublication({
          ...publication,
          state: {
            ...publication.state,
            selectedElementIds: Array.from(
              { length: MAX_CANVAS_PRESENCE_SELECTION_IDS + 1 },
              (_, index) => `element-${index}`,
            ),
          },
        }),
      ).toThrow("invalid");
    });

    test("binds and validates trusted event identity", () => {
      const event = canonicalizeCanvasPresenceEvent({
        ...publication,
        clientSessionId: "session-2",
        user: {
          id: "window-2",
          displayName: "Window 2",
          color: "#1971c2",
        },
      });
      expect(event.clientSessionId).toBe("session-2");
      expect(event.user.color).toBe("#1971c2");
      expect(() =>
        canonicalizeCanvasPresenceEvent({
          ...event,
          user: { ...event.user, color: "blue" },
        }),
      ).toThrow("color");
    });

    test("requires snapshots to contain current non-null peers only", () => {
      const event = {
        ...publication,
        clientSessionId: "session-2",
        user: {
          id: "window-2",
          displayName: "Window 2",
          color: "#1971c2",
        },
      };
      expect(
        canonicalizeCanvasPresenceRealtimeEvent({
          type: "canvas_presence_snapshot",
          libraryId: "library-1",
          routingContext: { kind: "project", projectId: "project-1" },
          documentId: publication.documentId,
          generation: publication.generation,
          presences: [event],
        }),
      ).toMatchObject({ presences: [event] });
      expect(() =>
        canonicalizeCanvasPresenceRealtimeEvent({
          type: "canvas_presence_snapshot",
          libraryId: "library-1",
          routingContext: { kind: "project", projectId: "project-1" },
          documentId: publication.documentId,
          generation: publication.generation,
          presences: [{ ...event, state: null }],
        }),
      ).toThrow("snapshot crossed");
      expect(() =>
        canonicalizeCanvasPresenceRealtimeEvent({
          type: "canvas_presence_snapshot",
          libraryId: "library-1",
          routingContext: { kind: "project", projectId: "project-1" },
          documentId: publication.documentId,
          generation: publication.generation,
          presences: [event, event],
        }),
      ).toThrow("snapshot crossed");
      expect(() =>
        canonicalizeCanvasPresenceRealtimeEvent({
          type: "canvas_presence_snapshot",
          libraryId: "library-1",
          routingContext: { kind: "project", projectId: "project-1" },
          documentId: publication.documentId,
          generation: publication.generation,
          presences: Array.from({ length: 300 }, (_, index) => ({
            ...event,
            clientSessionId: `session-${index}`,
            user: {
              ...event.user,
              id: `window-${index}`,
              displayName: `Window ${index} ${"x".repeat(100)}`,
            },
          })),
        }),
      ).toThrow("byte bound");
    });
  });
});

describe("document revision retention", () => {
  const NOW = "2026-07-16T12:00:00.000Z";
  const ago = (milliseconds: number): string =>
    new Date(Date.parse(NOW) - milliseconds).toISOString();
  const day = 24 * 60 * 60_000;

  describe("Document revision retention", () => {
    test("keeps recent and pinned revisions while selecting hourly and daily representatives", () => {
      const plan = planDocumentRevisionRetention(
        [
          { versionId: "recent-a", createdAt: ago(day), pinned: false },
          { versionId: "recent-b", createdAt: ago(6 * day), pinned: false },
          {
            versionId: "hour-new",
            createdAt: ago(8 * day + 60_000),
            pinned: false,
          },
          {
            versionId: "hour-old",
            createdAt: new Date(Date.parse(ago(8 * day + 60_000)) - 1_000).toISOString(),
            pinned: false,
          },
          { versionId: "day-new", createdAt: ago(31 * day), pinned: false },
          {
            versionId: "day-old",
            createdAt: new Date(Date.parse(ago(31 * day)) - 60_000).toISOString(),
            pinned: false,
          },
          { versionId: "expired", createdAt: ago(91 * day), pinned: false },
          { versionId: "pinned", createdAt: ago(500 * day), pinned: true },
        ],
        NOW,
      );
      expect(plan.retainedVersionIds).toEqual([
        "recent-a",
        "recent-b",
        "hour-new",
        "day-new",
        "pinned",
      ]);
      expect(plan.deletedVersionIds).toEqual(["hour-old", "day-old", "expired"]);
    });

    test("caps only unpinned survivors", () => {
      const candidates = Array.from(
        { length: MAX_UNPINNED_DOCUMENT_REVISIONS + 20 },
        (_, index) => ({
          versionId: `auto-${index.toString().padStart(3, "0")}`,
          createdAt: new Date(Date.parse(NOW) - index * 1_000).toISOString(),
          pinned: false,
        }),
      );
      candidates.push({
        versionId: "named",
        createdAt: ago(1_000 * day),
        pinned: true,
      });
      const plan = planDocumentRevisionRetention(candidates, NOW);
      expect(plan.retainedVersionIds).toHaveLength(MAX_UNPINNED_DOCUMENT_REVISIONS + 1);
      expect(plan.retainedVersionIds).toContain("named");
      expect(plan.deletedVersionIds).toHaveLength(20);
    });
  });
});

describe("recovery bundle", () => {
  const capture = (state: number[]): RecoveryDraftCapture => ({
    draft_id: "draft",
    document_id: "document",
    source_store_epoch: "epoch",
    generation: 1,
    base_head_seq: 0,
    created_at: "2026-09-12",
    schema_key: "page",
    schema_version: 1,
    content: { kind: "yjs", state, unintegrated_updates: [[], [255, 0]] },
    source: { state, submission: { update: state, id: "原始" }, unknown: { $bytes: "unchanged" } },
  });

  describe("retained recovery bundle", () => {
    it("retains shared state once and hashes the exact frozen bytes", async () => {
      const state = Array.from({ length: 70_020 }, (_, index) => index % 256);
      const frozen = await encodeRecoveryBundle(capture(state), "revision");
      expect(frozen.bytes.length).toBeLessThan(73_000);
      expect(frozen.payloadHash).toBe(await recoveryPayloadHash(frozen.bytes));
      expect(frozen.sourceRevision).toBe("revision");
      const size = new DataView(frozen.bytes.buffer).getUint32(8, true);
      const manifest = JSON.parse(new TextDecoder().decode(frozen.bytes.subarray(12, 12 + size)));
      expect(manifest.content.state).toBe(manifest.source_references[0].section_id);
      expect(manifest.source_references[1].section_id).toBe(manifest.content.state);
      const offset = 12 + size;
      expect(frozen.bytes.subarray(offset, offset + state.length)).toEqual(Uint8Array.from(state));
    });

    it("preserves arbitrary source keys and Canvas scene objects as evidence", async () => {
      const scene = { elements: [{ id: "shape", color: [0, 128, 255] }], files: {} };
      const value = {
        ...capture([]),
        content: { kind: "canvas" as const, scene, mutations: [{ key: "$bytes" }] },
        source: { scene, extension: { "a/b~c": "原始" } },
      };
      const result = await encodeRecoveryBundle(value, "canvas:revision");
      const view = new DataView(result.bytes.buffer);
      const size = view.getUint32(8, true);
      const manifest = JSON.parse(new TextDecoder().decode(result.bytes.subarray(12, 12 + size)));
      let offset = 12 + size;
      const payloads = new Map<string, unknown>();
      for (const section of manifest.sections) {
        const bytes = result.bytes.subarray(offset, offset + section.byte_length);
        expect(await recoveryPayloadHash(bytes)).toBe(section.sha256);
        payloads.set(section.id, JSON.parse(new TextDecoder().decode(bytes)));
        offset += section.byte_length;
      }
      expect(payloads.get(manifest.content.scene)).toEqual(scene);
      expect(await decodeRecoverySource(result.bytes)).toEqual(value.source);
      expect(offset).toBe(result.bytes.length);
    });
  });

  it("rejects damaged, truncated and future bundles without producing partial evidence", async () => {
    const { bytes } = await encodeRecoveryBundle(
      capture(Array.from({ length: 512 }, (_, i) => i % 256)),
      "revision",
    );
    expect(await decodeRecoverySource(bytes)).toEqual(
      capture(Array.from({ length: 512 }, (_, i) => i % 256)).source,
    );
    for (const length of [0, 11, 12, bytes.length - 1])
      await expect(decodeRecoverySource(bytes.subarray(0, length))).rejects.toThrow();
    const damaged = bytes.slice();
    damaged[damaged.length - 1] ^= 1;
    await expect(decodeRecoverySource(damaged)).rejects.toThrow();
    const future = bytes.slice();
    future[4] = 2;
    await expect(decodeRecoverySource(future)).rejects.toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    await expect(decodeRecoverySource(trailing)).rejects.toThrow();
  });
});
