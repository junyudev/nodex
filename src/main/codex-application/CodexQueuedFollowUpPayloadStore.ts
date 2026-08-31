import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getAssetSource, parseAssetSource } from "../../shared/assets";
import type {
  CodexQueuedFollowUp,
  CodexQueuedFollowUpPayloadRef,
} from "../../shared/codex-queued-follow-up-state";
import { CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION } from "../../shared/codex-queued-follow-up-state";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type { CodexLiveFileAttachment, CodexPromptInput } from "../../shared/types";
import { publishContentAddressedAsset, resolveAssetPathInRoot } from "../local-store/assets";
import { ProfileAssets } from "../local-store/ProfileAssets";

const MANIFEST_FILE_PREFIX = "queued-follow-up-v1-";
const PAYLOAD_ASSET_FILE_PREFIX = "queued-follow-up-payload-";

interface QueuedFollowUpAssetReference {
  readonly asset_uri: string;
  readonly sha256: string;
  readonly byte_length: number;
}

interface QueuedFollowUpManifestPayload {
  readonly prompt: string;
  readonly prompt_input: CodexPromptInput;
  readonly collaboration_mode: CodexQueuedFollowUp["collaborationMode"];
  readonly service_tier: CodexQueuedFollowUp["serviceTier"];
  readonly summary: CodexQueuedFollowUp["summary"];
}

interface QueuedFollowUpPayloadManifest {
  readonly schema_version: typeof CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION;
  readonly payload: QueuedFollowUpManifestPayload;
  readonly asset_references: readonly QueuedFollowUpAssetReference[];
}

export interface CodexQueuedFollowUpDurableEntry {
  readonly followUpId: string;
  readonly clientUserMessageId: string;
  readonly threadId: string;
  readonly createdAtMs: number;
  readonly pause: CodexQueuedFollowUp["pause"];
  readonly payloadRef: CodexQueuedFollowUpPayloadRef;
}

export class CodexQueuedFollowUpPayloadStoreError extends Schema.TaggedError<CodexQueuedFollowUpPayloadStoreError>()(
  "CodexQueuedFollowUpPayloadStoreError",
  {
    operation: Schema.Literals(["freeze", "hydrate"]),
    cause: Schema.Defect(),
  },
) {}

export class CodexQueuedFollowUpPayloadStore extends Context.Service<
  CodexQueuedFollowUpPayloadStore,
  {
    readonly freeze: (
      row: CodexQueuedFollowUp,
    ) => Effect.Effect<CodexQueuedFollowUp, CodexQueuedFollowUpPayloadStoreError>;
    readonly hydrate: (
      entry: CodexQueuedFollowUpDurableEntry,
    ) => Effect.Effect<CodexQueuedFollowUp, CodexQueuedFollowUpPayloadStoreError>;
  }
>()("nodex/main/codex-application/CodexQueuedFollowUpPayloadStore") {}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeExtension(value: string): string {
  const extension = path.extname(value).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/u.test(extension) ? extension : "";
}

function decodeImageDataUrl(value: string): { readonly bytes: Buffer; readonly extension: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/u.exec(
    value,
  );
  if (!match?.[1] || !match[2]) throw new Error("Queued image must be a valid image data URL");
  const extension = match[1] === "image/jpeg" ? ".jpg" : `.${match[1].slice("image/".length)}`;
  return { bytes: Buffer.from(match[2].replace(/\s+/gu, ""), "base64"), extension };
}

function publishPortableAsset(assetsRootPath: string, bytes: Buffer, extension: string): string {
  const contentHash = sha256(bytes);
  const fileName = `${PAYLOAD_ASSET_FILE_PREFIX}${contentHash}${extension}`;
  publishContentAddressedAsset(assetsRootPath, fileName, bytes, contentHash);
  return getAssetSource(fileName);
}

function materializeSource(source: string, assetsRootPath: string): string {
  const normalized = source.trim();
  if (!normalized) throw new Error("Queued payload source cannot be empty");
  const managed = parseAssetSource(normalized);
  if (managed) return normalized;
  if (normalized.startsWith("nodex://assets/")) {
    throw new Error("Queued payload contains an invalid managed asset URI");
  }
  if (/^https?:\/\//u.test(normalized)) return normalized;
  if (normalized.startsWith("data:image/")) {
    const image = decodeImageDataUrl(normalized);
    return publishPortableAsset(assetsRootPath, image.bytes, image.extension);
  }
  if (normalized.startsWith("blob:")) {
    throw new Error("Queued payload contains a renderer-only object URL");
  }
  const localPath = normalized.startsWith("file:") ? fileURLToPath(normalized) : normalized;
  if (!path.isAbsolute(localPath)) {
    throw new Error("Queued payload contains a non-portable relative file source");
  }
  const bytes = fs.readFileSync(localPath);
  return publishPortableAsset(assetsRootPath, bytes, safeExtension(localPath));
}

function freezeFileAttachment(
  attachment: CodexLiveFileAttachment,
  assetsRootPath: string,
): CodexLiveFileAttachment {
  const source = materializeSource(attachment.fsPath || attachment.path, assetsRootPath);
  if (!parseAssetSource(source)) return { ...attachment };
  return { ...attachment, path: source, fsPath: source };
}

function hydrateFileAttachment(
  attachment: CodexLiveFileAttachment,
  assetsRootPath: string,
): CodexLiveFileAttachment {
  const managed = parseAssetSource(attachment.fsPath) ?? parseAssetSource(attachment.path);
  if (!managed) return { ...attachment };
  const absolutePath = resolveAssetPathInRoot(assetsRootPath, managed.fileName);
  return { ...attachment, path: absolutePath, fsPath: absolutePath };
}

function freezePromptInput(input: CodexPromptInput, assetsRootPath: string): CodexPromptInput {
  return {
    ...input,
    ...(input.images
      ? {
          images: input.images.map((image) => ({
            ...image,
            source: materializeSource(image.source, assetsRootPath),
          })),
        }
      : {}),
    ...(input.appshots
      ? {
          appshots: input.appshots.map((appshot) => ({
            ...appshot,
            imageDataUrl: materializeSource(appshot.imageDataUrl, assetsRootPath),
          })),
        }
      : {}),
    ...(input.fileAttachments
      ? {
          fileAttachments: input.fileAttachments.map((attachment) =>
            freezeFileAttachment(attachment, assetsRootPath),
          ),
        }
      : {}),
    ...(input.addedFiles
      ? {
          addedFiles: input.addedFiles.map((attachment) =>
            freezeFileAttachment(attachment, assetsRootPath),
          ),
        }
      : {}),
    ...(input.textAttachments
      ? {
          textAttachments: input.textAttachments.map((attachment) =>
            attachment.file
              ? {
                  ...attachment,
                  file: freezeFileAttachment(attachment.file, assetsRootPath),
                }
              : { ...attachment },
          ),
        }
      : {}),
    ...(input.browserAnnotationAttachments
      ? {
          browserAnnotationAttachments: input.browserAnnotationAttachments.map((attachment) => ({
            ...attachment,
            ...(attachment.evidence
              ? {
                  evidence: {
                    ...attachment.evidence,
                    source: materializeSource(attachment.evidence.source, assetsRootPath),
                  },
                }
              : {}),
          })),
        }
      : {}),
  };
}

function hydratePromptInput(input: CodexPromptInput, assetsRootPath: string): CodexPromptInput {
  return {
    ...input,
    ...(input.fileAttachments
      ? {
          fileAttachments: input.fileAttachments.map((attachment) =>
            hydrateFileAttachment(attachment, assetsRootPath),
          ),
        }
      : {}),
    ...(input.addedFiles
      ? {
          addedFiles: input.addedFiles.map((attachment) =>
            hydrateFileAttachment(attachment, assetsRootPath),
          ),
        }
      : {}),
    ...(input.textAttachments
      ? {
          textAttachments: input.textAttachments.map((attachment) =>
            attachment.file
              ? {
                  ...attachment,
                  file: hydrateFileAttachment(attachment.file, assetsRootPath),
                }
              : { ...attachment },
          ),
        }
      : {}),
  };
}

function collectManagedAssetUris(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (parseAssetSource(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectManagedAssetUris(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const entry of Object.values(value)) collectManagedAssetUris(entry, found);
  return found;
}

function evidenceForAsset(assetUri: string, assetsRootPath: string): QueuedFollowUpAssetReference {
  const parsed = parseAssetSource(assetUri);
  if (!parsed) throw new Error("Queued payload contains an invalid managed asset URI");
  const bytes = fs.readFileSync(resolveAssetPathInRoot(assetsRootPath, parsed.fileName));
  return { asset_uri: assetUri, sha256: sha256(bytes), byte_length: bytes.byteLength };
}

function parseManifestPayload(value: unknown): QueuedFollowUpManifestPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Queued follow-up payload is invalid");
  }
  const payload = value as Partial<QueuedFollowUpManifestPayload>;
  if (
    typeof payload.prompt !== "string" ||
    !payload.prompt_input ||
    typeof payload.prompt_input !== "object"
  ) {
    throw new Error("Queued follow-up payload is incomplete");
  }
  return payload as QueuedFollowUpManifestPayload;
}

function parseManifestAssetReferences(value: unknown): readonly QueuedFollowUpAssetReference[] {
  if (!Array.isArray(value)) {
    throw new Error("Queued follow-up payload asset references are invalid");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Queued follow-up payload asset reference is invalid");
    }
    const reference = entry as Partial<QueuedFollowUpAssetReference>;
    if (
      typeof reference.asset_uri !== "string" ||
      typeof reference.sha256 !== "string" ||
      typeof reference.byte_length !== "number"
    ) {
      throw new Error("Queued follow-up payload asset reference is incomplete");
    }
    return {
      asset_uri: reference.asset_uri,
      sha256: reference.sha256,
      byte_length: reference.byte_length,
    };
  });
}

function validateManifestAssets(
  payload: QueuedFollowUpManifestPayload,
  references: readonly QueuedFollowUpAssetReference[],
  assetsRootPath: string,
): void {
  const embedded = [...collectManagedAssetUris(payload)].sort((left, right) =>
    left.localeCompare(right),
  );
  const listed = references.map((reference) => reference.asset_uri);
  if (
    embedded.length !== listed.length ||
    embedded.some((assetUri, index) => assetUri !== listed[index])
  ) {
    throw new Error("Queued follow-up payload asset references do not match its locators");
  }
  for (const reference of references) {
    const actual = evidenceForAsset(reference.asset_uri, assetsRootPath);
    if (actual.sha256 !== reference.sha256 || actual.byte_length !== reference.byte_length) {
      throw new Error("Queued follow-up payload asset evidence does not match its file");
    }
  }
}

function freezeAtRoot(row: CodexQueuedFollowUp, assetsRootPath: string): CodexQueuedFollowUp {
  const promptInput = freezePromptInput(row.promptInput, assetsRootPath);
  const payload: QueuedFollowUpManifestPayload = {
    prompt: row.prompt,
    prompt_input: promptInput,
    collaboration_mode: row.collaborationMode,
    service_tier: row.serviceTier,
    summary: row.summary,
  };
  const assetReferences = [...collectManagedAssetUris(payload)]
    .sort((left, right) => left.localeCompare(right))
    .map((assetUri) => evidenceForAsset(assetUri, assetsRootPath));
  const manifest: QueuedFollowUpPayloadManifest = {
    schema_version: CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION,
    payload,
    asset_references: assetReferences,
  };
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const contentHash = sha256(bytes);
  const fileName = `${MANIFEST_FILE_PREFIX}${contentHash}.json`;
  publishContentAddressedAsset(assetsRootPath, fileName, bytes, contentHash);
  return {
    ...row,
    promptInput,
    payloadRef: {
      schemaVersion: CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION,
      assetUri: getAssetSource(fileName),
      sha256: contentHash,
      byteLength: bytes.byteLength,
    },
  };
}

function hydrateAtRoot(
  entry: CodexQueuedFollowUpDurableEntry,
  assetsRootPath: string,
): CodexQueuedFollowUp {
  const parsed = parseAssetSource(entry.payloadRef.assetUri);
  if (!parsed) throw new Error("Queued follow-up manifest URI is invalid");
  const bytes = fs.readFileSync(resolveAssetPathInRoot(assetsRootPath, parsed.fileName));
  if (
    bytes.byteLength !== entry.payloadRef.byteLength ||
    sha256(bytes) !== entry.payloadRef.sha256
  ) {
    throw new Error("Queued follow-up manifest evidence does not match its file");
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as Partial<QueuedFollowUpPayloadManifest>;
  if (manifest.schema_version !== CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION) {
    throw new Error("Queued follow-up manifest schema is unsupported");
  }
  const payload = parseManifestPayload(manifest.payload);
  const references = parseManifestAssetReferences(manifest.asset_references);
  validateManifestAssets(payload, references, assetsRootPath);
  return {
    followUpId: entry.followUpId,
    clientUserMessageId: entry.clientUserMessageId,
    threadId: entry.threadId,
    prompt: payload.prompt,
    promptInput: hydratePromptInput(payload.prompt_input, assetsRootPath),
    createdAtMs: entry.createdAtMs,
    collaborationMode: payload.collaboration_mode ?? null,
    serviceTier: normalizeCodexServiceTier(payload.service_tier),
    summary: payload.summary ?? null,
    pause: entry.pause,
    payloadRef: entry.payloadRef,
  };
}

export function makeCodexQueuedFollowUpPayloadStore(
  assetsRootPath: string,
): CodexQueuedFollowUpPayloadStore["Service"] {
  const attempt = <A>(
    operation: "freeze" | "hydrate",
    evaluate: () => A,
  ): Effect.Effect<A, CodexQueuedFollowUpPayloadStoreError> =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new CodexQueuedFollowUpPayloadStoreError({ operation, cause }),
    });
  return CodexQueuedFollowUpPayloadStore.of({
    freeze: (row) => attempt("freeze", () => freezeAtRoot(row, assetsRootPath)),
    hydrate: (entry) => attempt("hydrate", () => hydrateAtRoot(entry, assetsRootPath)),
  });
}

export const codexQueuedFollowUpPayloadStoreLive: Layer.Layer<
  CodexQueuedFollowUpPayloadStore,
  never,
  ProfileAssets
> = Layer.effect(
  CodexQueuedFollowUpPayloadStore,
  Effect.gen(function* () {
    const assets = yield* ProfileAssets;
    return makeCodexQueuedFollowUpPayloadStore(assets.rootPath);
  }),
);
