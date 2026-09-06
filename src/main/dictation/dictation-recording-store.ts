import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  DICTATION_HISTORY_DIRECTORY_NAME,
  DICTATION_HISTORY_MAX_AUDIO_BYTES,
  DICTATION_HISTORY_MAX_CHUNK_BYTES,
  DICTATION_HISTORY_MAX_CHUNKS,
  DICTATION_HISTORY_MAX_METADATA_BYTES,
  DICTATION_HISTORY_MAX_RECORDINGS,
  DICTATION_RECORDING_SCHEMA_VERSION,
  DictationRecordingIdSchema,
  DictationRecordingMetadataSchema,
  type DictationRecordingAppendInput,
  type DictationRecordingAudio,
  type DictationRecordingCreateInput,
  type DictationRecordingFinalizeInput,
  type DictationRecordingMetadata,
  type DictationRecordingSetTranscriptInput,
  type DictationRecordingSetDiagnosticsInput,
} from "../../shared/dictation-history";
import { isMissingPathError, syncDirectory, writeDurableJson } from "../durable-json-file";

const METADATA_FILE_NAME = "metadata.json";
const CHUNK_FILE_NAME = /^(\d{10})\.chunk$/u;
const OWNED_TEMP_FILE_NAME = /^\.(?:metadata\.json|\d{10}\.chunk)\.\d+\.[^.]+\.tmp$/u;
const HASH_DIRECTORY_NAME = /^[a-f0-9]{64}$/u;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export type DictationRecordingStoreErrorCode =
  | "active_recording_conflict"
  | "invalid_input"
  | "invalid_recording"
  | "limit_exceeded"
  | "recording_exists"
  | "recording_not_active"
  | "recording_not_found"
  | "unsafe_path";

export class DictationRecordingStoreError extends Error {
  readonly code: DictationRecordingStoreErrorCode;

  constructor(code: DictationRecordingStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DictationRecordingStoreError";
    this.code = code;
  }
}

export interface DictationRecordingStore {
  create(input: DictationRecordingCreateInput): Promise<DictationRecordingMetadata>;
  append(input: DictationRecordingAppendInput): Promise<DictationRecordingMetadata>;
  finalize(input: DictationRecordingFinalizeInput): Promise<DictationRecordingMetadata>;
  setDiagnostics(input: DictationRecordingSetDiagnosticsInput): Promise<DictationRecordingMetadata>;
  setTranscript(input: DictationRecordingSetTranscriptInput): Promise<DictationRecordingMetadata>;
  list(): Promise<DictationRecordingMetadata[]>;
  readAudio(id: string): Promise<DictationRecordingAudio>;
  delete(id: string): Promise<void>;
}

export interface FileDictationRecordingStoreOptions {
  readonly profileRoot: string;
  readonly now?: () => number;
}

interface ChunkDescriptor {
  readonly filePath: string;
  readonly index: number;
  readonly sizeBytes: number;
}

interface StoredRecording {
  readonly directoryPath: string;
  readonly metadata: DictationRecordingMetadata;
  readonly chunks: readonly ChunkDescriptor[];
}

interface ScanRecordingOptions {
  readonly expectedId?: string;
  readonly interruptActive: boolean;
  readonly reconcileActive: boolean;
}

/**
 * Owns private, Profile-scoped dictation audio files. Callers provide identities and bytes only;
 * no filesystem path crosses this interface.
 */
export class FileDictationRecordingStore implements DictationRecordingStore {
  private readonly profileRoot: string;
  private readonly historyRoot: string;
  private readonly now: () => number;
  private readonly recordings = new Map<string, StoredRecording>();
  private readonly activeSessionIds = new Set<string>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private initializationPromise: Promise<void> | null = null;
  private retentionQueue: Promise<void> = Promise.resolve();
  private canonicalHistoryRoot: string | null = null;

  constructor(options: FileDictationRecordingStoreOptions) {
    if (!options.profileRoot.trim()) {
      throw new DictationRecordingStoreError("invalid_input", "Profile root is required");
    }
    this.profileRoot = resolve(options.profileRoot);
    this.historyRoot = resolve(this.profileRoot, DICTATION_HISTORY_DIRECTORY_NAME);
    if (!isPathInside(this.profileRoot, this.historyRoot)) {
      throw new DictationRecordingStoreError(
        "unsafe_path",
        "Dictation history root escaped Profile",
      );
    }
    this.now = options.now ?? Date.now;
  }

  async create(input: DictationRecordingCreateInput): Promise<DictationRecordingMetadata> {
    const id = parseRecordingId(input.id);
    await this.ensureInitialized();
    return await this.serializeSession(id, async () => {
      if (this.recordings.has(id)) {
        throw new DictationRecordingStoreError(
          "recording_exists",
          "A dictation recording already exists for this session",
        );
      }

      const timestamp = this.readNow();
      const metadata = parseInputMetadata({
        schemaVersion: DICTATION_RECORDING_SCHEMA_VERSION,
        id,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
        durationMs: 0,
        mimeType: input.mimeType,
        sizeBytes: 0,
        chunkCount: 0,
        status: "recording",
        surface: input.surface,
      });
      const directoryPath = this.recordingDirectoryPath(id);
      if (await pathExists(directoryPath)) {
        throw new DictationRecordingStoreError(
          "recording_exists",
          "The dictation recording directory already exists",
        );
      }

      await mkdir(directoryPath, { mode: 0o700 });
      await this.assertSafeRecordingDirectory(directoryPath);
      await chmod(directoryPath, 0o700);
      await this.writeMetadata(directoryPath, metadata);
      await syncDirectory(this.requireCanonicalHistoryRoot());

      const stored = { chunks: [], directoryPath, metadata } satisfies StoredRecording;
      this.recordings.set(id, stored);
      this.activeSessionIds.add(id);
      return cloneMetadata(metadata);
    });
  }

  async append(input: DictationRecordingAppendInput): Promise<DictationRecordingMetadata> {
    const id = parseRecordingId(input.id);
    if (!(input.chunk instanceof Uint8Array) || input.chunk.byteLength === 0) {
      throw new DictationRecordingStoreError(
        "invalid_input",
        "A dictation recording chunk must contain bytes",
      );
    }
    if (input.chunk.byteLength > DICTATION_HISTORY_MAX_CHUNK_BYTES) {
      throw new DictationRecordingStoreError(
        "limit_exceeded",
        "The dictation recording chunk exceeds its size limit",
      );
    }
    const ownedChunk = Uint8Array.from(input.chunk);

    await this.ensureInitialized();
    return await this.serializeSession(id, async () => {
      const current = await this.readActiveRecording(id);
      const nextChunkIndex = current.chunks.length;
      if (nextChunkIndex >= DICTATION_HISTORY_MAX_CHUNKS) {
        throw new DictationRecordingStoreError(
          "limit_exceeded",
          "The dictation recording exceeds its chunk limit",
        );
      }
      if (current.metadata.sizeBytes + ownedChunk.byteLength > DICTATION_HISTORY_MAX_AUDIO_BYTES) {
        throw new DictationRecordingStoreError(
          "limit_exceeded",
          "The dictation recording exceeds its audio size limit",
        );
      }

      const chunk = await this.writeChunk(current.directoryPath, nextChunkIndex, ownedChunk);
      const metadata = parseStoredMetadata({
        ...current.metadata,
        updatedAtMs: this.nextUpdatedAt(current.metadata),
        sizeBytes: current.metadata.sizeBytes + chunk.sizeBytes,
        chunkCount: current.metadata.chunkCount + 1,
      });
      await this.writeMetadata(current.directoryPath, metadata);

      const stored = {
        ...current,
        metadata,
        chunks: [...current.chunks, chunk],
      } satisfies StoredRecording;
      this.recordings.set(id, stored);
      return cloneMetadata(metadata);
    });
  }

  async finalize(input: DictationRecordingFinalizeInput): Promise<DictationRecordingMetadata> {
    const id = parseRecordingId(input.id);
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
      throw new DictationRecordingStoreError(
        "invalid_input",
        "Dictation recording duration is invalid",
      );
    }
    if (input.status !== "completed" && input.status !== "cancelled") {
      throw new DictationRecordingStoreError(
        "invalid_input",
        "Dictation recording final status is invalid",
      );
    }

    await this.ensureInitialized();
    const metadata = await this.serializeSession(id, async () => {
      const current = await this.readActiveRecording(id);
      const finalized = parseStoredMetadata({
        ...current.metadata,
        updatedAtMs: this.nextUpdatedAt(current.metadata),
        durationMs: input.durationMs,
        status: input.status,
      });
      await this.writeMetadata(current.directoryPath, finalized);
      this.recordings.set(id, { ...current, metadata: finalized });
      this.activeSessionIds.delete(id);
      return cloneMetadata(finalized);
    });
    await this.enforceRetention();
    return metadata;
  }

  async setDiagnostics(
    input: DictationRecordingSetDiagnosticsInput,
  ): Promise<DictationRecordingMetadata> {
    const id = parseRecordingId(input.id);
    await this.ensureInitialized();
    return await this.serializeSession(id, async () => {
      const current = await this.readStoredRecording(id);
      if (
        current.metadata.diagnostics &&
        current.metadata.diagnostics.attempt > input.diagnostics.attempt
      )
        return cloneMetadata(current.metadata);
      const metadata = parseInputMetadata({
        ...current.metadata,
        diagnostics: input.diagnostics,
        updatedAtMs: this.nextUpdatedAt(current.metadata),
      });
      await this.writeMetadata(current.directoryPath, metadata);
      this.recordings.set(id, { ...current, metadata });
      return cloneMetadata(metadata);
    });
  }

  async setTranscript(
    input: DictationRecordingSetTranscriptInput,
  ): Promise<DictationRecordingMetadata> {
    const id = parseRecordingId(input.id);
    if (input.transcript !== null && typeof input.transcript !== "string") {
      throw new DictationRecordingStoreError("invalid_input", "Dictation transcript is invalid");
    }

    await this.ensureInitialized();
    return await this.serializeSession(id, async () => {
      const current = await this.readStoredRecording(id);
      if (current.metadata.status === "recording") {
        throw new DictationRecordingStoreError(
          "active_recording_conflict",
          "An active dictation recording cannot store a final transcript",
        );
      }
      const { transcript: _currentTranscript, ...metadataWithoutTranscript } = current.metadata;
      const metadata = parseInputMetadata({
        ...metadataWithoutTranscript,
        updatedAtMs: this.nextUpdatedAt(current.metadata),
        ...(input.transcript === null ? {} : { transcript: input.transcript }),
      });
      await this.writeMetadata(current.directoryPath, metadata);
      this.recordings.set(id, { ...current, metadata });
      return cloneMetadata(metadata);
    });
  }

  async list(): Promise<DictationRecordingMetadata[]> {
    await this.ensureInitialized();
    return [...this.recordings.values()]
      .map((recording) => recording.metadata)
      .sort(compareNewestRecording)
      .map(cloneMetadata);
  }

  async readAudio(idValue: string): Promise<DictationRecordingAudio> {
    const id = parseRecordingId(idValue);
    await this.ensureInitialized();
    return await this.serializeSession(id, async () => {
      const current = await this.readStoredRecording(id);
      const bytes = new Uint8Array(current.metadata.sizeBytes);
      let offset = 0;
      for (const chunk of current.chunks) {
        await this.readChunkInto(chunk, bytes, offset);
        offset += chunk.sizeBytes;
      }
      if (offset !== bytes.byteLength) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording audio size does not match metadata",
        );
      }
      return { recording: cloneMetadata(current.metadata), bytes };
    });
  }

  async delete(idValue: string): Promise<void> {
    const id = parseRecordingId(idValue);
    await this.ensureInitialized();
    await this.serializeSession(id, async () => {
      if (
        this.activeSessionIds.has(id) ||
        this.recordings.get(id)?.metadata.status === "recording"
      ) {
        throw new DictationRecordingStoreError(
          "active_recording_conflict",
          "An active dictation recording cannot be deleted",
        );
      }
      await this.deleteStoredRecording(id);
    });
  }

  private async ensureInitialized(): Promise<void> {
    this.initializationPromise ??= this.initialize();
    await this.initializationPromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.historyRoot, { recursive: true, mode: 0o700 });
    const canonicalProfileRoot = await realpath(this.profileRoot);
    const canonicalHistoryRoot = await this.assertSafeDirectory(
      this.historyRoot,
      canonicalProfileRoot,
      "Dictation history root",
    );
    await chmod(this.historyRoot, 0o700);
    this.canonicalHistoryRoot = canonicalHistoryRoot;

    const entries = await readdir(this.historyRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!HASH_DIRECTORY_NAME.test(entry.name)) {
        throw new DictationRecordingStoreError(
          "unsafe_path",
          "Dictation history contains an unexpected entry",
        );
      }
      const directoryPath = join(this.historyRoot, entry.name);
      const entryStats = await lstat(directoryPath);
      if (entryStats.isSymbolicLink() || !entryStats.isDirectory()) {
        throw new DictationRecordingStoreError(
          "unsafe_path",
          "Dictation history contains an unsafe recording directory",
        );
      }
      const recording = await this.scanRecordingDirectory(directoryPath, {
        interruptActive: true,
        reconcileActive: true,
      });
      if (!recording) continue;
      this.recordings.set(recording.metadata.id, recording);
    }

    await this.enforceRetentionWithoutQueues();
  }

  private async readStoredRecording(id: string): Promise<StoredRecording> {
    const known = this.recordings.get(id);
    if (!known) {
      throw new DictationRecordingStoreError(
        "recording_not_found",
        "Dictation recording was not found",
      );
    }
    const recording = await this.scanRecordingDirectory(known.directoryPath, {
      expectedId: id,
      interruptActive: false,
      reconcileActive: this.activeSessionIds.has(id),
    });
    if (!recording) {
      throw new DictationRecordingStoreError(
        "recording_not_found",
        "Dictation recording was not found",
      );
    }
    this.recordings.set(id, recording);
    return recording;
  }

  private async readActiveRecording(id: string): Promise<StoredRecording> {
    if (!this.activeSessionIds.has(id)) {
      throw new DictationRecordingStoreError(
        "recording_not_active",
        "Dictation recording is not active",
      );
    }
    const recording = await this.readStoredRecording(id);
    if (recording.metadata.status !== "recording") {
      this.activeSessionIds.delete(id);
      throw new DictationRecordingStoreError(
        "recording_not_active",
        "Dictation recording is not active",
      );
    }
    return recording;
  }

  private async scanRecordingDirectory(
    directoryPath: string,
    options: ScanRecordingOptions,
  ): Promise<StoredRecording | null> {
    await this.assertSafeRecordingDirectory(directoryPath);
    await chmod(directoryPath, 0o700);
    await this.removeOwnedTemporaryFiles(directoryPath);

    const entryNames = await readdir(directoryPath);
    if (entryNames.length === 0) {
      await rmdir(directoryPath);
      await syncDirectory(this.requireCanonicalHistoryRoot());
      return null;
    }
    if (!entryNames.includes(METADATA_FILE_NAME)) {
      throw new DictationRecordingStoreError(
        "invalid_recording",
        "Dictation recording metadata is missing",
      );
    }

    const metadataPath = join(directoryPath, METADATA_FILE_NAME);
    const metadata = await this.readMetadata(metadataPath);
    const directoryName = basename(directoryPath);
    if (
      hashRecordingId(metadata.id) !== directoryName ||
      (options.expectedId !== undefined && metadata.id !== options.expectedId)
    ) {
      throw new DictationRecordingStoreError(
        "invalid_recording",
        "Dictation recording identity does not match its directory",
      );
    }

    const chunks: ChunkDescriptor[] = [];
    for (const entryName of entryNames) {
      if (entryName === METADATA_FILE_NAME) continue;
      const match = CHUNK_FILE_NAME.exec(entryName);
      if (!match) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording contains an unexpected file",
        );
      }
      const index = Number.parseInt(match[1], 10);
      chunks.push(await this.readChunkDescriptor(join(directoryPath, entryName), index));
    }
    chunks.sort((left, right) => left.index - right.index);
    if (chunks.length > DICTATION_HISTORY_MAX_CHUNKS) {
      throw new DictationRecordingStoreError(
        "limit_exceeded",
        "Dictation recording exceeds its chunk limit",
      );
    }
    for (const [expectedIndex, chunk] of chunks.entries()) {
      if (chunk.index !== expectedIndex) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording chunks are not continuous",
        );
      }
    }
    const actualSizeBytes = chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0);
    if (actualSizeBytes > DICTATION_HISTORY_MAX_AUDIO_BYTES) {
      throw new DictationRecordingStoreError(
        "limit_exceeded",
        "Dictation recording exceeds its audio size limit",
      );
    }

    const differsFromDisk =
      metadata.chunkCount !== chunks.length || metadata.sizeBytes !== actualSizeBytes;
    if (metadata.status !== "recording" && differsFromDisk) {
      throw new DictationRecordingStoreError(
        "invalid_recording",
        "Finalized dictation recording metadata does not match its chunks",
      );
    }

    let recoveredMetadata = metadata;
    if (
      metadata.status === "recording" &&
      (options.interruptActive || (options.reconcileActive && differsFromDisk))
    ) {
      recoveredMetadata = parseStoredMetadata({
        ...metadata,
        updatedAtMs: this.nextUpdatedAt(metadata),
        sizeBytes: actualSizeBytes,
        chunkCount: chunks.length,
        status: options.interruptActive ? "interrupted" : "recording",
      });
      await this.writeMetadata(directoryPath, recoveredMetadata);
    }

    return { chunks, directoryPath, metadata: recoveredMetadata };
  }

  private async removeOwnedTemporaryFiles(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath);
    for (const entryName of entries) {
      if (!entryName.endsWith(".tmp")) continue;
      if (!OWNED_TEMP_FILE_NAME.test(entryName)) {
        throw new DictationRecordingStoreError(
          "unsafe_path",
          "Dictation recording contains an unknown temporary file",
        );
      }
      const temporaryPath = join(directoryPath, entryName);
      const stats = await lstat(temporaryPath);
      if (stats.isDirectory()) {
        throw new DictationRecordingStoreError(
          "unsafe_path",
          "Dictation recording contains an unsafe temporary entry",
        );
      }
      await rm(temporaryPath, { force: true });
    }
  }

  private async readMetadata(metadataPath: string): Promise<DictationRecordingMetadata> {
    const handle = await this.openSafeRegularFile(
      metadataPath,
      DICTATION_HISTORY_MAX_METADATA_BYTES,
    );
    try {
      const raw = await handle.readFile({ encoding: "utf8" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording metadata is not valid JSON",
          { cause: error },
        );
      }
      const result = DictationRecordingMetadataSchema.safeParse(parsed);
      if (!result.success) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording metadata is invalid",
          { cause: result.error },
        );
      }
      await chmod(metadataPath, 0o600);
      return result.data;
    } finally {
      await handle.close();
    }
  }

  private async readChunkDescriptor(filePath: string, index: number): Promise<ChunkDescriptor> {
    const handle = await this.openSafeRegularFile(filePath, DICTATION_HISTORY_MAX_CHUNK_BYTES);
    try {
      const stats = await handle.stat();
      if (stats.size <= 0) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording contains an empty chunk",
        );
      }
      await chmod(filePath, 0o600);
      return { filePath, index, sizeBytes: stats.size };
    } finally {
      await handle.close();
    }
  }

  private async openSafeRegularFile(filePath: string, maxBytes: number) {
    const pathStats = await lstat(filePath);
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) {
      throw new DictationRecordingStoreError(
        "unsafe_path",
        "Dictation recording contains an unsafe file",
      );
    }
    const canonicalPath = await realpath(filePath);
    if (!isPathInside(this.requireCanonicalHistoryRoot(), canonicalPath)) {
      throw new DictationRecordingStoreError(
        "unsafe_path",
        "Dictation recording file escaped its history root",
      );
    }
    const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size > maxBytes) {
        throw new DictationRecordingStoreError(
          stats.size > maxBytes ? "limit_exceeded" : "unsafe_path",
          "Dictation recording file is invalid or oversized",
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async writeChunk(
    directoryPath: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<ChunkDescriptor> {
    await this.assertSafeRecordingDirectory(directoryPath);
    const fileName = `${String(index).padStart(10, "0")}.chunk`;
    const filePath = join(directoryPath, fileName);
    if (await pathExists(filePath)) {
      throw new DictationRecordingStoreError(
        "invalid_recording",
        "Dictation recording chunk already exists",
      );
    }
    const temporaryPath = join(directoryPath, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600);
      await syncDirectory(directoryPath);
      return { filePath, index, sizeBytes: bytes.byteLength };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async writeMetadata(
    directoryPath: string,
    metadata: DictationRecordingMetadata,
  ): Promise<void> {
    await this.assertSafeRecordingDirectory(directoryPath);
    await writeDurableJson(
      join(directoryPath, METADATA_FILE_NAME),
      parseStoredMetadata(metadata),
      DICTATION_HISTORY_MAX_METADATA_BYTES,
    );
    await chmod(join(directoryPath, METADATA_FILE_NAME), 0o600);
  }

  private async readChunkInto(
    chunk: ChunkDescriptor,
    destination: Uint8Array,
    offset: number,
  ): Promise<void> {
    const handle = await this.openSafeRegularFile(
      chunk.filePath,
      DICTATION_HISTORY_MAX_CHUNK_BYTES,
    );
    try {
      const stats = await handle.stat();
      if (stats.size !== chunk.sizeBytes || offset + stats.size > destination.byteLength) {
        throw new DictationRecordingStoreError(
          "invalid_recording",
          "Dictation recording chunk changed while it was being read",
        );
      }
      let readOffset = 0;
      while (readOffset < stats.size) {
        const { bytesRead } = await handle.read(
          destination,
          offset + readOffset,
          stats.size - readOffset,
          readOffset,
        );
        if (bytesRead === 0) {
          throw new DictationRecordingStoreError(
            "invalid_recording",
            "Dictation recording chunk ended unexpectedly",
          );
        }
        readOffset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  private async enforceRetention(): Promise<void> {
    const operation = async () => await this.enforceRetentionWithSessionQueues();
    const pending = this.retentionQueue.then(operation, operation);
    this.retentionQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  private async enforceRetentionWithSessionQueues(): Promise<void> {
    const excess = this.retentionCandidates();
    for (const recording of excess) {
      await this.serializeSession(recording.metadata.id, async () => {
        if (this.activeSessionIds.has(recording.metadata.id)) return;
        await this.deleteStoredRecording(recording.metadata.id);
      });
    }
  }

  private async enforceRetentionWithoutQueues(): Promise<void> {
    for (const recording of this.retentionCandidates()) {
      await this.deleteStoredRecording(recording.metadata.id);
    }
  }

  private retentionCandidates(): StoredRecording[] {
    const inactive = [...this.recordings.values()]
      .filter((recording) => recording.metadata.status !== "recording")
      .sort(compareOldestRecording);
    return inactive.slice(0, Math.max(0, inactive.length - DICTATION_HISTORY_MAX_RECORDINGS));
  }

  private async deleteStoredRecording(id: string): Promise<void> {
    const current = this.recordings.get(id);
    if (!current) {
      throw new DictationRecordingStoreError(
        "recording_not_found",
        "Dictation recording was not found",
      );
    }
    await this.scanRecordingDirectory(current.directoryPath, {
      expectedId: id,
      interruptActive: false,
      reconcileActive: false,
    });
    await this.assertSafeRecordingDirectory(current.directoryPath);
    await rm(current.directoryPath, { recursive: true });
    await syncDirectory(this.requireCanonicalHistoryRoot());
    this.recordings.delete(id);
    this.activeSessionIds.delete(id);
  }

  private async serializeSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(id) ?? Promise.resolve();
    const pending = previous.then(operation, operation);
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.sessionQueues.set(id, settled);
    try {
      return await pending;
    } finally {
      if (this.sessionQueues.get(id) === settled) {
        this.sessionQueues.delete(id);
      }
    }
  }

  private recordingDirectoryPath(id: string): string {
    const directoryPath = resolve(this.historyRoot, hashRecordingId(id));
    if (!isPathInside(this.historyRoot, directoryPath)) {
      throw new DictationRecordingStoreError(
        "unsafe_path",
        "Dictation recording directory escaped its history root",
      );
    }
    return directoryPath;
  }

  private async assertSafeRecordingDirectory(directoryPath: string): Promise<string> {
    return await this.assertSafeDirectory(
      directoryPath,
      this.requireCanonicalHistoryRoot(),
      "Dictation recording directory",
    );
  }

  private async assertSafeDirectory(
    directoryPath: string,
    canonicalParent: string,
    label: string,
  ): Promise<string> {
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new DictationRecordingStoreError("unsafe_path", `${label} is not a safe directory`);
    }
    const canonicalPath = await realpath(directoryPath);
    if (!isPathInside(canonicalParent, canonicalPath)) {
      throw new DictationRecordingStoreError("unsafe_path", `${label} escaped its parent`);
    }
    return canonicalPath;
  }

  private requireCanonicalHistoryRoot(): string {
    if (!this.canonicalHistoryRoot) {
      throw new DictationRecordingStoreError(
        "unsafe_path",
        "Dictation history root is not initialized",
      );
    }
    return this.canonicalHistoryRoot;
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DictationRecordingStoreError("invalid_input", "Dictation clock is invalid");
    }
    return value;
  }

  private nextUpdatedAt(metadata: DictationRecordingMetadata): number {
    return Math.max(metadata.createdAtMs, metadata.updatedAtMs, this.readNow());
  }
}

function parseRecordingId(value: string): string {
  const result = DictationRecordingIdSchema.safeParse(value);
  if (!result.success) {
    throw new DictationRecordingStoreError("invalid_input", "Dictation recording id is invalid", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseInputMetadata(value: unknown): DictationRecordingMetadata {
  const result = DictationRecordingMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new DictationRecordingStoreError(
      "invalid_input",
      "Dictation recording input is invalid",
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

function parseStoredMetadata(value: unknown): DictationRecordingMetadata {
  const result = DictationRecordingMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new DictationRecordingStoreError(
      "invalid_recording",
      "Dictation recording metadata is invalid",
      { cause: result.error },
    );
  }
  return result.data;
}

function hashRecordingId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function cloneMetadata(metadata: DictationRecordingMetadata): DictationRecordingMetadata {
  return structuredClone(metadata);
}

function compareNewestRecording(
  left: DictationRecordingMetadata,
  right: DictationRecordingMetadata,
): number {
  return right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id);
}

function compareOldestRecording(left: StoredRecording, right: StoredRecording): number {
  return (
    left.metadata.createdAtMs - right.metadata.createdAtMs ||
    left.metadata.id.localeCompare(right.metadata.id)
  );
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
