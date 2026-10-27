import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make as makeNativeAttachments } from "./NativeSessionMessageAttachments";
import { SessionMessageIntakeError } from "./SessionMessageIntakeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { SessionAttachmentReference } from "../../shared/nodex-app-tools/session-message-schema";
import { runtimeSessionTarget } from "../../shared/nodex-app-tools/session-execution-target";

export interface ResolvedSessionAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Obtained from an authorized resource owner, never accepted as a caller-supplied path. */
  readonly source: string;
}

/** Resolve resources before intake; downstream owners materialize their normal durable input. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const application = yield* AgentRuntimeApplication;
  const files = yield* FileExportRuntime;
  const nativeAttachments = yield* makeNativeAttachments;
  return Effect.fn("SessionMessageAttachments.resolve")(function* (
    references: readonly SessionAttachmentReference[],
  ) {
    return yield* Effect.forEach(
      references,
      (reference): Effect.Effect<ResolvedSessionAttachment, unknown> =>
        Effect.gen(function* () {
          if (reference.type === "library_file") {
            const source = reference.pageId
              ? { kind: "page" as const, page_id: reference.pageId }
              : { kind: "direct" as const };
            const result = yield* core.library.read({
              kind: "file_presentation",
              file_id: reference.fileId,
              source,
              ...(reference.version === undefined ? {} : { version: reference.version }),
            });
            if (result.value.kind !== "file_presentation")
              return yield* Effect.fail(
                new SessionMessageIntakeError({ message: "File resource is unavailable" }),
              );
            const metadata = result.value.value;
            const path = yield* files.materialize(
              { kind: "library" },
              { fileId: reference.fileId, source, version: metadata.version },
            );
            // Recheck the live actor after the asynchronous export, using the same immutable version.
            yield* core.library.read({
              kind: "file_presentation",
              file_id: reference.fileId,
              source,
              version: metadata.version,
            });
            return {
              name: metadata.default_name,
              mimeType: metadata.mime_type,
              sizeBytes: metadata.byte_length,
              source: path,
            };
          }
          const provenance = yield* CoreApplicationAgent;
          if (!provenance)
            return yield* new SessionMessageIntakeError({
              message: "Attachment execution authority is unavailable",
            });
          const source = yield* core.workspace.read(
            { kind: "agent_session", session_id: reference.sessionId, provenance },
            undefined,
            provenance.authority.actor_project_id ?? null,
          );
          if (source.value.kind !== "agent_session")
            return yield* new SessionMessageIntakeError({
              message: "Attachment Session is unavailable",
            });
          if (!source.value.session.execution_ref) {
            const thread = source.value.thread;
            if (
              !thread ||
              thread.backend_binding.kind !== "codex" ||
              reference.execution ||
              !reference.runId ||
              (reference.sourceThreadId && reference.sourceThreadId !== thread.thread_id)
            )
              return yield* new SessionMessageIntakeError({
                message: "Native attachment needs its original Session, item and Run identities",
              });
            const resource = yield* nativeAttachments({
              threadId: thread.thread_id,
              hostId: thread.execution_host_id,
              itemId: reference.itemId,
              runId: reference.runId,
              attachmentId: reference.attachmentId,
            });
            const check = yield* core.workspace.read(
              { kind: "agent_session", session_id: reference.sessionId, provenance },
              undefined,
              provenance.authority.actor_project_id ?? null,
            );
            if (
              check.value.kind !== "agent_session" ||
              check.value.session.execution_ref ||
              check.value.thread?.thread_id !== thread.thread_id ||
              check.value.thread.execution_host_id !== thread.execution_host_id
            )
              return yield* new SessionMessageIntakeError({
                message: "Attachment source binding changed during export",
              });
            return resource;
          }
          const resource = yield* application.attachment({
            ...runtimeSessionTarget(reference),
            itemId: reference.itemId,
            attachmentId: reference.attachmentId,
            ...(reference.sourceThreadId ? { sourceThreadId: reference.sourceThreadId } : {}),
          });
          if (resource === null)
            return yield* Effect.fail(
              new SessionMessageIntakeError({ message: "Session attachment is unavailable" }),
            );
          if (resource.attachment)
            return {
              name: resource.attachment.name,
              mimeType: resource.attachment.mimeType,
              sizeBytes: resource.attachment.sizeBytes,
              source: "path" in resource ? resource.path : resource.dataUrl,
            };
          if (!("dataUrl" in resource))
            return yield* Effect.fail(
              new SessionMessageIntakeError({ message: "Attachment metadata is unavailable" }),
            );
          const parsed = parseBase64DataUrl(resource.dataUrl);
          if (!parsed?.mimeType.startsWith("image/"))
            return yield* Effect.fail(
              new SessionMessageIntakeError({ message: "Generated image resource is invalid" }),
            );
          return {
            name: "Generated image",
            mimeType: parsed.mimeType,
            sizeBytes: Buffer.from(parsed.base64, "base64").byteLength,
            source: resource.dataUrl,
          };
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(SessionMessageIntakeError)(cause)
          ? cause
          : new SessionMessageIntakeError({ message: "Attachment resource is unavailable" }),
      ),
    );
  });
});
