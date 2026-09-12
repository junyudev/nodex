import { CORE_TRANSPORT_BUDGETS, type components } from "@nodex/core-protocol";
import type { RecoveryDraftCapture } from "./document-recovery";

type Manifest = components["schemas"]["RecoveryBundleManifest"];
type Section = components["schemas"]["RecoveryBundleSection"];
type Reference = components["schemas"]["RecoveryEvidenceReference"];
const utf8 = new TextEncoder();

export class RecoveryBundleValidationError extends Error {
  readonly failure: components["schemas"]["RecoveryPackageFailure"];
  constructor(
    reason: components["schemas"]["RecoveryFailureReason"],
    message: string,
    actual?: number,
    limit?: number,
  ) {
    super(message);
    this.name = "RecoveryBundleValidationError";
    this.failure = { reason, effect: "not_applied", actual, limit };
  }
}

const validateManifestTree = (value: unknown): void => {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (
      depth > CORE_TRANSPORT_BUDGETS.recovery_manifest_depth ||
      nodes > CORE_TRANSPORT_BUDGETS.recovery_manifest_nodes
    )
      throw new RecoveryBundleValidationError(
        "invalid_manifest",
        "Recovery metadata exceeds its structural limit",
      );
    if (typeof value === "object" && value !== null)
      for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
  }
};

export const recoveryPayloadHash = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

type YjsCapture = Extract<RecoveryDraftCapture["content"], { kind: "yjs" }>;
export type RecoveryBundleInput = Omit<RecoveryDraftCapture, "content" | "source"> & {
  readonly source: unknown;
  readonly content:
    | Exclude<RecoveryDraftCapture["content"], YjsCapture>
    | {
        readonly kind: "yjs";
        readonly state: readonly number[] | Uint8Array;
        readonly unintegrated_updates: readonly (readonly number[] | Uint8Array)[];
      };
};

export interface FrozenRecoveryBundle {
  readonly bytes: Uint8Array;
  readonly payloadHash: string;
  readonly draftId: string;
  readonly sourceRevision: string;
}

/** Freeze once, persist these exact bytes, and compare their digest before acknowledging staging. */
export const encodeRecoveryBundle = async (
  capture: RecoveryBundleInput,
  sourceRevision: string,
): Promise<FrozenRecoveryBundle> => {
  const sections: Section[] = [];
  const bodies: Uint8Array[] = [];
  let sectionBytes = 0;
  const add = async (encoding: Section["encoding"], bytes: Uint8Array): Promise<string> => {
    const hash = await recoveryPayloadHash(bytes);
    const existing = sections.findIndex(
      (section, index) =>
        section.encoding === encoding &&
        section.sha256 === hash &&
        bodies[index].length === bytes.length &&
        bodies[index].every((byte, offset) => byte === bytes[offset]),
    );
    if (existing >= 0) return sections[existing].id;
    if (sections.length >= CORE_TRANSPORT_BUDGETS.recovery_sections)
      throw new RecoveryBundleValidationError(
        "invalid_manifest",
        "Recovery has too many content sections",
        sections.length + 1,
        CORE_TRANSPORT_BUDGETS.recovery_sections,
      );
    sectionBytes += bytes.length;
    if (sectionBytes > CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes)
      throw new RecoveryBundleValidationError(
        "request_too_large",
        "The complete retained package exceeds the 32 MiB receipt limit. Its original local copy remains exportable.",
        sectionBytes,
        CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes,
      );
    const id = String(sections.length);
    sections.push({ id, encoding, byte_length: bytes.length, sha256: hash });
    bodies.push(bytes);
    return id;
  };
  const jsonObjects = new WeakMap<object, string>();
  const json = async (value: unknown) => {
    const id = await add("json", utf8.encode(JSON.stringify(value)));
    if (typeof value === "object" && value !== null) jsonObjects.set(value, id);
    return id;
  };
  const bytes = (value: readonly number[] | Uint8Array) => add("bytes", Uint8Array.from(value));
  const content: Manifest["content"] =
    capture.content.kind === "yjs"
      ? {
          kind: "yjs",
          state: await bytes(capture.content.state),
          unintegrated_updates: await sequential(capture.content.unintegrated_updates, bytes),
        }
      : {
          kind: "canvas",
          scene: capture.content.scene == null ? null : await json(capture.content.scene),
          mutations: await sequential(capture.content.mutations, json),
        };
  const references: Reference[] = [];
  const extract = async (value: unknown, pointer: string, depth: number): Promise<unknown> => {
    if (depth > 64) throw new Error("Recovery evidence is too deeply nested");
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      references.push({
        pointer,
        section_id: await bytes(value instanceof ArrayBuffer ? new Uint8Array(value) : value),
        representation: value instanceof ArrayBuffer ? "array_buffer" : "uint8_array",
      });
      return null;
    }
    if (typeof value === "object" && value !== null) {
      const existing = jsonObjects.get(value);
      if (existing) {
        references.push({ pointer, section_id: existing });
        return null;
      }
    }
    if (Array.isArray(value)) {
      if (
        value.length >= 256 &&
        value.every(
          (item: unknown) =>
            typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255,
        )
      ) {
        references.push({ pointer, section_id: await bytes(value) });
        return null;
      }
      return sequential(value, (item, index) => extract(item, `${pointer}/${index}`, depth + 1));
    }
    if (value === null || typeof value !== "object") return value;
    const fields = await sequential(
      Object.entries(value),
      async ([key, item]) =>
        [
          key,
          await extract(
            item,
            `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            depth + 1,
          ),
        ] as const,
    );
    return Object.fromEntries(fields);
  };
  const source = await json(await extract(capture.source, "", 0));
  const manifest: Manifest = {
    format_version: 1,
    draft_id: capture.draft_id,
    document_id: capture.document_id,
    source_store_epoch: capture.source_store_epoch,
    source_revision: sourceRevision,
    generation: capture.generation,
    base_head_seq: capture.base_head_seq,
    created_at: capture.created_at,
    schema_key: capture.schema_key,
    schema_version: capture.schema_version,
    content,
    source,
    source_references: references,
    sections,
  };
  validateManifestTree(manifest);
  const metadata = utf8.encode(JSON.stringify(manifest));
  const length = bodies.reduce((sum, body) => sum + body.length, 12 + metadata.length);
  if (metadata.length > CORE_TRANSPORT_BUDGETS.recovery_manifest_bytes)
    throw new RecoveryBundleValidationError(
      "manifest_too_large",
      "Recovery metadata exceeds its receipt limit. Export retains the complete source.",
      metadata.length,
      CORE_TRANSPORT_BUDGETS.recovery_manifest_bytes,
    );
  if (length > CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes)
    throw new RecoveryBundleValidationError(
      "request_too_large",
      "The complete retained package exceeds the 32 MiB receipt limit. Its original local copy remains exportable.",
      length,
      CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes,
    );
  const output = new Uint8Array(length);
  output.set(utf8.encode("NDRB"));
  const header = new DataView(output.buffer);
  header.setUint32(4, 1, true);
  header.setUint32(8, metadata.length, true);
  output.set(metadata, 12);
  let offset = 12 + metadata.length;
  for (const body of bodies) {
    output.set(body, offset);
    offset += body.length;
  }
  return {
    bytes: output,
    payloadHash: await recoveryPayloadHash(output),
    draftId: capture.draft_id,
    sourceRevision,
  };
};

// Section ordering is part of the frozen representation; concurrent hashing must not reorder it.
const sequential = async <T, R>(
  items: readonly T[],
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const result: R[] = [];
  for (const [index, item] of items.entries()) result.push(await map(item, index));
  return result;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseManifest = (bytes: Uint8Array): Manifest => {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validateManifestTree(value);
  if (
    !record(value) ||
    value.format_version !== 1 ||
    ![
      "draft_id",
      "document_id",
      "source_store_epoch",
      "source_revision",
      "created_at",
      "schema_key",
      "source",
    ].every((key) => typeof value[key] === "string") ||
    !["generation", "base_head_seq", "schema_version"].every((key) =>
      Number.isSafeInteger(value[key]),
    ) ||
    !record(value.content) ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.source_references)
  )
    throw new Error("Invalid recovery manifest");
  const content = value.content;
  if (
    content.kind === "yjs"
      ? typeof content.state !== "string" || !stringList(content.unintegrated_updates)
      : content.kind !== "canvas" ||
        !(content.scene == null || typeof content.scene === "string") ||
        !stringList(content.mutations)
  )
    throw new Error("Invalid recovery content references");
  if (value.sections.length > CORE_TRANSPORT_BUDGETS.recovery_sections)
    throw new Error("Recovery sections exceed their bound");
  for (const section of value.sections) {
    if (
      !record(section) ||
      typeof section.id !== "string" ||
      !section.id ||
      (section.encoding !== "bytes" && section.encoding !== "json") ||
      typeof section.byte_length !== "number" ||
      !Number.isSafeInteger(section.byte_length) ||
      section.byte_length < 0 ||
      typeof section.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(section.sha256)
    )
      throw new Error("Invalid recovery section descriptor");
  }
  for (const reference of value.source_references) {
    if (
      !record(reference) ||
      typeof reference.pointer !== "string" ||
      typeof reference.section_id !== "string" ||
      !(
        reference.representation == null ||
        reference.representation === "uint8_array" ||
        reference.representation === "array_buffer"
      )
    )
      throw new Error("Invalid recovery evidence reference");
  }
  return value as Manifest;
};

/** Verified section views keep repeated source references shared instead of expanding byte arrays. */
export const decodeRecoveryBundleSections = async (bytes: Uint8Array) => {
  if (bytes.length < 12 || bytes.length > CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes)
    throw new Error("Recovery bundle exceeds its bounds");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "NDRB" || header.getUint32(4, true) !== 1)
    throw new Error("Unsupported recovery bundle format");
  const length = header.getUint32(8, true);
  if (length > CORE_TRANSPORT_BUDGETS.recovery_manifest_bytes || length > bytes.length - 12)
    throw new Error("Invalid recovery manifest length");
  const manifest = parseManifest(bytes.subarray(12, 12 + length));
  const sections = new Map<string, { encoding: Section["encoding"]; bytes: Uint8Array }>();
  let offset = 12 + length;
  for (const section of manifest.sections) {
    if (section.byte_length > bytes.length - offset || sections.has(section.id))
      throw new Error("Invalid recovery section length or identity");
    const body = bytes.subarray(offset, offset + section.byte_length);
    if ((await recoveryPayloadHash(body)) !== section.sha256)
      throw new Error("Recovery section digest does not match");
    sections.set(section.id, { encoding: section.encoding, bytes: body });
    offset += section.byte_length;
  }
  if (offset !== bytes.length) throw new Error("Trailing recovery bytes");
  const read = (id: string, encoding?: Section["encoding"]) => {
    const section = sections.get(id);
    if (!section || (encoding && section.encoding !== encoding))
      throw new Error("Missing recovery section or invalid encoding");
    return section;
  };
  const json = (id: string): unknown =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read(id, "json").bytes));
  return { manifest, read, json };
};

/** Reconstructs the original source envelope, including typed arrays used by renderer checkpoints. */
export const decodeRecoverySource = async (bytes: Uint8Array): Promise<unknown> => {
  const { manifest, read, json } = await decodeRecoveryBundleSections(bytes);
  let source = json(manifest.source);
  const pointers = new Set<string>();
  const values = new Map<string, unknown>();
  for (const reference of manifest.source_references) {
    if (pointers.has(reference.pointer)) throw new Error("Duplicate recovery evidence reference");
    pointers.add(reference.pointer);
    const section = read(reference.section_id);
    if (reference.representation != null && section.encoding !== "bytes")
      throw new RecoveryBundleValidationError(
        "invalid_manifest",
        "Invalid recovery source representation",
      );
    const cacheKey = `${reference.section_id}:${reference.representation ?? "array"}`;
    let value = values.get(cacheKey);
    if (!values.has(cacheKey)) {
      value =
        section.encoding === "json"
          ? json(reference.section_id)
          : reference.representation === "uint8_array"
            ? section.bytes.slice()
            : reference.representation === "array_buffer"
              ? section.bytes.slice().buffer
              : Array.from(section.bytes);
      values.set(cacheKey, value);
    }
    if (!reference.pointer) {
      if (source !== null) throw new Error("Recovery evidence replaces existing content");
      source = value;
      continue;
    }
    if (!reference.pointer.startsWith("/")) throw new Error("Invalid recovery evidence location");
    const parts = reference.pointer
      .slice(1)
      .split("/")
      .map((part) => {
        if (/~[^01]|~$/u.test(part)) throw new Error("Invalid recovery evidence escape");
        return part.replaceAll("~1", "/").replaceAll("~0", "~");
      });
    let target: unknown = source;
    for (const part of parts.slice(0, -1)) {
      if ((!record(target) && !Array.isArray(target)) || !Object.hasOwn(target, part))
        throw new Error("Missing recovery evidence location");
      target = (target as Record<string, unknown>)[part];
    }
    const key = parts.at(-1)!;
    if (
      (!record(target) && !Array.isArray(target)) ||
      !Object.hasOwn(target, key) ||
      (target as Record<string, unknown>)[key] !== null
    )
      throw new Error("Recovery evidence replaces existing content");
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return source;
};

/** Local exports use the same self-describing container; oversized legacy sources need no Core upload. */
export const encodeRecoveryExport = async (
  payload: Uint8Array,
  metadata: { draftId: string; documentId: string; encoding: string; expectedPayloadHash?: string },
): Promise<Uint8Array> => {
  const companion = utf8.encode("null");
  const manifest = {
    format_version: 1,
    draft_id: metadata.draftId,
    document_id: metadata.documentId,
    payload_encoding: metadata.encoding,
    payload_byte_length: payload.length,
    payload_sha256: await recoveryPayloadHash(payload),
    expected_payload_sha256: metadata.expectedPayloadHash ?? null,
    companion_byte_length: companion.length,
    companion_sha256: await recoveryPayloadHash(companion),
    external_files: true,
  } satisfies components["schemas"]["RecoveryExportManifest"];
  const header = utf8.encode(JSON.stringify(manifest));
  const output = new Uint8Array(12 + header.length + payload.length + companion.length);
  output.set(utf8.encode("NDRE"));
  new DataView(output.buffer).setUint32(4, 1, true);
  new DataView(output.buffer).setUint32(8, header.length, true);
  output.set(header, 12);
  output.set(payload, 12 + header.length);
  output.set(companion, 12 + header.length + payload.length);
  return output;
};
