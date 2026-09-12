import * as path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
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
