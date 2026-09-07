import { createHash } from "node:crypto";
import { basename } from "node:path";
import * as Effect from "effect/Effect";
import type { z } from "zod";
import {
  nodexAgentAuthorityFingerprint,
  type FrozenNodexAgentTurnAuthority,
} from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import type { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WorkbenchContentAccess, type WorkbenchContentSurface } from "./WorkbenchContentAccess";
import { resolveWorkbenchFileTarget } from "../platform/node/WorkbenchFileTarget";

type OpenSurface = Extract<WorkbenchCommand, { kind: "open_tab" }>["surface"];
type OpenTarget = z.infer<typeof workbenchControlSchemas.open_tab>["target"];
export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const content = yield* WorkbenchContentAccess;
  return Effect.fn("WorkbenchOpenTarget.resolve")(function* (input: {
    readonly target: OpenTarget;
    readonly sceneOwner: WorkbenchSceneOwner;
    readonly operationId: string;
    readonly authority: FrozenNodexAgentTurnAuthority;
    readonly callId: string;
    readonly taskAccess?: NodexAgentResourceAccessOverlay;
  }): Effect.fn.Return<OpenSurface | null> {
    const { target, sceneOwner, authority } = input;
    const session =
      sceneOwner.kind === "session"
        ? yield* workspace
            .getProjectSession(sceneOwner.sessionId)
            .pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
    if (sceneOwner.kind === "session" && !session) return null;
    const projectId =
      sceneOwner.kind === "project" ? sceneOwner.projectId : (session?.projectId ?? null);
    if (
      sceneOwner.kind !== "pages" &&
      authority.scope !== "library" &&
      projectId !== authority.actorProjectId
    )
      return null;
    const accessContext =
      sceneOwner.kind === "pages" || projectId === null
        ? { kind: "library" as const }
        : { kind: "project" as const, projectId };
    if (target.kind === "page" || target.kind === "view" || target.kind === "canvas") {
      const surface: WorkbenchContentSurface =
        target.kind === "page"
          ? {
              id: "pending",
              titleSnapshot: "",
              kind: "page_stage",
              config: { accessContext, pageId: target.pageId },
            }
          : target.kind === "canvas"
            ? {
                id: "pending",
                titleSnapshot: "",
                kind: "canvas_stage",
                config: { accessContext, canvasBlockId: target.canvasId },
              }
            : {
                id: "pending",
                titleSnapshot: "",
                kind: "db_view",
                config: {
                  accessContext,
                  target: { kind: "database-view", databaseViewId: target.viewId },
                },
              };
      const description = yield* content.describe({
        authority,
        surface,
        callId: input.callId,
        taskAccess: input.taskAccess,
      });
      if (description.status !== "authorized") return null;
      if (surface.kind === "page_stage")
        return {
          kind: surface.kind,
          config: surface.config,
          titleSnapshot: description.title.slice(0, 2_000),
        };
      if (surface.kind === "canvas_stage")
        return {
          kind: surface.kind,
          config: surface.config,
          titleSnapshot: description.title.slice(0, 2_000),
        };
      return {
        kind: surface.kind,
        config: surface.config,
        titleSnapshot: description.title.slice(0, 2_000),
      };
    }
    if (sceneOwner.kind === "pages") return null;
    const runtimeId = createHash("sha256")
      .update(
        JSON.stringify([nodexAgentAuthorityFingerprint(authority), sceneOwner, input.operationId]),
      )
      .digest("hex");
    if (target.kind === "browser")
      return {
        kind: "browser",
        titleSnapshot: "Browser",
        config: {
          url: target.url,
          browserTabId: `browser:${runtimeId}`,
          browserStorageId: `browser:scene:browser:${runtimeId}`,
        },
      };
    if (target.kind === "terminal")
      return {
        kind: "terminal",
        titleSnapshot: "Terminal",
        config: { terminalSessionId: `terminal:${runtimeId}`, context: sceneOwner },
      };
    if (target.kind === "review") {
      if (sceneOwner.kind !== "session" || !session?.thread) return null;
      return { kind: "review", titleSnapshot: "Review", config: { projectId } };
    }
    const project = projectId
      ? yield* workspace.getProject(projectId).pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    const thread = session?.thread
      ? yield* workspace
          .getThread(session.thread.threadId)
          .pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    if (thread && thread.executionHostId !== "local") return null;
    const root = thread?.cwd ?? project?.primaryWorkspaceRoot ?? null;
    const requestedPath = target.path;
    const file = requestedPath
      ? yield* Effect.tryPromise(() =>
          resolveWorkbenchFileTarget({
            path: requestedPath,
            cwd: root,
            roots: [
              ...(root ? [root] : []),
              ...(project?.sources.map((source) => source.root) ?? []),
            ],
            fullAccess: authority.scope === "library",
          }),
        ).pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    if ((target.path && !file) || (!target.path && !root)) return null;
    return {
      kind: "files",
      titleSnapshot: file ? basename(file.path) : "Files",
      config: {
        projectId,
        hostId: "local",
        workspaceRoot: file?.workspaceRoot ?? root,
        cwd: root,
        ...(file ? { path: file.path } : {}),
      },
    };
  });
});
