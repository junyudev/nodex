import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentWindowsSandboxState } from "@nodex/agent-runtime/contracts";
import type { WindowsSandboxSetupMode } from "@nodex/codex-app-server-protocol/v2";
import type { ComposerNotice, ComposerNoticeAction } from "./thread-stage-types";

type ProviderReadiness = Pick<
  AgentRuntimeOperations["providers.read"]["output"][number],
  | "instanceId"
  | "enabled"
  | "installed"
  | "status"
  | "auth"
  | "message"
  | "availability"
  | "unavailableReason"
>;

/**
 * What keeps the selected Agent from taking a message, read from its checked state rather than
 * from the wording of its message. Warnings that leave the Agent usable, such as a status that
 * has not been checked yet or a newer version being available, are not problems here; provider
 * settings show them.
 */
export type AgentReadinessProblem = "turned-off" | "signed-out" | "not-installed" | "not-ready";

export function agentReadinessProblem(
  provider: ProviderReadiness | undefined,
): AgentReadinessProblem | null {
  if (!provider) return null;
  if (provider.availability === "unavailable") return "not-ready";
  if (!provider.enabled || provider.status === "disabled") return "turned-off";
  if (provider.auth.status === "unauthenticated") return "signed-out";
  if (provider.status !== "error") return null;
  // An error status means the Agent was checked, so `installed: false` is a real absence here.
  return provider.installed ? "not-ready" : "not-installed";
}

/** How the person can fix the selected Agent from the composer. */
export interface AgentReadinessFixes {
  /** Signs in from Nodex; without it, signing in happens in the Agent's settings or terminal. */
  readonly signIn?: () => Promise<void>;
  readonly openSettings?: () => void;
  /** Checks the Agent again, settling once its new state is known. */
  readonly checkAgain: () => Promise<void>;
}

/** The notice for the selected Agent, or null when it can take a message. */
export function agentReadinessNotice(
  label: string,
  provider: ProviderReadiness | undefined,
  fixes: AgentReadinessFixes,
): ComposerNotice | null {
  const problem = agentReadinessProblem(provider);
  if (!provider || !problem) return null;
  const settings: ComposerNoticeAction[] = fixes.openSettings
    ? [{ label: "Settings", run: fixes.openSettings }]
    : [];
  const checkAgain: ComposerNoticeAction = {
    label: "Check again",
    pendingLabel: "Checking…",
    run: fixes.checkAgain,
  };
  const key = `agent:${provider.instanceId}:${problem}`;
  const detail =
    (provider.availability === "unavailable" ? provider.unavailableReason : null) ??
    provider.message ??
    null;
  switch (problem) {
    case "turned-off":
      return { key, tone: "warning", title: `${label} is turned off`, actions: settings };
    case "signed-out":
      return {
        key,
        tone: "warning",
        title: `${label} isn’t signed in`,
        // Signing in from Nodex is the fix; otherwise the Agent's message names the command.
        detail: fixes.signIn ? null : detail,
        actions: fixes.signIn
          ? [{ label: "Sign in", pendingLabel: "Opening…", run: fixes.signIn }, checkAgain]
          : [...settings, checkAgain],
      };
    case "not-installed":
      return {
        key,
        tone: "warning",
        title: `${label} isn’t installed`,
        detail,
        actions: [...settings, checkAgain],
      };
    case "not-ready":
      return {
        key,
        tone: "danger",
        title: `${label} isn’t ready`,
        detail,
        actions: [checkAgain, ...settings],
      };
  }
}

/** A new chat with no usable Agent at all: connecting one is the only way forward. */
export const connectAgentNotice = (connect: () => void): ComposerNotice => ({
  key: "agent:none",
  tone: "warning",
  title: "Connect an agent to start",
  actions: [{ label: "Connect", run: connect }],
});

/**
 * The model picker's setup row for an Agent the person turned on but cannot use yet: the quiet
 * place that explains why its models are missing. A turned-off Agent gets none.
 */
export function agentReadinessSetupHint(
  provider: ProviderReadiness | undefined,
): { readonly hint: string; readonly tone: "default" | "danger" } | null {
  switch (agentReadinessProblem(provider)) {
    case "signed-out":
      return { hint: "Sign in", tone: "default" };
    case "not-installed":
      return { hint: "Install", tone: "default" };
    case "not-ready":
      return { hint: "Unavailable", tone: "danger" };
    default:
      return null;
  }
}

/** Windows setup uses the same quiet Agent problem rail as installation and sign-in. */
export function windowsSandboxReadinessNotice(
  state: AgentWindowsSandboxState | undefined,
  fixes: {
    readonly checkAgain: () => Promise<void>;
    readonly setup: (mode: WindowsSandboxSetupMode) => Promise<void>;
    readonly cancel: (generation: string) => Promise<void>;
  },
  checkFailed = false,
): ComposerNotice | null {
  if (!checkFailed && (state?.status === "notApplicable" || state?.status === "ready")) return null;
  const key = `windows-sandbox:${state?.generation ?? 0}:${state?.status ?? "checking"}`;
  const check: ComposerNoticeAction = { label: "Check again", run: fixes.checkAgain };
  if (checkFailed || state?.failure === "checkFailed") {
    return { key, tone: "danger", title: "Couldn’t check Codex’s Windows setup", actions: [check] };
  }
  if (!state || state.status === "checking") {
    return { key, tone: "warning", title: "Checking Codex’s Windows setup…" };
  }
  if (state.status === "settingUp") {
    return {
      key,
      tone: "warning",
      title: "Setting up Codex for Windows…",
      actions: [{ label: "Cancel", run: () => fixes.cancel(state.generation) }],
    };
  }
  const titles = {
    cancelled: "Windows setup was canceled",
    timeout: "Windows setup timed out",
    setupFailed: "Codex’s Windows setup didn’t finish",
    checkFailed: "Couldn’t check Codex’s Windows setup",
  };
  return {
    key,
    tone: state.failure ? "danger" : "warning",
    title: state.failure
      ? titles[state.failure]
      : state.status === "updateRequired"
        ? "Codex’s Windows setup needs an update"
        : "Codex needs a one-time Windows setup to run safely",
    actions: windowsSandboxSetupActions(state, fixes.setup, check),
  };
}

// Setup asks for administrator approval when allowed; working without it is an explicit fallback.
function windowsSandboxSetupActions(
  state: AgentWindowsSandboxState,
  setup: (mode: WindowsSandboxSetupMode) => Promise<void>,
  check: ComposerNoticeAction,
): ComposerNoticeAction[] {
  const preferred = state.allowedModes.includes("elevated") ? "elevated" : state.allowedModes[0];
  if (!preferred) return [check];
  const primary = { label: state.failure ? "Try again" : "Set up", run: () => setup(preferred) };
  const fallback =
    state.failure && preferred === "elevated" && state.allowedModes.includes("unelevated")
      ? [{ label: "Set up without admin", run: () => setup("unelevated") }]
      : [];
  return [primary, ...fallback];
}
