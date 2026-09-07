import { isAbsolute, relative } from "node:path";
import * as Effect from "effect/Effect";
import type { z } from "zod";
import type { sessionPresentationSchemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import type { WorkbenchRendererObservation } from "../../shared/nodex-app-tools/workbench";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import type { ProjectSession } from "../../shared/types";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { make as makeOpenTarget } from "./WorkbenchOpenTarget";

type Target = z.infer<typeof sessionPresentationSchemas.open_in_nodex>["target"];
type Opening = Pick<Extract<WorkbenchCommand, { kind: "open_surface" }>, "surface" | "reveal">;

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const open = yield* makeOpenTarget;
  const terminals = yield* TerminalSessions;
  const git = yield* GitWorkerRuntime;
  return Effect.fn("SessionPresentationTarget.resolve")(function* (input: {
    readonly target: Target;
    readonly session: ProjectSession;
    readonly observation: WorkbenchRendererObservation | null;
    readonly operationId: string;
    readonly authority: FrozenNodexAgentTurnAuthority;
    readonly callId: string;
    readonly taskAccess?: NodexAgentResourceAccessOverlay;
  }): Effect.fn.Return<Opening | { readonly existingTabId: string } | null> {
    const { target, session } = input;
    const sceneOwner = { kind: "session" as const, sessionId: session.id };
    if (target.kind === "file") {
      const surface = yield* open({
        ...input,
        sceneOwner,
        target: { kind: "files", path: target.path },
      });
      return surface
        ? {
            surface,
            ...(target.line ? { reveal: { kind: "file" as const, line: target.line } } : {}),
          }
        : null;
    }
    if (
      target.kind === "page" ||
      target.kind === "view" ||
      target.kind === "canvas" ||
      (target.kind === "browser" && target.url)
    ) {
      const surface = yield* open({
        ...input,
        sceneOwner,
        target: target.kind === "browser" ? { kind: "browser", url: target.url! } : target,
      });
      return surface ? { surface } : null;
    }
    if (target.kind === "browser") {
      const tab = input.observation?.tabs.find(
        (tab) =>
          tab.surface?.kind === "browser" && tab.surface.config.browserTabId === target.tabId,
      );
      return tab ? { existingTabId: tab.tabId } : null;
    }
    const thread = session.thread
      ? yield* workspace
          .getThread(session.thread.threadId)
          .pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    if (thread && thread.executionHostId !== "local") return null;
    const project = session.projectId
      ? yield* workspace
          .getProject(session.projectId)
          .pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    const cwd = thread?.cwd ?? project?.primaryWorkspaceRoot ?? null;
    if (target.kind === "terminal") {
      if (!cwd) return null;
      if (!target.terminalId) {
        const surface = yield* open({ ...input, sceneOwner, target: { kind: "terminal" } });
        return surface ? { surface } : null;
      }
      const owned = yield* terminals.listSnapshotsForOwners({
        projectSessionIds: new Set([session.id]),
        conversationIds: new Set(thread ? [thread.threadId] : []),
      });
      const observed = input.observation?.tabs.find(
        (tab) =>
          tab.surface?.kind === "terminal" &&
          tab.surface.config.terminalSessionId === target.terminalId &&
          tab.surface.config.context?.kind === "session" &&
          tab.surface.config.context.sessionId === session.id,
      );
      if (observed) return { existingTabId: observed.tabId };
      if (!observed && !owned.some((terminal) => terminal.sessionId === target.terminalId))
        return null;
      return {
        surface: {
          kind: "terminal",
          titleSnapshot: "Terminal",
          config: { terminalSessionId: target.terminalId, context: sceneOwner },
        },
      };
    }
    if (!thread) return null;
    const baseBranch = target.baseBranch;
    const view = target.view ?? (baseBranch ? "branch" : "last-turn");
    let reviewRoot = cwd;
    if (view !== "last-turn" || target.path) {
      if (!cwd) return null;
      const metadata = yield* git
        .request({ method: "stable-metadata", params: { cwd } })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!metadata?.isGitRepository || metadata.errorMessage) return null;
      reviewRoot = metadata.root ?? cwd;
      if (baseBranch) {
        const base = yield* git
          .request({ method: "merge-base", params: { cwd, baseBranch } })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!base?.mergeBaseSha || base.errorMessage) return null;
      }
    }
    const path =
      target.path && isAbsolute(target.path) && reviewRoot
        ? relative(reviewRoot, target.path)
        : target.path;
    if (path && (path === ".." || path.startsWith("../") || isAbsolute(path))) return null;
    return {
      surface: {
        kind: "review",
        titleSnapshot: "Review",
        config: { projectId: session.projectId },
      },
      reveal: {
        kind: "review",
        threadId: thread.threadId,
        view,
        ...(baseBranch ? { baseBranch } : {}),
        ...(path ? { path } : {}),
      },
    };
  });
});
