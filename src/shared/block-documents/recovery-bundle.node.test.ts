import { describe, expect, it } from "vitest";
import { encodeRecoveryBundle, recoveryPayloadHash, decodeRecoverySource } from "./recovery-bundle";
import type { RecoveryDraftCapture } from "./document-recovery";

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
