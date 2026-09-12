import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
  CodexThreadGoalDraftInput,
  CodexThreadGoalFrozenDraft,
  CodexThreadGoalImageAttachmentInput,
  CodexThreadGoalMaterializedDraft,
  CodexThreadGoalPastedTextAttachmentInput,
} from "../shared/types";
import { COMPOSER_PASTED_TEXT_MAX_BYTES } from "../shared/pasted-text-attachments";
import { CODEX_PASTED_TEXT_EXCERPT_MAX_CHARS } from "../shared/codex-thread-title";

const THREAD_GOAL_ATTACHMENTS_DIR = "attachments";
const PASTED_TEXT_ATTACHMENT_FILE = "pasted-text.txt";
const PASTED_TEXT_ATTACHMENT_REGISTRY_FILE = "pasted-text-attachments.json";
const PASTED_TEXT_ATTACHMENT_LABEL = "Pasted text.txt";
const PASTED_TEXT_FALLBACK_PREVIEW = "Pasted text";
const PASTED_TEXT_PREVIEW_MAX_CODE_UNITS = 80;
const THREAD_GOAL_OBJECTIVE_FILE = "goal-objective.md";
const THREAD_GOAL_OBJECTIVE_PREFIX = "Read the Codex goal objective file at ";
const THREAD_GOAL_OBJECTIVE_SUFFIX = " before continuing.";
const THREAD_GOAL_INLINE_OBJECTIVE_MAX_CODE_POINTS = 4000;
const V4_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_PASTED_TEXT_RELATIVE_PATH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/;
const THREAD_GOAL_OBJECTIVE_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AttachmentFileSystem {
  createDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

const defaultAttachmentFileSystem: AttachmentFileSystem = {
  async createDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  async readFile(path) {
    return await readFile(path);
  },
  async writeFile(path, data) {
    await writeFile(path, data);
  },
  async removeFile(path) {
    await rm(path, { force: true });
  },
  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true });
  },
};

interface PastedTextAttachmentRegistryState {
  readonly attachmentPaths: Set<string>;
  readonly pendingRemovalPaths: Set<string>;
  readonly textExcerptsByPath: Map<string, string>;
}

interface SerializedPastedTextAttachmentRegistry {
  readonly attachmentPaths: string[];
  readonly pendingRemovalPaths: string[];
  readonly textExcerptsByPath: Record<string, string>;
}

export interface MaterializedPastedTextAttachmentSources {
  readonly attachments: CodexPastedTextAttachment[];
  readonly createdAttachmentPaths: readonly string[];
}

export interface PastedTextAttachmentManagerOptions {
  readonly attachmentsRoot: string;
  readonly fileSystem?: Partial<AttachmentFileSystem>;
  readonly createUuid?: () => string;
  readonly hostId?: string;
}

export class PastedTextAttachmentManager {
  readonly #attachmentsRoot: string;
  readonly #fileSystem: AttachmentFileSystem;
  readonly #createUuid: () => string;
  readonly #hostId: string | undefined;
  #state: Promise<PastedTextAttachmentRegistryState> | null = null;
  #registryWrite: Promise<void> = Promise.resolve();

  constructor(options: PastedTextAttachmentManagerOptions) {
    this.#attachmentsRoot = resolve(options.attachmentsRoot);
    this.#fileSystem = { ...defaultAttachmentFileSystem, ...options.fileSystem };
    this.#createUuid = options.createUuid ?? randomUUID;
    this.#hostId = options.hostId;
  }

  async createRawSource(input: {
    readonly text: string;
    readonly label?: string;
    readonly preview?: string;
    readonly hostId?: string;
  }): Promise<CodexPastedTextAttachment> {
    if (Buffer.byteLength(input.text, "utf8") > COMPOSER_PASTED_TEXT_MAX_BYTES) {
      throw new Error("Pasted text must be 10 MB or smaller.");
    }

    const file = await this.#createManagedFile({
      data: Buffer.from(input.text, "utf8"),
      filename: PASTED_TEXT_ATTACHMENT_FILE,
      label: input.label ?? PASTED_TEXT_ATTACHMENT_LABEL,
      textExcerpt: input.text.trim().slice(0, CODEX_PASTED_TEXT_EXCERPT_MAX_CHARS),
    });

    return {
      file,
      preview: input.preview ?? buildPastedTextAttachmentPreview(input.text),
      ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      characterCount: input.text.length,
    };
  }

  async materializeSources(
    attachments: readonly CodexThreadGoalPastedTextAttachmentInput[],
  ): Promise<MaterializedPastedTextAttachmentSources> {
    const createdAttachments: CodexPastedTextAttachment[] = [];

    try {
      const materialized: CodexPastedTextAttachment[] = [];
      for (const attachment of attachments) {
        if (!("text" in attachment)) {
          materialized.push(clonePastedTextAttachment(attachment));
          continue;
        }

        if (attachment.file !== undefined) {
          materialized.push({
            file: { ...attachment.file },
            preview: attachment.preview ?? buildPastedTextAttachmentPreview(attachment.text),
            ...(attachment.hostId === undefined ? {} : { hostId: attachment.hostId }),
            characterCount: attachment.characterCount ?? attachment.text.length,
          });
          continue;
        }

        const created = await this.createRawSource({
          text: attachment.text,
          ...(attachment.preview === undefined ? {} : { preview: attachment.preview }),
          ...(attachment.hostId === undefined ? {} : { hostId: attachment.hostId }),
        });
        createdAttachments.push(created);
        materialized.push(created);
      }

      return {
        attachments: materialized,
        createdAttachmentPaths: createdAttachments.map((attachment) => attachment.file.path),
      };
    } catch (error) {
      await Promise.allSettled(
        createdAttachments.map((attachment) => this.remove(attachment.file.path)),
      );
      throw error;
    }
  }

  async getTextExcerpts(
    attachments: readonly CodexLiveFileAttachment[] | null | undefined,
  ): Promise<string[]> {
    if (!attachments?.length) return [];
    const state = await this.#getState();
    return attachments.flatMap((attachment) => {
      const excerpt = state.textExcerptsByPath.get(attachment.path);
      return excerpt === undefined ? [] : [excerpt];
    });
  }

  async readRawSource(file: CodexLiveFileAttachment): Promise<string> {
    const state = await this.#getState();
    if (file.path !== file.fsPath || !state.attachmentPaths.has(file.path)) {
      throw new Error("Unknown pasted text attachment");
    }

    return (await this.#fileSystem.readFile(file.path)).toString("utf8");
  }

  async remove(path: string): Promise<void> {
    const state = await this.#getState();
    if (!state.attachmentPaths.has(path)) return;
    state.pendingRemovalPaths.add(path);
    await this.#writeState(state);
    await this.#removePendingAttachment(state, path);
  }

  async cleanupPendingRemovals(): Promise<void> {
    await this.#retryPendingRemovals(await this.#getState());
  }

  async cleanupGoalSources(
    draft: CodexThreadGoalDraftInput | CodexThreadGoalFrozenDraft | null | undefined,
    fallbackHostId?: string,
  ): Promise<void> {
    void fallbackHostId;
    await Promise.allSettled(
      (draft?.pastedTextAttachments ?? []).flatMap((attachment) => {
        const file = "file" in attachment ? attachment.file : undefined;
        return file === undefined ? [] : [this.remove(file.path)];
      }),
    );
  }

  async #createManagedFile(input: {
    readonly data: Uint8Array;
    readonly filename: string;
    readonly label: string;
    readonly textExcerpt?: string;
  }): Promise<CodexLiveFileAttachment> {
    const state = await this.#getState();
    await this.#retryPendingRemovals(state);
    const directoryPath = join(this.#attachmentsRoot, this.#createUuid());
    await this.#fileSystem.createDirectory(directoryPath);
    const filePath = join(directoryPath, input.filename);
    await this.#fileSystem.writeFile(filePath, input.data);
    state.attachmentPaths.add(filePath);
    if (input.textExcerpt?.length) state.textExcerptsByPath.set(filePath, input.textExcerpt);

    try {
      await this.#writeState(state);
    } catch (error) {
      state.attachmentPaths.delete(filePath);
      state.textExcerptsByPath.delete(filePath);
      await this.#fileSystem.removeFile(filePath).catch(() => undefined);
      throw error;
    }

    return {
      label: input.label,
      path: filePath,
      fsPath: filePath,
      ...(this.#hostId === undefined ? {} : { hostId: this.#hostId }),
    };
  }

  async #getState(): Promise<PastedTextAttachmentRegistryState> {
    this.#state ??= this.#readState().catch((error) => {
      this.#state = null;
      throw error;
    });
    return await this.#state;
  }

  async #readState(): Promise<PastedTextAttachmentRegistryState> {
    let bytes: Buffer;
    try {
      bytes = await this.#fileSystem.readFile(this.#registryPath());
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      return createEmptyPastedTextAttachmentRegistryState();
    }

    const registry = parsePastedTextAttachmentRegistry(JSON.parse(bytes.toString("utf8")));
    const attachmentPaths = new Set(
      registry.attachmentPaths.filter((path) =>
        isManagedPastedTextAttachmentFilePath(path, this.#attachmentsRoot),
      ),
    );
    return {
      attachmentPaths,
      pendingRemovalPaths: new Set(
        registry.pendingRemovalPaths.filter((path) => attachmentPaths.has(path)),
      ),
      textExcerptsByPath: new Map(
        Object.entries(registry.textExcerptsByPath).filter(([path]) => attachmentPaths.has(path)),
      ),
    };
  }

  async #retryPendingRemovals(state: PastedTextAttachmentRegistryState): Promise<void> {
    await Promise.allSettled(
      Array.from(state.pendingRemovalPaths).map((path) =>
        this.#removePendingAttachment(state, path),
      ),
    );
  }

  async #removePendingAttachment(
    state: PastedTextAttachmentRegistryState,
    path: string,
  ): Promise<void> {
    await this.#fileSystem.removeFile(path);
    state.attachmentPaths.delete(path);
    state.pendingRemovalPaths.delete(path);
    state.textExcerptsByPath.delete(path);
    await this.#writeState(state);
  }

  async #writeState(state: PastedTextAttachmentRegistryState): Promise<void> {
    const registry: SerializedPastedTextAttachmentRegistry = {
      attachmentPaths: Array.from(state.attachmentPaths),
      pendingRemovalPaths: Array.from(state.pendingRemovalPaths),
      textExcerptsByPath: Object.fromEntries(state.textExcerptsByPath),
    };
    const write = this.#registryWrite
      .catch(() => undefined)
      .then(async () => {
        await this.#fileSystem.writeFile(
          this.#registryPath(),
          Buffer.from(JSON.stringify(registry), "utf8"),
        );
      });
    this.#registryWrite = write;
    await write;
  }

  #registryPath(): string {
    return join(this.#attachmentsRoot, PASTED_TEXT_ATTACHMENT_REGISTRY_FILE);
  }
}

export type ThreadGoalDraftMaterializationInput =
  | CodexThreadGoalDraftInput
  | CodexThreadGoalFrozenDraft;

export interface ThreadGoalAttachmentDirectoryManagerOptions {
  readonly attachmentsRoot: string;
  readonly fileSystem?: Partial<AttachmentFileSystem>;
  readonly createUuid?: () => string;
  readonly targetHostId?: string;
  readonly localHostId?: string;
  readonly readSourceFile?: (path: string, hostId?: string) => Promise<Buffer>;
}

export class ThreadGoalAttachmentDirectoryManager {
  readonly #attachmentsRoot: string;
  readonly #fileSystem: AttachmentFileSystem;
  readonly #createUuid: () => string;
  readonly #targetHostId: string | undefined;
  readonly #localHostId: string | undefined;
  readonly #readSourceFile: (path: string, hostId?: string) => Promise<Buffer>;
  readonly #directories = new Set<string>();

  constructor(options: ThreadGoalAttachmentDirectoryManagerOptions) {
    this.#attachmentsRoot = resolve(options.attachmentsRoot);
    this.#fileSystem = { ...defaultAttachmentFileSystem, ...options.fileSystem };
    this.#createUuid = options.createUuid ?? randomUUID;
    this.#targetHostId = options.targetHostId;
    this.#localHostId = options.localHostId;
    this.#readSourceFile = options.readSourceFile ?? ((path) => this.#fileSystem.readFile(path));
  }

  async createDirectory(): Promise<{ path: string }> {
    const directoryPath = join(this.#attachmentsRoot, this.#createUuid());
    await this.#fileSystem.createDirectory(directoryPath);
    this.#directories.add(directoryPath);
    return { path: directoryPath };
  }

  async write(input: {
    readonly contentsBase64: string;
    readonly directoryPath: string;
    readonly filename: string;
  }): Promise<CodexLiveFileAttachment> {
    await this.#assertOwnedDirectory(input.directoryPath);
    const label = sanitizeAttachmentFilename(input.filename);
    const filePath = join(input.directoryPath, label);
    await this.#fileSystem.writeFile(filePath, Buffer.from(input.contentsBase64, "base64"));
    return {
      label,
      path: filePath,
      fsPath: filePath,
    };
  }

  async removeDirectory(directoryPath: string): Promise<void> {
    await this.#assertOwnedDirectory(directoryPath);
    await this.#fileSystem.removeDirectory(directoryPath);
    this.#directories.delete(directoryPath);
  }

  async removeMaterializedDraft(
    materialized: Pick<CodexThreadGoalMaterializedDraft, "attachmentDirectory"> | null | undefined,
  ): Promise<void> {
    if (materialized?.attachmentDirectory == null) return;
    await this.removeDirectory(materialized.attachmentDirectory);
  }

  async materializeDraft(
    draft: ThreadGoalDraftMaterializationInput,
  ): Promise<CodexThreadGoalMaterializedDraft> {
    let objective = draft.objective.trim();
    let attachmentDirectory: string | null = null;

    const ensureAttachmentDirectory = async () => {
      if (attachmentDirectory !== null) return attachmentDirectory;
      const created = await this.createDirectory();
      attachmentDirectory = created.path;
      return created.path;
    };

    const writeAttachment = async (attachment: {
      readonly filename: string;
      readonly contentsBase64: string;
    }) => {
      return await this.write({
        ...attachment,
        directoryPath: await ensureAttachmentDirectory(),
      });
    };

    try {
      const pastedTextAttachments = await Promise.all(
        (draft.pastedTextAttachments ?? []).map(async (attachment, index) => ({
          filename: `pasted-text-${index + 1}.txt`,
          contentsBase64: await readPastedTextAttachmentBase64(
            attachment,
            this.#readSourceFile,
            this.#targetHostId,
          ),
        })),
      );

      const localImageAttachments: Array<{
        contentsBase64: string;
        filename: string;
        position: number;
      }> = [];
      const remoteImageUrls: Array<{ position: number; url: string }> = [];

      for (const [index, attachment] of (draft.imageAttachments ?? []).entries()) {
        const position = index + 1;
        const source = getGoalImageSource(attachment);
        if (isRemoteImageUrl(source)) {
          remoteImageUrls.push({ position, url: source });
          continue;
        }
        localImageAttachments.push({
          contentsBase64: await readImageAttachmentBase64(
            attachment,
            source,
            this.#readSourceFile,
            this.#targetHostId,
            this.#localHostId,
          ),
          filename: `image-${position}.${inferImageAttachmentExtension(attachment, source)}`,
          position,
        });
      }

      if (
        objective.length === 0 &&
        pastedTextAttachments.length === 0 &&
        localImageAttachments.length === 0 &&
        remoteImageUrls.length === 0
      ) {
        throw new Error("Goal objective must not be empty");
      }

      const pastedTextReferences: string[] = [];
      for (const attachment of pastedTextAttachments) {
        const file = await writeAttachment(attachment);
        pastedTextReferences.push(
          `- pasted text file: ${file.path}. Read this file before continuing.`,
        );
      }
      objective = appendThreadGoalReferenceSection(
        objective,
        "Referenced pasted text files:",
        pastedTextReferences,
      );

      const imageFileReferences: string[] = [];
      for (const attachment of localImageAttachments) {
        const file = await writeAttachment(attachment);
        imageFileReferences.push(`- [Image #${attachment.position}]: ${file.path}`);
      }
      objective = appendThreadGoalReferenceSection(
        objective,
        "Referenced image files:",
        imageFileReferences,
      );
      objective = appendThreadGoalReferenceSection(
        objective,
        "Referenced image URLs:",
        remoteImageUrls.map((attachment) => `- [Image #${attachment.position}]: ${attachment.url}`),
      );

      if (Array.from(objective).length <= THREAD_GOAL_INLINE_OBJECTIVE_MAX_CODE_POINTS) {
        return { objective, attachmentDirectory };
      }

      const fileReference = buildThreadGoalObjectiveFileReference(
        join(await ensureAttachmentDirectory(), THREAD_GOAL_OBJECTIVE_FILE),
      );
      await writeAttachment({
        filename: THREAD_GOAL_OBJECTIVE_FILE,
        contentsBase64: Buffer.from(objective, "utf8").toString("base64"),
      });
      return {
        objective: fileReference,
        attachmentDirectory,
      };
    } catch (error) {
      if (attachmentDirectory !== null) {
        await this.removeDirectory(attachmentDirectory).catch(() => undefined);
      }
      throw error;
    }
  }

  async #assertOwnedDirectory(directoryPath: string): Promise<void> {
    if (!this.#directories.has(directoryPath)) {
      throw new Error("Unknown thread goal attachment directory");
    }
    const directoryName = basename(directoryPath);
    if (
      !V4_UUID_PATTERN.test(directoryName) ||
      directoryPath !== join(this.#attachmentsRoot, directoryName)
    ) {
      throw new Error("Invalid thread goal attachment directory");
    }
  }
}

export function getThreadGoalAttachmentsRoot(basePath: string): string {
  return join(basePath, THREAD_GOAL_ATTACHMENTS_DIR);
}

export async function readThreadGoalEditableObjective(input: {
  attachmentsRoot: string;
  objective: string;
  readFile?: (path: string) => Promise<string>;
}): Promise<string> {
  const filePath = parseThreadGoalObjectiveFileReference(input.objective);
  if (filePath === null) return input.objective;
  if (!isOwnedThreadGoalObjectiveFilePath(input.attachmentsRoot, filePath)) return input.objective;
  return input.readFile ? await input.readFile(filePath) : await readFile(filePath, "utf8");
}

export function parseThreadGoalObjectiveFileReference(objective: string): string | null {
  if (!objective.startsWith(THREAD_GOAL_OBJECTIVE_PREFIX)) return null;
  if (!objective.endsWith(THREAD_GOAL_OBJECTIVE_SUFFIX)) return null;
  const filePath = objective.slice(
    THREAD_GOAL_OBJECTIVE_PREFIX.length,
    -THREAD_GOAL_OBJECTIVE_SUFFIX.length,
  );
  return filePath.length > 0 ? filePath : null;
}

function createEmptyPastedTextAttachmentRegistryState(): PastedTextAttachmentRegistryState {
  return {
    attachmentPaths: new Set(),
    pendingRemovalPaths: new Set(),
    textExcerptsByPath: new Map(),
  };
}

function parsePastedTextAttachmentRegistry(value: unknown): SerializedPastedTextAttachmentRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid pasted text attachment registry");
  }
  const record = value as Record<string, unknown>;
  return {
    attachmentPaths: parseRegistryStringArray(record.attachmentPaths),
    pendingRemovalPaths: parseRegistryStringArray(record.pendingRemovalPaths),
    textExcerptsByPath: parseRegistryStringRecord(record.textExcerptsByPath ?? {}),
  };
}

function parseRegistryStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Invalid pasted text attachment registry");
  }
  return value;
}

function parseRegistryStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid pasted text attachment registry");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("Invalid pasted text attachment registry");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeComparableAttachmentPath(path: string): string {
  const uncMatch = path.match(/^\\\\\?\\UNC\\(.*)$/i);
  const withoutUncPrefix = uncMatch === null ? path : `\\\\${uncMatch[1]}`;
  const withoutDevicePrefix =
    withoutUncPrefix.match(/^\\\\\?\\([a-zA-Z]:[\\/].*)$/)?.[1] ?? withoutUncPrefix;
  const normalized = withoutDevicePrefix.replace(/\\/g, "/").toLowerCase();
  const wslMatch = normalized.match(/^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(?:\/(.*))?$/);
  if (wslMatch !== null) {
    const relativePath = wslMatch[1] ?? "";
    return relativePath.length > 0 ? `/${relativePath}` : "/";
  }
  const driveMatch = normalized.match(/^\/?([a-z]):(?:\/(.*))?$/);
  if (driveMatch === null) return normalized;
  const [, drive, relativePath] = driveMatch;
  return relativePath?.length ? `/mnt/${drive}/${relativePath}` : `/mnt/${drive}`;
}

function isManagedPastedTextAttachmentFilePath(path: string, attachmentsRoot: string): boolean {
  const normalizedRoot = normalizeComparableAttachmentPath(attachmentsRoot).replace(/\/+$/, "");
  const normalizedPath = normalizeComparableAttachmentPath(path);
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return false;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  return (
    MANAGED_PASTED_TEXT_RELATIVE_PATH_PATTERN.test(relativePath) &&
    !relativePath.endsWith("/.") &&
    !relativePath.endsWith("/..")
  );
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  if (
    error.message.includes("ENOENT") ||
    error.message.includes("No such file or directory") ||
    /\(os error [23]\)/.test(error.message)
  ) {
    return true;
  }
  if (!("cause" in error) || error.cause === undefined || error.cause === error) return false;
  return isMissingFileError(error.cause);
}

function clonePastedTextAttachment(
  attachment: CodexPastedTextAttachment,
): CodexPastedTextAttachment {
  return {
    ...attachment,
    file: { ...attachment.file },
  };
}

function summarizePastedTextAttachmentPreview(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= PASTED_TEXT_PREVIEW_MAX_CODE_UNITS) return normalized;
  return `${normalized.slice(0, PASTED_TEXT_PREVIEW_MAX_CODE_UNITS - 1)}…`;
}

function buildPastedTextAttachmentPreview(text: string): string {
  return summarizePastedTextAttachmentPreview(text) || PASTED_TEXT_FALLBACK_PREVIEW;
}

async function readPastedTextAttachmentBase64(
  attachment: CodexThreadGoalPastedTextAttachmentInput,
  readSourceFile: (path: string, hostId?: string) => Promise<Buffer>,
  targetHostId?: string,
): Promise<string> {
  if ("file" in attachment && attachment.file !== undefined) {
    return (
      await readSourceFile(
        attachment.file.fsPath,
        attachment.hostId ?? attachment.file.hostId ?? targetHostId,
      )
    ).toString("base64");
  }
  if ("text" in attachment) {
    return Buffer.from(attachment.text, "utf8").toString("base64");
  }
  throw new Error("Pasted text attachment requires a file or raw text");
}

function getGoalImageSource(attachment: CodexThreadGoalImageAttachmentInput): string {
  return attachment.src;
}

async function readImageAttachmentBase64(
  attachment: CodexThreadGoalImageAttachmentInput,
  source: string,
  readSourceFile: (path: string, hostId?: string) => Promise<Buffer>,
  targetHostId?: string,
  localHostId?: string,
): Promise<string> {
  if (source.startsWith("data:")) {
    const dataUrlMatch = source.match(/^data:[^,]*?(;base64)?,(.*)$/is);
    if (dataUrlMatch === null) throw new Error("Unable to decode goal image");
    if (dataUrlMatch[1] === undefined) {
      return Buffer.from(decodeURIComponent(dataUrlMatch[2] ?? ""), "utf8").toString("base64");
    }
    return dataUrlMatch[2] ?? "";
  }

  const rawPath = attachment.localPath ?? source.replace(/^file:\/\//i, "");
  const filePath =
    attachment.localPath === undefined || attachment.localPath === null
      ? decodeURIComponent(rawPath)
      : rawPath;
  const sourceHostId =
    attachment.localPath === undefined || attachment.localPath === null
      ? localHostId
      : targetHostId;
  return (await readSourceFile(filePath, sourceHostId)).toString("base64");
}

function inferImageAttachmentExtension(
  attachment: CodexThreadGoalImageAttachmentInput,
  source: string,
): string {
  const namedExtension = (attachment.filename ?? attachment.localPath ?? "").match(
    /\.([a-z0-9]{1,8})$/i,
  )?.[1];
  if (namedExtension) return namedExtension.toLowerCase();

  const mimeExtension = source.match(/^data:image\/([a-z0-9.+-]+);/i)?.[1];
  if (mimeExtension === "jpeg") return "jpg";
  return mimeExtension?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "png";
}

function sanitizeAttachmentFilename(filename: string): string {
  const normalized = filename.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const sanitized = (normalized.split("/").at(-1) ?? normalized).replace(/[\\/:]/g, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") return "attachment";
  return sanitized;
}

function appendThreadGoalReferenceSection(
  objective: string,
  heading: string,
  lines: readonly string[],
): string {
  if (lines.length === 0) return objective;
  return `${objective.length > 0 ? `${objective}\n\n` : ""}${heading}\n${lines.join("\n")}`;
}

function buildThreadGoalObjectiveFileReference(filePath: string): string {
  const reference = `${THREAD_GOAL_OBJECTIVE_PREFIX}${filePath}${THREAD_GOAL_OBJECTIVE_SUFFIX}`;
  if (Array.from(reference).length > THREAD_GOAL_INLINE_OBJECTIVE_MAX_CODE_POINTS) {
    throw new Error(
      `Goal objective file reference exceeds ${THREAD_GOAL_INLINE_OBJECTIVE_MAX_CODE_POINTS} characters`,
    );
  }
  return reference;
}

function isRemoteImageUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function isOwnedThreadGoalObjectiveFilePath(attachmentsRoot: string, filePath: string): boolean {
  const resolvedRoot = resolve(attachmentsRoot);
  const resolvedFilePath = resolve(filePath);
  const directoryName = basename(dirname(resolvedFilePath));
  if (!THREAD_GOAL_OBJECTIVE_DIRECTORY_PATTERN.test(directoryName)) return false;
  return resolvedFilePath === join(resolvedRoot, directoryName, THREAD_GOAL_OBJECTIVE_FILE);
}
