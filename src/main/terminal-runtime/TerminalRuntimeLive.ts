import type { ApplicationSettings } from "../settings/ApplicationSettings";
import { MainConfig } from "../app/MainConfig";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isCodexNonGitRepositoryMessage, runCodexGitCommand } from "../codex/codex-git-command";
import { loadCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import { HostShellEnvironment } from "../host-runtime/HostShellEnvironment";
import * as TerminalEnvironment from "../platform/node/TerminalEnvironment";
import * as TerminalProcessMetrics from "../platform/node/TerminalProcessMetrics";
import * as TerminalPty from "../platform/node/TerminalPty";
import * as TerminalRuntimeMap from "./TerminalRuntimeMap";
import * as TerminalSessions from "./TerminalSessions";

export const layer = TerminalSessions.live.pipe(Layer.provideMerge(TerminalRuntimeMap.live));

const environment = TerminalEnvironment.live({
  login: (baseEnvironment) =>
    Effect.gen(function* () {
      const shell = yield* HostShellEnvironment;
      const outcome = yield* shell.recover;
      if (outcome.status === "failed") return baseEnvironment;
      // Do not reintroduce values inherited from the app's launcher and removed by Terminal.
      const { environment } = yield* MainConfig;
      return Object.fromEntries(
        Object.entries(outcome.environment).filter(
          ([name, value]) => name in baseEnvironment || value !== environment[name],
        ),
      );
    }),
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
  MainConfig | ApplicationSettings | HostShellEnvironment
> = layer.pipe(
  Layer.provide(Layer.mergeAll(environment, TerminalProcessMetrics.live, TerminalPty.live)),
);
