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
import type {
  CodexLiveFileAttachment,
  CodexPreparedPrompt,
  CodexPromptInput,
} from "../../shared/types";
import {
  getMimeTypeForAssetFile,
  cacheContentAddressedBytes,
  resolveAssetPathInRoot,
} from "../local-store/assets";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { MainConfig } from "../app/MainConfig";
import { TemporaryAssets } from "../local-store/TemporaryAssets";

const MAX_BLOB_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

interface FreezeContext {
  readonly stagingRootPath: string;
  readonly sourceAssetsRootPath: string;
  readonly references: Map<string, QueuedFollowUpAssetReference>;
}

interface QueuedFollowUpAssetReference {
  readonly asset_uri: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly mime_type: string;
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

export class CodexInputAssetsError extends Schema.TaggedError<CodexInputAssetsError>()(
  "CodexInputAssetsError",
  {
    operation: Schema.Literals(["freeze", "hydrate", "publish", "retain"]),
    cause: Schema.Defect(),
  },
) {}

export class CodexInputAssets extends Context.Service<
  CodexInputAssets,
  {
    readonly retainPrepared: (
      threadId: string,
      submissionId: string,
      prepared: CodexPreparedPrompt,
      localExecution: boolean,
    ) => Effect.Effect<CodexPreparedPrompt, CodexInputAssetsError>;
    readonly freeze: (
      row: CodexQueuedFollowUp,
    ) => Effect.Effect<CodexQueuedFollowUp, CodexInputAssetsError>;
    readonly publish: (
      threadId: string,
      operationId: string,
      rows: readonly CodexQueuedFollowUp[],
    ) => Effect.Effect<readonly string[], CodexInputAssetsError>;
    readonly hydrate: (
      entry: CodexQueuedFollowUpDurableEntry,
    ) => Effect.Effect<CodexQueuedFollowUp, CodexInputAssetsError>;
  }
>()("nodex/main/codex-application/CodexInputAssets") {}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeMediaDataUrl(value: string): { readonly bytes: Buffer; readonly mimeType: string } {
  const match = /^data:((?:image|audio)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("Input media must be a valid data URL");
  return { bytes: Buffer.from(match[2].replace(/\s+/gu, ""), "base64"), mimeType: match[1] };
}

function sourceMimeType(source: string, media?: "image" | "audio"): string {
  if (media !== "audio") return getMimeTypeForAssetFile(source);
  const extension = path.extname(source).toLowerCase();
  const audio: Readonly<Record<string, string>> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
  };
  return audio[extension] ?? "application/octet-stream";
}

function readBoundedFile(filePath: string, maximumBytes = MAX_BLOB_BYTES): Buffer {
  if (fs.statSync(filePath).size > maximumBytes)
    throw new Error("Input attachment exceeds its byte limit");
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength > maximumBytes)
    throw new Error("Input attachment changed beyond its byte limit");
  return bytes;
}

function publishPortableAsset(context: FreezeContext, bytes: Buffer, mimeType: string): string {
  if (bytes.byteLength > MAX_BLOB_BYTES) throw new Error("Input attachment exceeds its byte limit");
  const contentHash = sha256(bytes);
  const fileName = `${contentHash}.blob`;
  cacheContentAddressedBytes(context.stagingRootPath, fileName, bytes, contentHash);
  const source = getAssetSource(fileName);
  const previous = context.references.get(source);
  context.references.set(source, {
    asset_uri: source,
    sha256: contentHash,
    byte_length: bytes.byteLength,
    mime_type: previous?.mime_type.startsWith("image/") ? previous.mime_type : mimeType,
  });
  return source;
}

function materializeSource(
  source: string,
  context: FreezeContext,
  media?: "image" | "audio",
): string {
  const normalized = source.trim();
  if (!normalized) throw new Error("Queued payload source cannot be empty");
  const managed = parseAssetSource(normalized);
  if (managed) {
    const bytes = readBoundedFile(
      resolveAssetPathInRoot(context.sourceAssetsRootPath, managed.fileName),
    );
    return publishPortableAsset(context, bytes, sourceMimeType(managed.fileName, media));
  }
  if (normalized.startsWith("nodex://assets/"))
    throw new Error("Queued payload contains an invalid managed asset URI");
  if (/^https?:\/\//u.test(normalized)) return normalized;
  if (normalized.startsWith("data:image/") || normalized.startsWith("data:audio/")) {
    const data = decodeMediaDataUrl(normalized);
    return publishPortableAsset(context, data.bytes, data.mimeType);
  }
  if (normalized.startsWith("blob:"))
    throw new Error("Queued payload contains a renderer-only object URL");
  const localPath = normalized.startsWith("file:") ? fileURLToPath(normalized) : normalized;
  if (!path.isAbsolute(localPath))
    throw new Error("Queued payload contains a non-portable relative file source");
  return publishPortableAsset(
    context,
    readBoundedFile(localPath),
    sourceMimeType(localPath, media),
  );
}

function freezeFileAttachment(
  attachment: CodexLiveFileAttachment,
  context: FreezeContext,
): CodexLiveFileAttachment {
  const source = materializeSource(attachment.fsPath || attachment.path, context);
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

function freezePromptInput(input: CodexPromptInput, context: FreezeContext): CodexPromptInput {
  return {
    ...input,
    ...(input.images
      ? {
          images: input.images.map((image) => ({
            ...image,
            source: materializeSource(image.source, context),
          })),
        }
      : {}),
    ...(input.appshots
      ? {
          appshots: input.appshots.map((appshot) => ({
            ...appshot,
            imageDataUrl: materializeSource(appshot.imageDataUrl, context),
          })),
        }
      : {}),
    ...(input.fileAttachments
      ? {
          fileAttachments: input.fileAttachments.map((attachment) =>
            freezeFileAttachment(attachment, context),
          ),
        }
      : {}),
    ...(input.addedFiles
      ? {
          addedFiles: input.addedFiles.map((attachment) =>
            freezeFileAttachment(attachment, context),
          ),
        }
      : {}),
    ...(input.textAttachments
      ? {
          textAttachments: input.textAttachments.map((attachment) =>
            attachment.file
              ? {
                  ...attachment,
                  file: freezeFileAttachment(attachment.file, context),
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
                    source: materializeSource(attachment.evidence.source, context),
                  },
                }
              : {}),
          })),
        }
      : {}),
  };
}

function hydratePromptInput(
  input: CodexPromptInput,
  assetsRootPath: string,
  references: readonly QueuedFollowUpAssetReference[],
): CodexPromptInput {
  const imageSource = (source: string): string => {
    const reference = references.find((candidate) => candidate.asset_uri === source);
    if (!reference) return source;
    const parsed = parseAssetSource(source);
    if (!parsed || !reference.mime_type.startsWith("image/"))
      throw new Error("Queued image has no captured image MIME type");
    const bytes = readBoundedFile(resolveAssetPathInRoot(assetsRootPath, parsed.fileName));
    return `data:${reference.mime_type};base64,${bytes.toString("base64")}`;
  };
  return {
    ...input,
    ...(input.images
      ? { images: input.images.map((image) => ({ ...image, source: imageSource(image.source) })) }
      : {}),
    ...(input.appshots
      ? {
          appshots: input.appshots.map((appshot) => ({
            ...appshot,
            imageDataUrl: imageSource(appshot.imageDataUrl),
          })),
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
                    source: imageSource(attachment.evidence.source),
                  },
                }
              : {}),
          })),
        }
      : {}),
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
  return {
    asset_uri: assetUri,
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    mime_type: "application/octet-stream",
  };
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
      typeof reference.byte_length !== "number" ||
      !Number.isSafeInteger(reference.byte_length) ||
      reference.byte_length < 0 ||
      reference.byte_length > MAX_BLOB_BYTES ||
      typeof reference.mime_type !== "string" ||
      !reference.mime_type.trim() ||
      reference.mime_type.length > 255 ||
      !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
      reference.asset_uri !== getAssetSource(`${reference.sha256}.blob`)
    ) {
      throw new Error("Queued follow-up payload asset reference is incomplete");
    }
    return {
      asset_uri: reference.asset_uri,
      sha256: reference.sha256,
      byte_length: reference.byte_length,
      mime_type: reference.mime_type,
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

function freezeAtRoot(
  row: CodexQueuedFollowUp,
  assetsRootPath: string,
  sourceAssetsRootPath: string,
): CodexQueuedFollowUp {
  const context: FreezeContext = {
    stagingRootPath: assetsRootPath,
    sourceAssetsRootPath,
    references: new Map(),
  };
  const promptInput = freezePromptInput(row.promptInput, context);
  const payload: QueuedFollowUpManifestPayload = {
    prompt: row.prompt,
    prompt_input: promptInput,
    collaboration_mode: row.collaborationMode,
    service_tier: row.serviceTier,
    summary: row.summary,
  };
  const assetReferences = [...collectManagedAssetUris(payload)]
    .sort((left, right) => left.localeCompare(right))
    .map((assetUri) => {
      const reference = context.references.get(assetUri);
      if (!reference) throw new Error("Queued payload contains an uncaptured managed asset");
      return reference;
    });
  if (
    assetReferences.length > 512 ||
    assetReferences.reduce((total, reference) => total + reference.byte_length, 0) > MAX_TOTAL_BYTES
  ) {
    throw new Error("Queued payload exceeds its attachment budget");
  }
  const manifest: QueuedFollowUpPayloadManifest = {
    schema_version: CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION,
    payload,
    asset_references: assetReferences,
  };
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const contentHash = sha256(bytes);
  const fileName = `${contentHash}.blob`;
  if (bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new Error("Queued manifest exceeds its byte limit");
  cacheContentAddressedBytes(assetsRootPath, fileName, bytes, contentHash);
  return {
    ...row,
    promptInput: hydratePromptInput(promptInput, assetsRootPath, assetReferences),
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
    promptInput: hydratePromptInput(payload.prompt_input, assetsRootPath, references),
    createdAtMs: entry.createdAtMs,
    collaborationMode: payload.collaboration_mode ?? null,
    serviceTier: normalizeCodexServiceTier(payload.service_tier),
    summary: payload.summary ?? null,
    pause: entry.pause,
    payloadRef: entry.payloadRef,
  };
}

function stagePreparedInput(
  prepared: CodexPreparedPrompt,
  context: FreezeContext,
  localExecution: boolean,
) {
  const replacements = new Map<string, string>();
  const within = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const attachment = (value: CodexLiveFileAttachment): CodexLiveFileAttachment => {
    if (!localExecution) return value;
    const source = value.fsPath || value.path;
    const managed = parseAssetSource(source);
    if (
      !managed &&
      !within(context.sourceAssetsRootPath, source) &&
      !within(context.stagingRootPath, source)
    )
      return value;
    const captured = freezeFileAttachment(value, context);
    const hydrated = hydrateFileAttachment(captured, context.stagingRootPath);
    replacements.set(source, hydrated.fsPath);
    replacements.set(value.path, hydrated.path);
    return hydrated;
  };
  const fileAttachments = prepared.fileAttachments.map(attachment);
  const addedFiles = prepared.addedFiles.map(attachment);
  const capturedMedia = new Map<string, string>();
  const item = (
    value: CodexPreparedPrompt["inputItems"][number],
  ): CodexPreparedPrompt["inputItems"][number] => {
    if (value.type === "mention")
      return { ...value, path: replacements.get(value.path) ?? value.path };
    const image = value.type === "image" || value.type === "localImage";
    const audio = value.type === "audio" || value.type === "localAudio";
    if (!image && !audio) return value;
    const source =
      "path" in value
        ? localExecution
          ? value.path
          : null
        : value.url.startsWith("data:")
          ? value.url
          : null;
    if (!source) return value;
    const family = image ? "image" : "audio";
    const key = `${family}:${source}`;
    let url = capturedMedia.get(key);
    if (!url) {
      const uri = materializeSource(source, context, family);
      const reference = context.references.get(uri);
      if (!reference || !reference.mime_type.startsWith(`${family}/`))
        throw new Error("Submitted media has no supported MIME type");
      const bytes = readBoundedFile(
        resolveAssetPathInRoot(context.stagingRootPath, `${reference.sha256}.blob`),
      );
      url = `data:${reference.mime_type};base64,${bytes.toString("base64")}`;
      capturedMedia.set(key, url);
    }
    return image
      ? { type: "image", url, ...(value.detail ? { detail: value.detail } : {}) }
      : { type: "audio", url };
  };
  const inputItems = prepared.inputItems.map(item);
  const pendingInputItems = prepared.pendingInputItems.map(item);
  const references = [...context.references.values()];
  if (
    references.length > 512 ||
    references.reduce((total, reference) => total + reference.byte_length, 0) > MAX_TOTAL_BYTES
  ) {
    throw new Error("Submitted input exceeds its attachment budget");
  }
  return {
    prepared: { ...prepared, inputItems, pendingInputItems, fileAttachments, addedFiles },
    references,
  };
}

export function makeCodexInputAssets(input: {
  readonly stagingRootPath: string;
  readonly sourceAssetsRootPath: string;
  readonly sessions: CoreSessionAccess["Service"];
}): CodexInputAssets["Service"] {
  const root = input.stagingRootPath;
  const attempt = <A>(operation: "freeze" | "hydrate" | "publish" | "retain", evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new CodexInputAssetsError({ operation, cause }),
    });
  const fetch = Effect.fn("QueuedPayload.fetch")(
    function* (threadId: string, hash: string, length: number) {
      const result = yield* input.sessions.use("queue.readBlob", (client, signal) =>
        client.readThreadAssetBlob({ threadId, contentHash: hash }, { signal }),
      );
      yield* attempt("hydrate", () => {
        if (result.bytes.byteLength !== length || sha256(result.bytes) !== hash)
          throw new Error("Core queued Blob evidence changed");
        cacheContentAddressedBytes(root, `${hash}.blob`, Buffer.from(result.bytes), hash);
      });
    },
    Effect.mapError((cause) => new CodexInputAssetsError({ operation: "hydrate", cause })),
  );
  const readManifest = (ref: CodexQueuedFollowUpPayloadRef) => {
    if (ref.assetUri !== getAssetSource(`${ref.sha256}.blob`))
      throw new Error("Queued manifest identity is invalid");
    const bytes = readBoundedFile(
      resolveAssetPathInRoot(root, `${ref.sha256}.blob`),
      MAX_MANIFEST_BYTES,
    );
    if (sha256(bytes) !== ref.sha256 || bytes.byteLength !== ref.byteLength)
      throw new Error("Queued manifest evidence changed");
    const manifest = JSON.parse(bytes.toString("utf8")) as Partial<QueuedFollowUpPayloadManifest>;
    if (manifest.schema_version !== CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION)
      throw new Error("Unsupported queued manifest");
    return { bytes, references: parseManifestAssetReferences(manifest.asset_references) };
  };
  const publishClosure = Effect.fn("CodexInputAssets.publishClosure")(
    function* (operationId: string, closure: ReadonlyMap<string, number>) {
      const receipts: string[] = [];
      for (const [hash, length] of [...closure.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const bytes = yield* attempt("publish", () => {
          const bytes = readBoundedFile(resolveAssetPathInRoot(root, `${hash}.blob`));
          if (bytes.byteLength !== length || sha256(bytes) !== hash)
            throw new Error("Staged queued bytes changed");
          return bytes;
        });
        const receipt = yield* input.sessions.use("queue.prepareBlob", (client, signal) =>
          client.prepareBlob({ operationId, idempotencySlot: hash, bytes }, { signal }),
        );
        if (receipt.blob_etag !== hash || receipt.byte_length !== length)
          return yield* new CodexInputAssetsError({
            operation: "publish",
            cause: new Error("Core prepared different queued bytes"),
          });
        receipts.push(receipt.receipt_id);
      }
      return receipts;
    },
    Effect.mapError((cause) => new CodexInputAssetsError({ operation: "publish", cause })),
  );
  return CodexInputAssets.of({
    retainPrepared: Effect.fn("CodexInputAssets.retainPrepared")(
      function* (threadId, submissionId, prepared, localExecution) {
        const captured = yield* attempt("retain", () =>
          stagePreparedInput(
            prepared,
            {
              stagingRootPath: root,
              sourceAssetsRootPath: input.sourceAssetsRootPath,
              references: new Map(),
            },
            localExecution,
          ),
        );
        if (captured.references.length === 0) return captured.prepared;
        const operationId = `thread-input:${sha256(Buffer.from(JSON.stringify([threadId, submissionId])))}`;
        const receipts = yield* publishClosure(
          operationId,
          new Map(
            captured.references.map((reference) => [reference.sha256, reference.byte_length]),
          ),
        );
        yield* input.sessions.use("thread.retainInput", (client, signal) =>
          client.workspaceApply(
            {
              operationId,
              intent: {
                kind: "retain_thread_assets",
                thread_id: threadId,
                prepared_blob_receipt_ids: receipts,
              },
            },
            { signal },
          ),
        );
        return captured.prepared;
      },
      Effect.mapError((cause) => new CodexInputAssetsError({ operation: "retain", cause })),
    ),
    freeze: (row) => attempt("freeze", () => freezeAtRoot(row, root, input.sourceAssetsRootPath)),
    publish: Effect.fn("QueuedPayload.publish")(
      function* (threadId, operationId, rows) {
        const closure = new Map<string, number>();
        for (const row of rows) {
          const ref = row.payloadRef;
          if (!ref || row.threadId !== threadId)
            return yield* new CodexInputAssetsError({
              operation: "publish",
              cause: new Error("Queue row has no captured payload"),
            });
          const manifest = yield* attempt("publish", () => readManifest(ref));
          closure.set(ref.sha256, ref.byteLength);
          for (const reference of manifest.references)
            closure.set(reference.sha256, reference.byte_length);
        }
        if (
          closure.size > 1024 ||
          [...closure.values()].reduce((total, bytes) => total + bytes, 0) > MAX_TOTAL_BYTES
        ) {
          return yield* new CodexInputAssetsError({
            operation: "publish",
            cause: new Error("Queue publication exceeds its byte budget"),
          });
        }
        return yield* publishClosure(operationId, closure);
      },
      Effect.mapError((cause) => new CodexInputAssetsError({ operation: "publish", cause })),
    ),
    hydrate: Effect.fn("QueuedPayload.hydrate")(function* (entry) {
      yield* fetch(entry.threadId, entry.payloadRef.sha256, entry.payloadRef.byteLength);
      const manifest = yield* attempt("hydrate", () => readManifest(entry.payloadRef));
      for (const reference of manifest.references)
        yield* fetch(entry.threadId, reference.sha256, reference.byte_length);
      return yield* attempt("hydrate", () => hydrateAtRoot(entry, root));
    }),
  });
}

export const codexInputAssetsLive: Layer.Layer<
  CodexInputAssets,
  never,
  TemporaryAssets | MainConfig | CoreSessionAccess
> = Layer.effect(
  CodexInputAssets,
  Effect.gen(function* () {
    const assets = yield* TemporaryAssets;
    const config = yield* MainConfig;
    const sessions = yield* CoreSessionAccess;
    return makeCodexInputAssets({
      stagingRootPath: path.join(config.nodexHome, "cache", "input-assets"),
      sourceAssetsRootPath: assets.rootPath,
      sessions,
    });
  }),
);
