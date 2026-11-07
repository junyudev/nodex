import { basename, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { z } from "zod";
import { isSameBrowserDocument, shouldOpenLinkInBrowser } from "../../shared/browser-url-policy";
import { buildFileUrl } from "../../shared/file-link-openers";
import type { sessionPresentationSchemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import type {
  WorkbenchRendererObservation,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { ProjectSession } from "../../shared/types";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { make as makeOpenTarget } from "./WorkbenchOpenTarget";

type Target = z.infer<typeof sessionPresentationSchemas.open_in_nodex>["target"];
type Opening = Pick<Extract<WorkbenchCommand, { kind: "open_surface" }>, "surface" | "reveal">;
interface ExistingTab {
  readonly existingTabId: string;
  readonly surface: "browser" | "terminal";
  readonly url?: string;
  /** Shows the file's current content in the activated tab; false when it could not. */
  readonly reload?: Effect.Effect<boolean>;
}
export type SessionPresentationOpening = Opening | ExistingTab;

/** Node refuses some URLs a browser accepts, such as an encoded path separator. */
const readFileUrlPath = (url: URL): string | null => {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
};

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const open = yield* makeOpenTarget;
  const terminals = yield* TerminalSessions;
  const git = yield* GitWorkerRuntime;
  const runtime = yield* Effect.serviceOption(AgentRuntimeApplication);
  const browser = yield* Effect.serviceOption(BrowserApplication);
  return Effect.fn("SessionPresentationTarget.resolve")(function* (input: {
    readonly target: Target;
    readonly session: ProjectSession;
    readonly observation: WorkbenchRendererObservation | null;
    readonly window: WorkbenchWindowReference;
    readonly operationId: string;
    readonly authority: NodexAgentTurnContext;
    readonly callId: string;
  }): Effect.fn.Return<SessionPresentationOpening | null> {
    const { target, session } = input;
    const sceneOwner = { kind: "session" as const, sessionId: session.id };
    const resolveFile = (path: string) =>
      open({ ...input, sceneOwner, target: { kind: "files", path } });
    /** A local document keeps one tab per Session: opening it again reloads that tab. */
    const showLocalDocument = Effect.fn("SessionPresentationTarget.showLocalDocument")(function* (
      path: string,
      url: string,
    ): Effect.fn.Return<SessionPresentationOpening | null> {
      const opened = yield* open({ ...input, sceneOwner, target: { kind: "browser", url } });
      if (opened?.kind !== "browser") return null;
      const opening = { surface: { ...opened, titleSnapshot: basename(path) } };
      const observedTabs = input.observation?.tabs ?? [];
      // An exact retry finds the tab its own operation made and must repeat the same command.
      const isRetry = observedTabs.some(
        (tab) =>
          tab.surface?.kind === "browser" &&
          tab.surface.config.browserTabId === opened.config.browserTabId,
      );
      if (!isRetry && Option.isSome(browser)) {
        const { projection, applyCommand } = browser.value;
        for (const tab of observedTabs) {
          if (tab.surface?.kind !== "browser") continue;
          const identity = {
            browserConversationId: session.id,
            browserViewScopeId: input.window.windowSessionId,
            browserTabId: tab.surface.config.browserTabId,
          };
          const snapshot = projection.getTab(identity);
          if (!snapshot || !isSameBrowserDocument(snapshot.pendingUrl ?? snapshot.url, url))
            continue;
          return {
            existingTabId: tab.tabId,
            surface: "browser",
            url,
            reload: applyCommand({ type: "navigate", ...identity, url }).pipe(
              Effect.map((result) => result.ok),
              Effect.catch(() => Effect.succeed(false)),
            ),
          };
        }
      }
      return opening;
    });
    if (target.kind === "file") {
      const surface = yield* resolveFile(target.path);
      if (!surface) return null;
      const path = surface.kind === "files" ? surface.config.path : undefined;
      // A Session Scene can always host a Browser surface, and resolving the file proved it local.
      if (
        path &&
        shouldOpenLinkInBrowser({
          browserAvailable: true,
          link: { type: "file", path, location: target.line },
        })
      )
        return yield* showLocalDocument(path, buildFileUrl({ path }));
      return {
        surface,
        ...(target.line ? { reveal: { kind: "file" as const, line: target.line } } : {}),
      };
    }
    const browserUrl = target.kind === "browser" && target.url ? new URL(target.url) : null;
    if (browserUrl?.protocol === "file:") {
      const requestedPath = readFileUrlPath(browserUrl);
      const surface = requestedPath ? yield* resolveFile(requestedPath) : null;
      const path = surface?.kind === "files" ? surface.config.path : undefined;
      if (!path) return null;
      return yield* showLocalDocument(
        path,
        `${buildFileUrl({ path })}${browserUrl.search}${browserUrl.hash}`,
      );
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
      return tab ? { existingTabId: tab.tabId, surface: "browser" } : null;
    }
    const execution =
      session.executionRef && Option.isSome(runtime)
        ? yield* runtime.value
            .inspect({ sessionId: session.id })
            .pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
    if (session.executionRef && !execution) return null;
    const thread =
      !session.executionRef && session.thread
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
    const cwd =
      execution?.thread.worktreePath ?? thread?.cwd ?? project?.primaryWorkspaceRoot ?? null;
    const threadId = execution?.threadId ?? thread?.threadId ?? null;
    if (target.kind === "terminal") {
      if (!cwd) return null;
      if (!target.terminalId) {
        const surface = yield* open({ ...input, sceneOwner, target: { kind: "terminal" } });
        return surface ? { surface } : null;
      }
      const owned = yield* terminals.listSnapshotsForOwners({
        projectSessionIds: new Set([session.id]),
        conversationIds: new Set(threadId ? [threadId] : []),
      });
      const observed = input.observation?.tabs.find(
        (tab) =>
          tab.surface?.kind === "terminal" &&
          tab.surface.config.terminalSessionId === target.terminalId &&
          tab.surface.config.context?.kind === "session" &&
          tab.surface.config.context.sessionId === session.id,
      );
      if (observed) return { existingTabId: observed.tabId, surface: "terminal" };
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
    if (!threadId) return null;
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
        ? relative(reviewRoot, target.path).split(sep).join("/")
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
        threadId,
        view,
        ...(baseBranch ? { baseBranch } : {}),
        ...(path ? { path } : {}),
      },
    };
  });
});
