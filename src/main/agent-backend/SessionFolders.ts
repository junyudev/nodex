import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import { HostWorkspace } from "../../host/HostWorkspace";
import { MainConfig } from "../app/MainConfig";
import {
  codexProjectlessWorkspaceRootFromCwd,
  resolveExistingCodexProjectlessWorkspace,
} from "../codex-application/CodexTurnWorkspace";
import {
  createCodexProjectlessWorkspace,
  removeEmptyChatDirectory,
  resolveChosenChatDirectory,
} from "../codex/codex-projectless-workspace";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { resolveNodexProjectsDirectory } from "../nodex-projects-directory";

type Folder = components["schemas"]["ChatFolder"];

export class SessionFolderError extends Schema.TaggedError<SessionFolderError>()(
  "SessionFolderError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

interface EnsureOptions {
  readonly nameHint?: string;
  readonly legacyWorkspace?: {
    readonly cwd: string | null;
    readonly writableRoots: readonly string[];
    readonly browserRoot?: string | null;
  };
  readonly readExecutionCwd?: (threadId: string) => Effect.Effect<string | null, unknown>;
}

export class SessionFolders extends Context.Service<
  SessionFolders,
  {
    readonly ensure: (
      sessionId: string,
      options?: EnsureOptions,
    ) => Effect.Effect<Folder, SessionFolderError>;
    readonly choose: (
      sessionId: string,
      absolutePath: string,
    ) => Effect.Effect<Folder, SessionFolderError>;
    readonly cleanDeleted: (folders: readonly Folder[]) => Effect.Effect<void>;
  }
>()("nodex/main/agent-backend/SessionFolders") {}

const folderError = (cause: unknown) =>
  new SessionFolderError({
    message: cause instanceof Error ? cause.message : "Chat folder is unavailable",
    cause,
  });

const fileOperation = <A>(tryOperation: () => Promise<A>) =>
  Effect.tryPromise({ try: tryOperation, catch: folderError });

export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const host = yield* HostWorkspace;
  const core = yield* CoreModules;
  const projectsDirectory = () => host.projectlessRoot ?? resolveNodexProjectsDirectory(config);
  const cleanDeleted = (folders: readonly Folder[]) =>
    Effect.forEach(
      folders.filter(
        (folder) => folder.origin === "generated" && folder.execution_host_id === "local",
      ),
      (folder) =>
        fileOperation(() => removeEmptyChatDirectory(folder.path)).pipe(
          Effect.catch((error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return Effect.void;
            return Effect.logWarning("Empty Chat folder cleanup failed", error);
          }),
        ),
      { discard: true },
    );
  const bind = Effect.fn("SessionFolders.bind")(function* (sessionId: string, folder: Folder) {
    const applied = yield* core.workspace.apply({
      operationId: createOperationId("session-folder.bind"),
      intent: { kind: "bind_chat_folder", session_id: sessionId, folder },
    });
    const winner = applied.outcome.chat_folder;
    if (!winner) return yield* folderError(new Error("Core returned no Chat folder"));
    return winner;
  });

  const localFolder = (folder: Folder) =>
    folder.execution_host_id === "local"
      ? Effect.succeed(folder)
      : Effect.fail(folderError(new Error("This Chat folder is on another Host")));

  return SessionFolders.of({
    ensure: Effect.fn("SessionFolders.ensure")(
      function* (sessionId, options) {
        const read = yield* core.workspace.read({ kind: "session", session_id: sessionId });
        if (read.value.kind !== "session")
          return yield* folderError(new Error("Chat is unavailable"));
        const { folder, project_id, thread_id, execution_ref } = read.value.session;
        if (project_id) {
          const result = yield* core.workspace.read({ kind: "project", project_id });
          if (
            result.value.kind !== "project" ||
            result.value.project.sources.some((source) => source.kind === "directory")
          )
            return yield* folderError(new Error("This chat uses its Project folder"));
        }
        if (folder) return yield* localFolder(folder);

        // Older conversations already have an execution location. Their folders can be shared
        // by forks, so retain the location without claiming it as a new Session-owned allocation.
        if (thread_id) {
          const result = yield* core.workspace.read({ kind: "thread", thread_id });
          if (result.value.kind === "thread") {
            const thread = result.value.thread;
            if (thread.execution_host_id !== "local")
              return yield* folderError(new Error("This chat runs on another Host"));
            const projects = projectsDirectory();
            const legacy = options?.legacyWorkspace;
            const cwd = legacy?.cwd ?? thread.cwd ?? null;
            const browserRoot = legacy?.browserRoot ?? thread.projectless_workspace_browser_root;
            const existing = resolveExistingCodexProjectlessWorkspace({
              cwd,
              projectsDirectory: projects,
              retainedWritableRoots: legacy?.writableRoots ?? [],
              workspaceKind: "projectless",
              workspaceBrowserRoot: browserRoot,
            });
            if (
              existing &&
              existing.cwd !== projects &&
              (existing.cwd !== browserRoot || existing.cwd === cwd)
            )
              return {
                execution_host_id: "local",
                path: existing.cwd,
                output_directory: thread.projectless_output_directory ?? null,
                origin: "generated",
              } satisfies Folder;
          }
        }
        if (execution_ref && options?.readExecutionCwd) {
          const cwd = yield* options.readExecutionCwd(execution_ref.thread_id);
          if (cwd && path.isAbsolute(cwd)) {
            const generated =
              codexProjectlessWorkspaceRootFromCwd(cwd, projectsDirectory()) !== null;
            return {
              execution_host_id: "local",
              path: cwd,
              output_directory: generated ? null : cwd,
              origin: generated ? "generated" : "chosen",
            } satisfies Folder;
          }
        }
        const created = yield* fileOperation(() => {
          const projects = projectsDirectory();
          return createCodexProjectlessWorkspace({
            createSplitDirectories: true,
            prompt: options?.nameHint,
            workspaceRoot: host.projectlessRoot ? projects : path.join(projects, "Chats"),
            canonicalPaths: true,
          });
        });
        const candidate = {
          execution_host_id: "local",
          path: created.cwd,
          output_directory: created.outputDirectory,
          origin: "generated",
        } satisfies Folder;
        const winner = yield* bind(sessionId, candidate).pipe(
          Effect.tapError((error) =>
            error.cause instanceof CoreModuleResponseError &&
            ["not_found", "conflict", "invalid_input", "unauthorized"].includes(
              error.cause.coreError.code,
            )
              ? cleanDeleted([candidate])
              : Effect.void,
          ),
        );
        if (
          candidate.execution_host_id !== winner.execution_host_id ||
          candidate.path !== winner.path
        )
          yield* cleanDeleted([candidate]);
        return yield* localFolder(winner);
      },
      Effect.uninterruptible,
      Effect.mapError((cause) =>
        Schema.is(SessionFolderError)(cause) ? cause : folderError(cause),
      ),
    ),
    choose: Effect.fn("SessionFolders.choose")(
      function* (sessionId, absolutePath) {
        const directory = yield* fileOperation(() => resolveChosenChatDirectory(absolutePath));
        const winner = yield* bind(sessionId, {
          execution_host_id: "local",
          path: directory,
          output_directory: directory,
          origin: "chosen",
        });
        return yield* localFolder(winner);
      },
      Effect.mapError((cause) =>
        Schema.is(SessionFolderError)(cause) ? cause : folderError(cause),
      ),
    ),
    cleanDeleted,
  });
});

export const live = Layer.effect(SessionFolders, make);
