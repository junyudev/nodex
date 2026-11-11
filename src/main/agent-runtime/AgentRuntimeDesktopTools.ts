import type { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import type { HostDesktopTools } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { CODEX_DESKTOP_THREAD_FEATURE_CONFIG } from "../codex/codex-thread-config";
import type { CodexTurnPresentation } from "../../host/TurnPresentation";
import type { ComputerUseRuntime } from "../host-runtime/ComputerUseRuntime";
import type { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import type { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import type { WindowRuntime } from "../window-runtime/WindowRuntime";

/** A Desktop Tool turn of Agent execution. A starting Turn belongs to an authorized Run. */
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
  readonly pip?: Pick<
    RemoteHostedPipRuntime["Service"],
    "observeRuntimeActivity" | "retireRuntimeLease" | "retireTasks"
  >;
  readonly desktopTools: Effect.Effect<HostDesktopTools | null, unknown>;
  readonly threadConfig: (
    cwd: string | null,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, unknown>;
  readonly observeNativeTurn: (turn: AgentRuntimeNativeTurn) => Effect.Effect<void>;
  /** An archived or deleted Session gives up the Browser pages its Agents opened. */
  readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
}

/**
 * Agent threads get the Desktop tools of the app, and the in-app Browser follows each native
 * Turn to the window that submitted it. Native execution ids are opaque to Browser routing;
 * routes are kept per Nodex Session for release.
 */
export const make = (ports: {
  readonly pip?: AgentRuntimeDesktopTools["pip"];
  readonly computerUse?: ComputerUseRuntime["Service"]["windows"];
  readonly tools: Pick<DesktopToolRuntime["Service"], "threadConfig" | "desktopTools">;
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
    pip: ports.pip,
    desktopTools: ports.tools.desktopTools,
    threadConfig: (cwd) =>
      ports.tools
        .threadConfig(cwd)
        .pipe(Effect.map((tools) => ({ ...CODEX_DESKTOP_THREAD_FEATURE_CONFIG, ...tools }))),
    observeNativeTurn: (turn) => {
      const computerUse = ports.computerUse?.observeTurn(turn) ?? Effect.void;
      const browserTurn = { sessionId: turn.nativeThreadId, turnId: turn.nativeTurnId };
      if (turn.phase === "ended")
        return Effect.all(
          [
            computerUse,
            ports.browserUse
              .turnEnded(browserTurn)
              .pipe(
                Effect.andThen(ports.browserUse.endSessionActivity(turn.nativeThreadId)),
                warn("Browser could not end an Agent Turn", turn),
              ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      return Effect.gen(function* () {
        yield* computerUse;
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
          const nativeThreads = routed.get(turn.sessionId) ?? new Set<string>();
          routed.set(turn.sessionId, nativeThreads.add(turn.nativeThreadId));
        }
        yield* ports.browserUse.turnStarted(browserTurn);
      }).pipe(warn("Browser could not follow an Agent Turn", turn));
    },
    releaseSession: (sessionId) =>
      Effect.suspend(() => {
        const nativeThreads = [...(routed.get(sessionId) ?? [])];
        routed.delete(sessionId);
        return Effect.forEach(
          nativeThreads,
          (nativeThreadId) =>
            ports.browserUse
              .releaseSession(nativeThreadId)
              .pipe(warn("Browser could not release an Agent conversation", { nativeThreadId })),
          { discard: true },
        ).pipe(Effect.ensuring(ports.computerUse?.releaseSession(sessionId) ?? Effect.void));
      }),
  };
};
