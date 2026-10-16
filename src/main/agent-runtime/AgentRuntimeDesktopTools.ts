import * as Effect from "effect/Effect";
import { CODEX_DESKTOP_THREAD_FEATURE_CONFIG } from "../codex/codex-thread-config";
import type { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import type { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import type { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import type { WindowRuntime } from "../window-runtime/WindowRuntime";

/** A root Codex Turn of Agent execution; a starting Turn belongs to an authorized Run. */
export type AgentRuntimeNativeTurn = {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
} & (
  | {
      readonly phase: "started";
      readonly threadId: string;
      readonly runId: string;
      readonly sessionId: string;
      readonly projectId: string | null;
    }
  | { readonly phase: "ended" }
);

export interface AgentRuntimeDesktopTools {
  readonly threadConfig: (
    cwd: string | null,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, unknown>;
  readonly observeNativeTurn: (turn: AgentRuntimeNativeTurn) => Effect.Effect<void>;
  /** An archived or deleted Session gives up the Browser pages its Agents opened. */
  readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
}

/**
 * Codex threads under Agent execution get the Desktop features and tools of the app, and the
 * in-app Browser follows each Turn to the window that submitted it. The Browser addresses a
 * conversation by its Codex thread, so routes are kept per Nodex Session for release.
 */
export const make = (ports: {
  readonly tools: Pick<DesktopToolRuntime["Service"], "threadConfig">;
  readonly browserUse: Pick<
    BrowserUseRuntime["Service"],
    "captureRoute" | "turnStarted" | "turnEnded" | "endSessionActivity" | "releaseSession"
  >;
  readonly windows: Pick<WindowRuntime["Service"], "snapshot">;
  readonly presentation: Pick<CodexTurnPresentation["Service"], "read">;
}): AgentRuntimeDesktopTools => {
  const routed = new Map<string, Set<string>>();
  const warn = (message: string, turn: { readonly nativeThreadId: string }) =>
    Effect.catchCause((cause) =>
      Effect.logWarning(message, { nativeThreadId: turn.nativeThreadId, cause }),
    );
  const ownerOf = (windowSessionId: string) =>
    ports.windows
      .snapshot()
      .windows.find(
        (window) => window.kind === "primary" && window.windowSessionId === windowSessionId,
      )?.webContentsId;

  return {
    threadConfig: (cwd) =>
      ports.tools
        .threadConfig(cwd)
        .pipe(Effect.map((tools) => ({ ...CODEX_DESKTOP_THREAD_FEATURE_CONFIG, ...tools }))),
    observeNativeTurn: (turn) => {
      const browserTurn = { sessionId: turn.nativeThreadId, turnId: turn.nativeTurnId };
      if (turn.phase === "ended")
        return ports.browserUse
          .turnEnded(browserTurn)
          .pipe(
            Effect.andThen(ports.browserUse.endSessionActivity(turn.nativeThreadId)),
            warn("Browser could not end an Agent Turn", turn),
          );
      return Effect.gen(function* () {
        // A Turn nobody submitted from a window keeps the route its conversation already has.
        const anchor = ports.presentation.read(turn.threadId, turn.runId);
        const owner = anchor ? ownerOf(anchor.windowSessionId) : undefined;
        if (anchor && owner !== undefined) {
          yield* ports.browserUse.captureRoute({
            browserConversationId: turn.sessionId,
            browserViewScopeId: anchor.windowSessionId,
            codexSessionId: turn.nativeThreadId,
            ownerWebContentsId: owner,
            projectId: turn.projectId,
          });
          const threads = routed.get(turn.sessionId) ?? new Set<string>();
          routed.set(turn.sessionId, threads.add(turn.nativeThreadId));
        }
        yield* ports.browserUse.turnStarted(browserTurn);
      }).pipe(warn("Browser could not follow an Agent Turn", turn));
    },
    releaseSession: (sessionId) =>
      Effect.suspend(() => {
        const threads = [...(routed.get(sessionId) ?? [])];
        routed.delete(sessionId);
        return Effect.forEach(
          threads,
          (nativeThreadId) =>
            ports.browserUse
              .releaseSession(nativeThreadId)
              .pipe(warn("Browser could not release an Agent conversation", { nativeThreadId })),
          { discard: true },
        );
      }),
  };
};
