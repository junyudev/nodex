import type { ApplicationSettings } from "../settings/ApplicationSettings";
import type { MainConfig } from "../app/MainConfig";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isCodexNonGitRepositoryMessage, runCodexGitCommand } from "../codex/codex-git-command";
import { loadCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import {
  live as shellEnvironmentLive,
  WorktreeShellEnvironmentRuntime,
} from "../host-runtime/WorktreeShellEnvironmentRuntime";
import * as TerminalEnvironment from "../platform/node/TerminalEnvironment";
import * as TerminalProcessMetrics from "../platform/node/TerminalProcessMetrics";
import * as TerminalPty from "../platform/node/TerminalPty";
import * as TerminalRuntimeMap from "./TerminalRuntimeMap";
import * as TerminalSessions from "./TerminalSessions";

export const layer = TerminalSessions.live.pipe(Layer.provideMerge(TerminalRuntimeMap.live));

const environment = TerminalEnvironment.live({
  login: (baseEnvironment, platform) =>
    Effect.gen(function* () {
      // The probe's child Scope also closes when discovery reaches its deadline.
      const context = yield* Layer.build(
        shellEnvironmentLive({
          baseEnvironment,
          platform,
          onError: (error) => {
            throw error;
          },
        }),
      );
      return yield* Context.get(context, WorktreeShellEnvironmentRuntime).load;
    }).pipe(Effect.scoped),
  worktree: (cwd, env) =>
    Effect.tryPromise({
      try: async (signal) => {
        const gitPath = await runCodexGitCommand(
          ["rev-parse", "--git-path", "codex-shell-environment.json"],
          cwd,
          { env, signal, timeoutMs: 8_000, maxOutputBytes: 256 * 1_024 },
        ).then(
          ({ stdout }) => stdout.trim(),
          (error: unknown) => {
            if (isCodexNonGitRepositoryMessage(String(error))) return null;
            throw error;
          },
        );
        return gitPath ? loadCodexWorktreeShellEnvironmentAtGitPath({ cwd, gitPath }) : null;
      },
      catch: (error) => error,
    }),
});

/**
 * Complete process-scoped Terminal graph. ACP client callbacks and desktop Terminal sessions share
 * one RuntimeMap, so a child process cannot outlive the same process-scoped owner used by the UI.
 */
export const live: Layer.Layer<
  TerminalSessions.TerminalSessions | TerminalRuntimeMap.TerminalRuntimeMap,
  never,
  MainConfig | ApplicationSettings
> = layer.pipe(
  Layer.provide(Layer.mergeAll(environment, TerminalProcessMetrics.live, TerminalPty.live)),
);
