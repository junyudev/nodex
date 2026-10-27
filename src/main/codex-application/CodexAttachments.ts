import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  getProviderAttachmentLimitError,
} from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
  CodexPromptInput,
  CodexThreadGoalDraftInput,
  CodexThreadGoalFrozenDraft,
  CodexThreadGoalMaterializedDraft,
  CodexThreadGoalPastedTextAttachmentInput,
} from "../../shared/types";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  type AttachmentFileSystem,
  PastedTextAttachmentManager,
  ThreadGoalAttachmentDirectoryManager,
  getThreadGoalAttachmentsRoot,
  readThreadGoalEditableObjective,
  type MaterializedPastedTextAttachmentSources,
} from "../thread-goal-attachments";
import { ExecutionHostRuntime, type ExecutionHostDescriptor } from "./ExecutionHostRuntime";

const DURABLE_HOST_ID = "durable";

/** Sources are resolved by an authorized resource owner before reaching this boundary. */
export interface CodexAttachmentResource {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source: string;
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const missingFile = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  if (/ENOENT|No such file or directory|\(os error [23]\)/u.test(error.message)) return true;
  return error.cause !== error && error.cause !== undefined && missingFile(error.cause);
};

const readResource = async (resource: CodexAttachmentResource): Promise<Buffer> => {
  const maximum = resource.mimeType.startsWith("image/")
    ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  if (
    !Number.isSafeInteger(resource.sizeBytes) ||
    resource.sizeBytes < 1 ||
    resource.sizeBytes > maximum
  )
    throw new Error("Attachment exceeds its byte budget");
  if (resource.source.startsWith("data:")) {
    if (resource.source.length > Math.ceil(maximum / 3) * 4 + 256)
      throw new Error("Attachment exceeds its byte budget");
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
      resource.source,
    );
    if (!match || match[1] !== resource.mimeType)
      throw new Error("Attachment must be a materialized file or image data URL");
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength !== resource.sizeBytes) throw new Error("Attachment resource changed");
    return bytes;
  }
  const file = await open(resource.source, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== resource.sizeBytes)
      throw new Error("Attachment resource changed");
    const bytes = Buffer.alloc(resource.sizeBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("Attachment resource changed");
      offset += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0)
      throw new Error("Attachment resource changed");
    return bytes;
  } finally {
    await file.close();
  }
};

export class CodexAttachmentsError extends Schema.TaggedError<CodexAttachmentsError>()(
  "CodexAttachmentsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new CodexAttachmentsError({ operation, cause }),
  });

export class CodexAttachments extends Context.Service<
  CodexAttachments,
  {
    readonly materializeResources: (
      hostId: string,
      resources: readonly CodexAttachmentResource[],
    ) => Effect.Effect<Pick<CodexPromptInput, "images" | "fileAttachments">, CodexAttachmentsError>;
    readonly createPastedText: (input: {
      readonly text: string;
      readonly hostId?: string;
    }) => Effect.Effect<CodexPastedTextAttachment, CodexAttachmentsError>;
    readonly readPastedText: (
      file: CodexLiveFileAttachment,
    ) => Effect.Effect<string, CodexAttachmentsError>;
    readonly getTextExcerpts: (
      files: readonly CodexLiveFileAttachment[] | null | undefined,
    ) => Effect.Effect<readonly string[], CodexAttachmentsError>;
    readonly removePastedText: (
      file: CodexLiveFileAttachment,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly materializePastedText: (
      attachments: CodexThreadGoalDraftInput["pastedTextAttachments"],
      fallbackHostId?: string,
    ) => Effect.Effect<MaterializedPastedTextAttachmentSources, CodexAttachmentsError>;
    readonly cleanupGoalSources: (
      draft: CodexThreadGoalDraftInput | CodexThreadGoalFrozenDraft | null | undefined,
      fallbackHostId?: string,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly materializeGoal: (
      hostId: string,
      draft: CodexThreadGoalDraftInput | CodexThreadGoalFrozenDraft,
    ) => Effect.Effect<CodexThreadGoalMaterializedDraft, CodexAttachmentsError>;
    readonly cleanupMaterializedGoal: (
      hostId: string,
      attachmentDirectory: string | null,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly readEditableObjective: (
      hostId: string,
      objective: string,
    ) => Effect.Effect<string, CodexAttachmentsError>;
  }
>()("nodex/main/codex-application/CodexAttachments") {}

interface HostAttachmentManagers {
  readonly descriptor: ExecutionHostDescriptor;
  readonly attachmentsRoot: string;
  readonly fileSystem: AttachmentFileSystem;
  readonly pastedText: PastedTextAttachmentManager;
  readonly goals: ThreadGoalAttachmentDirectoryManager;
}

const hostAttachmentsRoot = (descriptor: ExecutionHostDescriptor): string =>
  descriptor.kind === "ssh"
    ? path.posix.join(descriptor.codexHome, "attachments")
    : getThreadGoalAttachmentsRoot(descriptor.codexHome);

const clonePastedTextAttachment = (
  attachment: CodexThreadGoalPastedTextAttachmentInput,
): CodexPastedTextAttachment | null => {
  if (!("file" in attachment) || attachment.file === undefined) return null;
  return {
    file: { ...attachment.file },
    preview: attachment.preview ?? "Pasted text",
    ...(attachment.hostId === undefined ? {} : { hostId: attachment.hostId }),
    ...(attachment.characterCount === undefined
      ? {}
      : { characterCount: attachment.characterCount }),
  };
};

export const live: Layer.Layer<
  CodexAttachments,
  never,
  CodexGateway | ExecutionHostRuntime | ScopedCallbackRuntime
> = Layer.effect(
  CodexAttachments,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const executionHosts = yield* ExecutionHostRuntime;
    const callbacks = yield* ScopedCallbackRuntime;
    const managers = new Map<string, HostAttachmentManagers>();

    const readHostFile = async (hostId: string, filePath: string): Promise<Buffer> => {
      const response = await callbacks.runPromise(
        gateway.requestOnHost(hostId, "fs/readFile", { path: filePath }),
      );
      return Buffer.from(response.dataBase64, "base64");
    };

    const makeHostFileSystem = (hostId: string): AttachmentFileSystem => ({
      createDirectory: async (directoryPath) => {
        await callbacks.runPromise(
          gateway.requestOnHost(hostId, "fs/createDirectory", {
            path: directoryPath,
            recursive: true,
          }),
        );
      },
      readFile: (filePath) => readHostFile(hostId, filePath),
      writeFile: async (filePath, data) => {
        await callbacks.runPromise(
          gateway.requestOnHost(hostId, "fs/writeFile", {
            path: filePath,
            dataBase64: Buffer.from(data).toString("base64"),
          }),
        );
      },
      removeFile: async (filePath) => {
        await callbacks.runPromise(
          gateway.requestOnHost(hostId, "fs/remove", { path: filePath, force: true }),
        );
      },
      removeDirectory: async (directoryPath) => {
        await callbacks.runPromise(
          gateway.requestOnHost(hostId, "fs/remove", {
            path: directoryPath,
            recursive: true,
            force: true,
          }),
        );
      },
    });

    const forHost = async (hostId: string): Promise<HostAttachmentManagers> => {
      if (hostId === DURABLE_HOST_ID) {
        throw new Error("Durable goal attachments require cloud attachment materialization");
      }
      const host = await callbacks.runPromise(executionHosts.resolve(hostId));
      const attachmentsRoot = hostAttachmentsRoot(host.descriptor);
      const existing = managers.get(hostId);
      if (existing?.attachmentsRoot === attachmentsRoot) return existing;

      const fileSystem = makeHostFileSystem(hostId);
      const pastedText = new PastedTextAttachmentManager({
        attachmentsRoot,
        fileSystem,
        hostId,
      });
      const goals = new ThreadGoalAttachmentDirectoryManager({
        attachmentsRoot,
        fileSystem,
        targetHostId: hostId,
        localHostId: gateway.localHostId,
        readSourceFile: (filePath, sourceHostId) =>
          readHostFile(sourceHostId ?? gateway.localHostId, filePath),
      });
      const next = {
        descriptor: host.descriptor,
        attachmentsRoot,
        fileSystem,
        pastedText,
        goals,
      } satisfies HostAttachmentManagers;
      managers.set(hostId, next);
      void pastedText.cleanupPendingRemovals().catch(() => undefined);
      return next;
    };

    const removePastedTextOnHost = async (hostId: string, file: CodexLiveFileAttachment) => {
      const manager = await forHost(hostId);
      await manager.pastedText.remove(file.path);
    };

    const materializePastedText = async (
      attachments: readonly CodexThreadGoalPastedTextAttachmentInput[],
      fallbackHostId = gateway.localHostId,
    ): Promise<MaterializedPastedTextAttachmentSources> => {
      const materialized: CodexPastedTextAttachment[] = [];
      const created: Array<{ readonly hostId: string; readonly file: CodexLiveFileAttachment }> =
        [];
      try {
        for (const attachment of attachments) {
          const existing = clonePastedTextAttachment(attachment);
          if (existing) {
            materialized.push(existing);
            continue;
          }
          if (!("text" in attachment)) {
            throw new Error("Pasted text attachment requires a file or raw text");
          }
          const hostId = attachment.hostId ?? fallbackHostId;
          const manager = await forHost(hostId);
          const value = await manager.pastedText.createRawSource({
            text: attachment.text,
            hostId,
            ...(attachment.preview === undefined ? {} : { preview: attachment.preview }),
          });
          created.push({ hostId, file: value.file });
          materialized.push(value);
        }
        return {
          attachments: materialized,
          createdAttachmentPaths: created.map(({ file }) => file.path),
        };
      } catch (error) {
        await Promise.allSettled(
          created.map(({ hostId, file }) => removePastedTextOnHost(hostId, file)),
        );
        throw error;
      }
    };

    return CodexAttachments.of({
      materializeResources: (hostId, resources) =>
        attempt("materialize-resources", async () => {
          const limit = getProviderAttachmentLimitError(
            resources.map((resource) => ({
              ...resource,
              type: resource.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
            })),
          );
          if (limit) throw new Error(limit);
          const images: NonNullable<CodexPromptInput["images"]> = [];
          const fileAttachments: NonNullable<CodexPromptInput["fileAttachments"]> = [];
          if (resources.length === 0) return { images, fileAttachments };
          const manager = await forHost(hostId);
          const host = await callbacks.runPromise(executionHosts.resolve(hostId));
          for (const resource of resources) {
            const bytes = await readResource(resource);
            const sha256 = digest(bytes);
            const name =
              path.posix
                .basename(resource.name.replaceAll("\\", "/"))
                .replaceAll(/[^A-Za-z0-9._-]/gu, "_")
                .slice(-100) || "attachment";
            const directory = path.posix.join(manager.attachmentsRoot, "resources", sha256);
            const filePath = path.posix.join(
              directory,
              `${digest(resource.name).slice(0, 16)}-${name}`,
            );
            if (manager.descriptor.kind === "local") {
              await mkdir(directory, { recursive: true, mode: 0o700 });
              const temporary = `${filePath}.${randomUUID()}.part`;
              try {
                await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
                await link(temporary, filePath).catch((error: unknown) => {
                  if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
                    throw error;
                });
                if (digest(await readResource({ ...resource, source: filePath })) !== sha256)
                  throw new Error("Materialized attachment changed");
              } finally {
                await rm(temporary, { force: true });
              }
            } else {
              const transfer = host.transfer;
              if (!transfer) throw new Error("Execution host attachment transfer is unavailable");
              const existing = await callbacks
                .runPromise(transfer.describe(filePath))
                .catch((error: unknown) => {
                  if (!missingFile(error)) throw error;
                  return null;
                });
              if (existing && (existing.sha256 !== sha256 || existing.size !== bytes.byteLength))
                throw new Error("Materialized attachment changed");
              if (!existing) {
                const temporary = await mkdtemp(path.join(tmpdir(), "nodex-attachment-"));
                const operationId = `attachment-${randomUUID()}`;
                try {
                  const localPath = path.join(temporary, name);
                  await writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
                  const uploaded = await callbacks.runPromise(
                    transfer.upload({
                      localPath,
                      operationId,
                      fileName: name,
                      sha256,
                      size: bytes.byteLength,
                    }),
                  );
                  if (uploaded.sha256 !== sha256 || uploaded.size !== bytes.byteLength)
                    throw new Error("Attachment transfer failed integrity verification");
                  await manager.fileSystem.createDirectory(directory);
                  await callbacks.runPromise(
                    gateway.requestOnHost(hostId, "fs/copy", {
                      sourcePath: uploaded.path,
                      destinationPath: filePath,
                    }),
                  );
                  const published = await callbacks.runPromise(transfer.describe(filePath));
                  if (published.sha256 !== sha256 || published.size !== bytes.byteLength)
                    throw new Error("Attachment transfer failed integrity verification");
                } finally {
                  await Promise.allSettled([
                    rm(temporary, { recursive: true, force: true }),
                    callbacks.runPromise(transfer.cleanup(operationId)),
                  ]);
                }
              }
            }
            if (resource.mimeType.startsWith("image/")) {
              images.push({ source: filePath, caption: resource.name });
            } else {
              fileAttachments.push({
                label: resource.name,
                path: filePath,
                fsPath: filePath,
                hostId,
              });
            }
          }
          return { images, fileAttachments };
        }),
      createPastedText: (input) =>
        attempt("create-pasted-text", async () => {
          const hostId = input.hostId ?? gateway.localHostId;
          const manager = await forHost(hostId);
          return await manager.pastedText.createRawSource({ ...input, hostId });
        }),
      readPastedText: (file) =>
        attempt("read-pasted-text", async () => {
          const manager = await forHost(file.hostId ?? gateway.localHostId);
          return await manager.pastedText.readRawSource(file);
        }),
      getTextExcerpts: (files) =>
        attempt("get-pasted-text-excerpts", async () => {
          const excerpts: string[] = [];
          for (const file of files ?? []) {
            const manager = await forHost(file.hostId ?? gateway.localHostId);
            excerpts.push(...(await manager.pastedText.getTextExcerpts([file])));
          }
          return excerpts;
        }),
      removePastedText: (file) =>
        attempt("remove-pasted-text", () =>
          removePastedTextOnHost(file.hostId ?? gateway.localHostId, file),
        ),
      materializePastedText: (attachments, fallbackHostId) =>
        attempt("materialize-pasted-text", () =>
          materializePastedText(attachments, fallbackHostId ?? gateway.localHostId),
        ),
      cleanupGoalSources: (draft, fallbackHostId) =>
        attempt("cleanup-goal-sources", async () => {
          await Promise.allSettled(
            (draft?.pastedTextAttachments ?? []).flatMap((attachment) => {
              const existing = clonePastedTextAttachment(attachment);
              if (!existing) return [];
              const hostId =
                existing.hostId ?? existing.file.hostId ?? fallbackHostId ?? gateway.localHostId;
              return [removePastedTextOnHost(hostId, existing.file)];
            }),
          );
        }),
      materializeGoal: (hostId, draft) => {
        if (hostId === DURABLE_HOST_ID) {
          const objective = draft.objective.trim();
          if (draft.pastedTextAttachments.length > 0 || draft.imageAttachments.length > 0) {
            return Effect.fail(
              new CodexAttachmentsError({
                operation: "materialize-goal",
                cause: new Error(
                  "Durable goal attachments require cloud attachment materialization",
                ),
              }),
            );
          }
          if (!objective) {
            return Effect.fail(
              new CodexAttachmentsError({
                operation: "materialize-goal",
                cause: new Error("Goal objective must not be empty"),
              }),
            );
          }
          return Effect.succeed({ objective, attachmentDirectory: null });
        }
        return attempt("materialize-goal", async () => {
          const manager = await forHost(hostId);
          return await manager.goals.materializeDraft(draft);
        });
      },
      cleanupMaterializedGoal: (hostId, attachmentDirectory) => {
        if (attachmentDirectory === null || hostId === DURABLE_HOST_ID) return Effect.void;
        return attempt("cleanup-materialized-goal", async () => {
          const manager = await forHost(hostId);
          await manager.goals.removeDirectory(attachmentDirectory);
        });
      },
      readEditableObjective: (hostId, objective) => {
        if (hostId === DURABLE_HOST_ID) return Effect.succeed(objective);
        return attempt("read-editable-objective", async () => {
          const manager = await forHost(hostId);
          return await readThreadGoalEditableObjective({
            attachmentsRoot: manager.attachmentsRoot,
            objective,
            readFile: async (filePath) =>
              (await manager.fileSystem.readFile(filePath)).toString("utf8"),
          });
        });
      },
    });
  }),
);
