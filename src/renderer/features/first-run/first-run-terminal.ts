import { claudeAgent } from "../../../shared/agents/claude";
import { readAgentProfiles } from "@/lib/agent-profiles-runtime";
import { resolveCodexRendererOs } from "@/lib/codex-window-runtime";
import { terminalSessionStore } from "@/lib/terminal-session-store";
import { claudeInstallCommand, claudeSignInCommand } from "./agent-sign-in-commands";

const isWindows = () => resolveCodexRendererOs() === "win32";

const claudeInstallPreview = (): string => claudeInstallCommand(isWindows());

/** Signs in the first enabled profile, in the directory and with the executable it uses. */
async function resolveClaudeSignInCommand(): Promise<string> {
  const { instances } = await readAgentProfiles(claudeAgent.driver);
  const profile = instances.find((instance) => instance.enabled) ?? instances[0];
  return claudeSignInCommand({
    binaryPath: profile?.binaryPath ?? "claude",
    configDirectory: profile?.settings.configDirectory ?? "",
    windows: isWindows(),
  });
}

/** Terminal commands stay with the owner that knows the Agent's executable and profile. */
export function firstRunTerminalSetup(owner: string | undefined) {
  if (owner !== claudeAgent.setup.signIn.owner) return undefined;
  return { previewInstall: claudeInstallPreview, signInCommand: resolveClaudeSignInCommand };
}

/**
 * Runs one setup command in its own Terminal until it exits. Starting a tick later means a remount
 * during development can't open the browser twice.
 */
export function runSetupTerminal(input: {
  readonly terminalId: string;
  readonly title: string;
  readonly command: string;
  readonly onExit: (exitCode: number | null) => void;
}): () => void {
  let started = false;
  const timer = window.setTimeout(() => {
    started = true;
    void terminalSessionStore.runAction({
      sessionId: input.terminalId,
      command: input.command,
      cwd: null,
      title: input.title,
    });
  }, 0);
  const stop = terminalSessionStore.subscribeExit((event) => {
    if (event.sessionId === input.terminalId) input.onExit(event.exitCode);
  });
  return () => {
    window.clearTimeout(timer);
    stop();
    if (started) terminalSessionStore.kill(input.terminalId);
  };
}
