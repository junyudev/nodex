import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { z } from "zod";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "../shared/agent-runtime-api";
import {
  AgentRuntimeApplication,
  type AgentRuntimeApplicationError,
} from "../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { FileExportRuntime } from "../main/library-application/FileExportRuntime";
import { LibraryModule } from "../main/library-application/LibraryModule";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import { libraryContentRoute } from "../shared/content-routing-context";
import { parseFileSource } from "../shared/file-resources";
import { effectiveHolds, scopeHeld, spaceHeld } from "./work-application/execution-holds";
import {
  HOSTED_CHAT_MAX_FILES,
  type HostedChatMessageInputSchema,
  type HostedChatMessageSchema,
  type HostedChatQueueSchema,
  type HostedChatRewriteSchema,
  type HostedChatStartSchema,
} from "../shared/schemas/agent-runtime-api";
import { CodexGitProbe } from "../main/codex-application/CodexGitProbe";

export type HostedChatStartInput = Omit<z.infer<typeof HostedChatStartSchema>, "modelSelection"> & {
  readonly modelSelection: AgentRuntimeLaunch["modelSelection"];
};
export type HostedChatMessageInput = z.infer<typeof HostedChatMessageInputSchema>;
type ModelSelection = AgentRuntimeLaunch["modelSelection"];
export type MemberChatStartInput<E> = Omit<HostedChatStartInput, "modelSelection"> & {
  readonly modelSelection:
    | ModelSelection
    | { readonly requested: string; readonly resolve: Effect.Effect<ModelSelection, E> };
};
export type HostedChatQueueInput = z.infer<typeof HostedChatQueueSchema>;
export type HostedChatRewriteInput = z.infer<typeof HostedChatRewriteSchema>;
type HostedChatMessage = z.infer<typeof HostedChatMessageSchema>;
type Resources = AgentRuntimeOperations["attachments.import"]["input"]["attachments"];

/** A refusal the person can act on; its message is a product sentence for any of their Devices. */
export class MemberMessageRefusal extends Schema.TaggedError<MemberMessageRefusal>()(
  "MemberMessageRefusal",
  { reason: Schema.Literals(["missing", "rejected"]), message: Schema.String },
) {}

const missing = () =>
  new MemberMessageRefusal({ reason: "missing", message: "This chat is unavailable." });
const missingFile = () =>
  new MemberMessageRefusal({ reason: "missing", message: "This file is unavailable." });
const direct = { kind: "direct" } as const;
const resumeToSend = "Resume work to send.";
const resumeToStart = "Resume work to start this chat.";
const rejected = (message: string) => new MemberMessageRefusal({ reason: "rejected", message });
const runtimeRefusal = (resume: string) => (error: AgentRuntimeApplicationError) =>
  error.executionHeld
    ? rejected(resume)
    : error.admissionRejected
      ? rejected(error.message)
      : error;

/** Hash the submitted JSON, before resolving mutable model choices or Library Files. */
const fingerprint = (operation: "send" | "start", input: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(["nodex-member-chat", 1, operation, input], (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, (value as Record<string, unknown>)[key]]),
            )
          : value,
      ),
    )
    .digest("hex");

/**
 * A Member's message to a chat this host runs, from whichever of their Devices sent it. Desktops
 * and phones reach it through Core with that Member's invocation, and it delivers exactly as a
 * message typed into a local chat: it starts a Run, waits behind the active one, or steers it.
 * Its images and files are Library Files the Member uploaded, read here with their authority.
 */
export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  const projects = yield* ProjectWorkspace;
  const core = yield* CoreModules;
  const library = yield* LibraryModule;
  const exports = yield* FileExportRuntime;
  const git = yield* CodexGitProbe;
  const session = Effect.fn("MemberMessages.session")(function* (sessionId: string) {
    const row = yield* projects.getProjectSession(sessionId).pipe(Effect.mapError(missing));
    if (!row) return yield* missing();
    return row;
  });
  const writable = Effect.fn("MemberMessages.writable")(function* (sessionId: string) {
    const row = yield* session(sessionId);
    if (!row.executionRef || row.archived)
      return yield* new MemberMessageRefusal({
        reason: "rejected",
        message: row.archived
          ? "Restore this chat to continue it."
          : "Continue this chat on your desktop.",
      });
    return { sessionId, threadId: row.executionRef.threadId };
  });
  /** Core reads each File for the invoking Member; the Runtime receives a private local copy. */
  const resources = Effect.fn("MemberMessages.resources")(function* (refs: readonly string[]) {
    if (refs.length > HOSTED_CHAT_MAX_FILES)
      return yield* new MemberMessageRefusal({
        reason: "rejected",
        message: `Attach up to ${HOSTED_CHAT_MAX_FILES} files to one message.`,
      });
    return yield* Effect.forEach(refs, (ref) =>
      Effect.gen(function* () {
        const fileId = parseFileSource(ref);
        if (!fileId) return yield* missingFile();
        const read = yield* library
          .read(libraryContentRoute, {
            read: { mode: "file_presentation", file_id: fileId, source: direct },
          })
          .pipe(Effect.mapError(missingFile));
        if (!read.ok || read.value.value.kind !== "file_presentation") return yield* missingFile();
        const file = read.value.value.value;
        const source = yield* exports
          .materialize(libraryContentRoute, { fileId, source: direct, version: file.version })
          .pipe(Effect.mapError(missingFile));
        return {
          source,
          name: file.default_name,
          mimeType: file.mime_type,
          sizeBytes: file.byte_length,
        };
      }),
    );
  });
  /** The Runtime's message: everything the Device wrote, with its Library Files resolved apart. */
  const runtimeMessage = (message: HostedChatMessage) =>
    Effect.gen(function* () {
      const { fileRefs, ...rest } = message;
      return {
        message: rest,
        resources: fileRefs?.length ? yield* resources(fileRefs) : ([] as Resources),
      };
    });
  /** Sending never clears a pause; every Device asks the person to resume first, as a desktop does. */
  const sendable = Effect.fn("MemberMessages.sendable")(function* (sessionId: string) {
    const target = yield* writable(sessionId);
    if ((yield* effectiveHolds(core, { kind: "session", session_id: sessionId })).length)
      return yield* rejected(resumeToSend);
    return target;
  });
  const send = Effect.fn("MemberMessages.send")(function* <E = never>(
    input: HostedChatMessageInput,
    effort?: {
      readonly requested: string;
      readonly resolve: (target: {
        sessionId: string;
        threadId: string;
      }) => Effect.Effect<ModelSelection | undefined, E>;
    },
  ) {
    const { sessionId, threadId, message, delivery } = input;
    const identity = { sessionId, ...(threadId === undefined ? {} : { threadId }) };
    const messageFingerprint = fingerprint("send", [
      sessionId,
      message,
      delivery,
      effort?.requested,
    ]);
    const reply = ({ sequence, sideChatTitle }: { sequence: number; sideChatTitle?: string }) => ({
      sequence,
      ...(sideChatTitle === undefined ? {} : { sideChatTitle }),
    });
    const replay = yield* runtime
      .replayMessage({
        ...identity,
        messageId: message.messageId,
        fingerprint: messageFingerprint,
      })
      .pipe(Effect.mapError(runtimeRefusal(resumeToSend)));
    if (replay) return reply(replay);
    const root = yield* sendable(sessionId);
    const modelSelection = effort
      ? yield* effort.resolve({ sessionId, threadId: threadId ?? root.threadId })
      : undefined;
    const prepared = yield* runtimeMessage(message);
    return reply(
      yield* runtime
        .sendMessage({
          ...identity,
          mode: delivery === "send" ? "auto" : delivery,
          messageFingerprint,
          message: {
            ...prepared.message,
            ...(modelSelection === undefined ? {} : { modelSelection }),
          },
          ...(prepared.resources.length ? { resources: prepared.resources } : {}),
        })
        .pipe(Effect.mapError(runtimeRefusal(resumeToSend))),
    );
  });
  const queue = Effect.fn("MemberMessages.queue")(function* (input: HostedChatQueueInput) {
    yield* writable(input.sessionId);
    if (input.action !== "edit") return yield* runtime.queue(input);
    const { message, resources } = yield* runtimeMessage(input.message);
    return yield* runtime.queue({ ...input, message, ...(resources.length ? { resources } : {}) });
  });
  /** A Member's edit of their own message rewinds the chat to it, as a local edit does. */
  const rewrite = Effect.fn("MemberMessages.rewrite")(function* (input: HostedChatRewriteInput) {
    yield* sendable(input.sessionId);
    const { message, resources } = yield* runtimeMessage(input.message);
    return yield* runtime.rewriteMessage({
      ...input,
      message,
      ...(resources.length ? { resources } : {}),
    });
  });
  /** A new worktree starts from the branch the host's checkout of the Project is on. */
  const worktreeStart = Effect.fn("MemberMessages.worktreeStart")(function* (root: string) {
    const current = yield* git.readPath(root, ["symbolic-ref", "--short", "HEAD"]);
    const branchName =
      current ??
      (yield* git.readPath(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(
        /^origin\//u,
        "",
      ) ??
      (yield* git.readPath(root, [
        "for-each-ref",
        "--count=1",
        "--format=%(refname:short)",
        "refs/heads",
      ])) ??
      "HEAD";
    return { type: "branch" as const, branchName };
  });
  /**
   * A new chat a Member starts from any of their Devices, delivered as the Inbox delivers the
   * chats it starts: a retry of the same start never launches it twice. It runs in this host's
   * tasks directory, or where this host runs its Project, and Core makes the Member its owner.
   */
  const start = Effect.fn("MemberMessages.start")(function* <E = never>(
    input: MemberChatStartInput<E>,
  ) {
    const { modelSelection: selection, ...request } = input;
    const messageFingerprint = fingerprint("start", [
      request,
      "resolve" in selection ? selection.requested : selection,
    ]);
    const replay = yield* runtime
      .replayMessage({
        sessionId: input.sessionId,
        launchId: input.launchId,
        messageId: input.message.messageId,
        fingerprint: messageFingerprint,
      })
      .pipe(Effect.mapError(runtimeRefusal(resumeToStart)));
    if (replay)
      return { sessionId: replay.sessionId, threadId: replay.threadId, projectId: input.projectId };
    if (
      (yield* spaceHeld(core)) ||
      (input.projectId &&
        (yield* scopeHeld(core, { kind: "project", project_id: input.projectId })))
    )
      return yield* rejected(resumeToStart);
    const location = yield* runtime
      .executionWorkspace(input.projectId)
      .pipe(Effect.mapError(() => missing()));
    if (!location.available)
      return yield* new MemberMessageRefusal({ reason: "rejected", message: location.reason });
    if (input.runInTarget === "newWorktree" && !input.projectId)
      return yield* new MemberMessageRefusal({
        reason: "rejected",
        message: "Choose a Project for this worktree.",
      });
    const modelSelection = "resolve" in selection ? yield* selection.resolve : selection;
    const { message, resources } = yield* runtimeMessage(input.message);
    const startingState =
      input.runInTarget === "newWorktree" ? yield* worktreeStart(location.workspaceRoot) : null;
    const { threadId } = yield* runtime
      .launch({
        sessionId: input.sessionId,
        launchId: input.launchId,
        acceptedAt: input.acceptedAt,
        projectId: input.projectId,
        title: input.title,
        ...(input.initialPageIds?.length ? { initialPageIds: input.initialPageIds } : {}),
        modelSelection,
        interactionMode: input.interactionMode,
        runInTarget: input.runInTarget ?? "localProject",
        ...(startingState ? { worktreeStartingState: startingState } : {}),
        messageFingerprint,
        message,
        ...(resources.length ? { resources } : {}),
      })
      .pipe(Effect.mapError(runtimeRefusal(resumeToStart)));
    return { sessionId: input.sessionId, threadId, projectId: input.projectId };
  });
  return { session, writable, resources, send, queue, rewrite, start };
});

export class MemberMessages extends Context.Service<MemberMessages, Effect.Success<typeof make>>()(
  "nodex/host/MemberMessages",
) {}
export const live = Layer.effect(MemberMessages, make);
