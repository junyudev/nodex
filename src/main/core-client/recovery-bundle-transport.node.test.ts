import { CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";
import { CoreHttpError } from "./uds-http";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import {
  encodeRecoveryBundle,
  recoveryPayloadHash,
  decodeRecoverySource,
} from "../../shared/block-documents/recovery-bundle";
import type { RecoveryDraftCapture } from "../../shared/block-documents/document-recovery";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../shared/block-documents/page-document";

test("retains a 70 KB package through the authenticated binary route with an exact receipt", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const documentId = ctx.manifest.entityIdsByKey!.sourceDocument!;
    const state = Array.from({ length: 70_020 }, (_, index) => index % 256);
    const capture: RecoveryDraftCapture = {
      draft_id: "draft:binary-transport",
      document_id: documentId,
      source_store_epoch: ctx.runtime.identity.storeEpoch,
      generation: 1,
      base_head_seq: 0,
      created_at: new Date().toISOString(),
      schema_key: PAGE_DOCUMENT_SCHEMA_KEY,
      schema_version: PAGE_DOCUMENT_SCHEMA_VERSION,
      content: { kind: "yjs", state, unintegrated_updates: [] },
      source: { state, originalSubmission: { update: state, updateId: "original:update" } },
    };
    const frozen = await encodeRecoveryBundle(capture, capture.draft_id);
    const command = {
      operationId: "recovery:binary-transport",
      clientSessionId: "recovery:test",
      intent: { kind: "capture_recovery" as const, capture },
    };
    const result = await ctx.client.documentApply(command);
    expect(result.outcome.recovery_capture).toEqual({
      draft_id: capture.draft_id,
      source_revision: capture.draft_id,
      submitted_payload_hash: frozen.payloadHash,
      stored_payload_hash: frozen.payloadHash,
      stored_encoding: "bundle_v1",
      stored_byte_length: frozen.bytes.length,
    });
    const retry = await ctx.client.documentApply(command);
    expect(retry.outcome.recovery_capture).toEqual(result.outcome.recovery_capture);
    expect(retry.receipt.duplicate).toBe(true);
    const read = await ctx.client.documentRead("recovery:test", {
      kind: "recovery",
      read: { kind: "inspect", draft_id: capture.draft_id },
    });
    if (read.value.kind !== "recovery" || read.value.value.kind !== "inspect")
      throw new Error("Expected retained draft");
    expect(JSON.stringify(read.value.value.inspection).length).toBeLessThan(4096);
    const exported = await ctx.client.documentExportRecovery(capture.draft_id);
    expect(new TextDecoder().decode(exported.subarray(0, 4))).toBe("NDRE");
    const manifestLength = new DataView(
      exported.buffer,
      exported.byteOffset,
      exported.byteLength,
    ).getUint32(8, true);
    const manifest = JSON.parse(
      new TextDecoder().decode(exported.subarray(12, 12 + manifestLength)),
    ) as { payload_byte_length: number; payload_sha256: string };
    expect(manifest.payload_sha256).toBe(frozen.payloadHash);
    expect(
      new Uint8Array(
        exported.subarray(12 + manifestLength, 12 + manifestLength + manifest.payload_byte_length),
      ),
    ).toEqual(frozen.bytes);
    expect(read.value.value.inspection.can_restore).toBe(false);
    const inspection = read.value.value.inspection;
    const reconciliation = await ctx.client.documentApply({
      operationId: "recovery:uncontained-check",
      clientSessionId: "recovery:test",
      intent: {
        kind: "resolve_recovery",
        resolve: {
          draft_id: capture.draft_id,
          revision: inspection.summary.revision,
          expected_generation: inspection.current_generation,
          expected_head_seq: inspection.current_head_seq,
          choice: { kind: "reconcile" },
        },
      },
    });
    expect(reconciliation.status).toBe("no_op");
    expect(reconciliation.outcome.recovery?.resolution).toBeNull();
  });
});

test("large retained evidence has bounded inspection and exports every original byte", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const capture: RecoveryDraftCapture = {
      draft_id: "draft:large-evidence",
      document_id: ctx.manifest.entityIdsByKey!.sourceDocument!,
      source_store_epoch: ctx.runtime.identity.storeEpoch,
      generation: 1,
      base_head_seq: 0,
      created_at: new Date().toISOString(),
      schema_key: PAGE_DOCUMENT_SCHEMA_KEY,
      schema_version: PAGE_DOCUMENT_SCHEMA_VERSION,
      content: { kind: "yjs", state: [255, 0, 128], unintegrated_updates: [[128, 255]] },
      source: {
        evidence: "x".repeat(18 * 1024 * 1024),
        originalSubmission: { updateId: "unconfirmed-original", update: [128, 255] },
      },
    };
    const bundle = await encodeRecoveryBundle(capture, "source:large");
    const result = await ctx.client.documentCaptureRecovery({
      operationId: "capture:large-evidence",
      clientSessionId: "recovery:test",
      bundle,
    });
    expect(result.outcome.recovery_capture?.stored_byte_length).toBeGreaterThan(18 * 1024 * 1024);
    const read = await ctx.client.documentRead("recovery:test", {
      kind: "recovery",
      read: { kind: "inspect", draft_id: capture.draft_id },
    });
    expect(JSON.stringify(read).length).toBeLessThan(64 * 1024);
    const exported = await ctx.client.documentExportRecovery(capture.draft_id);
    const length = new DataView(exported.buffer, exported.byteOffset).getUint32(8, true);
    const payload = exported.subarray(12 + length, 12 + length + bundle.bytes.length);
    expect(await recoveryPayloadHash(payload)).toBe(bundle.payloadHash);
    expect(await decodeRecoverySource(payload)).toEqual(capture.source);
  });
});

test("capture admission reports the exact byte capacity and a definitive rejection", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const limit = CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes;
    const bytes = new Uint8Array(limit + 1);
    const error = await ctx.client
      .documentCaptureRecovery({
        operationId: "capture:over-capacity",
        clientSessionId: "recovery:test",
        bundle: {
          bytes,
          draftId: "draft:over-capacity",
          sourceRevision: "revision:over-capacity",
          payloadHash: await recoveryPayloadHash(bytes),
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(error).toBeInstanceOf(CoreHttpError);
    if (!(error instanceof CoreHttpError)) throw new Error("Expected the bounded HTTP rejection");
    expect(error.status).toBe(413);
    expect(error.failure).toEqual({
      reason: "request_too_large",
      effect: "not_applied",
      actual: bytes.length,
      limit,
    });
    const listed = await ctx.client.documentRead("recovery:test", {
      kind: "recovery",
      read: { kind: "list", include_resolved: true, limit: 50 },
    });
    if (listed.value.kind !== "recovery" || listed.value.value.kind !== "list")
      throw new Error("Expected recovery list");
    expect(listed.value.value.page.drafts).toEqual([]);
  });
});
