import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
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
  | "issue"
  | "checkPending"
>;

/**
 * An Agent whose first check hasn't answered yet. Its placeholder asserts nothing about what is
 * installed or who is signed in, so a surface that states either waits for the answer.
 */
export const isAgentUnchecked = (provider: ProviderReadiness | undefined): boolean =>
  provider?.checkPending === true;

/**
 * What keeps the selected Agent from taking a message, read from its checked state rather than
 * from the wording of its message. Warnings that leave the Agent usable, such as a newer version
 * being available, are not problems here; provider settings show them.
 *
 * `no-connection` is an Agent that is signed in on this computer and couldn't reach its account,
 * and `not-responding` one that started and didn't answer in time: both usually pass, so they are
 * told apart from an Agent that failed.
 */
export type AgentReadinessProblem =
  | "turned-off"
  | "signed-out"
  | "not-installed"
  | "no-connection"
  | "not-responding"
  | "not-ready";

export function agentReadinessProblem(
  provider: ProviderReadiness | undefined,
): AgentReadinessProblem | null {
  if (!provider) return null;
  if (provider.availability === "unavailable") return "not-ready";
  if (!provider.enabled || provider.status === "disabled") return "turned-off";
  if (provider.auth.status === "unauthenticated") return "signed-out";
  if (provider.status !== "error") return null;
  if (provider.issue === "account-unavailable") return "no-connection";
  if (provider.issue === "unresponsive") return "not-responding";
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
  intl: IntlShape = getIntl(),
): ComposerNotice | null {
  const problem = agentReadinessProblem(provider);
  if (!provider || !problem) return null;
  const settings: ComposerNoticeAction[] = fixes.openSettings
    ? [
        {
          label: intl.formatMessage({
            id: "conversation.agentReadinessNotice.settings",
            defaultMessage: "Settings",
          }),
          run: fixes.openSettings,
        },
      ]
    : [];
  const checkAgain: ComposerNoticeAction = {
    label: intl.formatMessage({
      id: "conversation.agentReadinessNotice.checkAgain",
      defaultMessage: "Check again",
    }),
    pendingLabel: intl.formatMessage({
      id: "conversation.agentReadinessNotice.checking",
      defaultMessage: "Checking…",
    }),
    run: fixes.checkAgain,
  };
  const key = `agent:${provider.instanceId}:${problem}`;
  const detail =
    (provider.availability === "unavailable" ? provider.unavailableReason : null) ??
    provider.message ??
    null;
  switch (problem) {
    case "turned-off":
      return {
        key,
        tone: "warning",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentOff",
            defaultMessage: "{label} is turned off",
          },
          { label },
        ),
        actions: settings,
      };
    case "signed-out":
      return {
        key,
        tone: "warning",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentSignedOut",
            defaultMessage: "{label} isn’t signed in",
          },
          { label },
        ),
        // Signing in from Nodex is the fix; otherwise the Agent's message names the command.
        detail: fixes.signIn ? null : detail,
        actions: fixes.signIn
          ? [
              {
                label: intl.formatMessage({
                  id: "conversation.agentReadinessNotice.signIn",
                  defaultMessage: "Sign in",
                }),
                pendingLabel: intl.formatMessage({
                  id: "conversation.agentReadinessNotice.opening",
                  defaultMessage: "Opening…",
                }),
                run: fixes.signIn,
              },
              checkAgain,
            ]
          : [...settings, checkAgain],
      };
    case "not-installed":
      return {
        key,
        tone: "warning",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentNotInstalled",
            defaultMessage: "{label} isn’t installed",
          },
          { label },
        ),
        detail,
        actions: [...settings, checkAgain],
      };
    case "no-connection":
      return {
        key,
        tone: "warning",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentNoConnection",
            defaultMessage: "{label} is signed in but can’t connect",
          },
          { label },
        ),
        detail:
          detail ??
          intl.formatMessage({
            id: "conversation.agentReadinessNotice.checkNetworkOrProxy",
            defaultMessage: "Check your network connection or proxy.",
          }),
        actions: [checkAgain, ...settings],
      };
    case "not-responding":
      return {
        key,
        tone: "warning",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentNotResponding",
            defaultMessage: "{label} didn’t respond in time",
          },
          { label },
        ),
        detail,
        actions: [checkAgain, ...settings],
      };
    case "not-ready":
      return {
        key,
        tone: "danger",
        title: intl.formatMessage(
          {
            id: "conversation.agentReadinessNotice.agentNotReady",
            defaultMessage: "{label} isn’t ready",
          },
          { label },
        ),
        detail,
        actions: [checkAgain, ...settings],
      };
  }
}

/** A new chat with no usable Agent at all: connecting one is the only way forward. */
export const connectAgentNotice = (
  connect: () => void,
  intl: IntlShape = getIntl(),
): ComposerNotice => ({
  key: "agent:none",
  tone: "warning",
  title: intl.formatMessage({
    id: "conversation.agentReadinessNotice.connectToStart",
    defaultMessage: "Connect an agent to start",
  }),
  actions: [
    {
      label: intl.formatMessage({
        id: "conversation.agentReadinessNotice.connect",
        defaultMessage: "Connect",
      }),
      run: connect,
    },
  ],
});

/**
 * The model picker's setup row for an Agent the person turned on but cannot use yet: the quiet
 * place that explains why its models are missing. A turned-off Agent gets none.
 */
export function agentReadinessSetupHint(
  provider: ProviderReadiness | undefined,
  intl: IntlShape = getIntl(),
): { readonly hint: string; readonly tone: "default" | "danger" } | null {
  switch (agentReadinessProblem(provider)) {
    case "signed-out":
      return {
        hint: intl.formatMessage({
          id: "conversation.agentReadinessNotice.signIn",
          defaultMessage: "Sign in",
        }),
        tone: "default",
      };
    case "not-installed":
      return {
        hint: intl.formatMessage({
          id: "conversation.agentReadinessNotice.install",
          defaultMessage: "Install",
        }),
        tone: "default",
      };
    case "no-connection":
      return {
        hint: intl.formatMessage({
          id: "conversation.agentReadinessNotice.cantConnect",
          defaultMessage: "Can’t connect",
        }),
        tone: "default",
      };
    case "not-responding":
      return {
        hint: intl.formatMessage({
          id: "conversation.agentReadinessNotice.notResponding",
          defaultMessage: "Not responding",
        }),
        tone: "default",
      };
    case "not-ready":
      return {
        hint: intl.formatMessage({
          id: "conversation.agentReadinessNotice.unavailable",
          defaultMessage: "Unavailable",
        }),
        tone: "danger",
      };
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
  intl: IntlShape = getIntl(),
): ComposerNotice | null {
  if (!checkFailed && (state?.status === "notApplicable" || state?.status === "ready")) return null;
  const key = `windows-sandbox:${state?.generation ?? 0}:${state?.status ?? "checking"}`;
  const check: ComposerNoticeAction = {
    label: intl.formatMessage({
      id: "conversation.agentReadinessNotice.checkAgain",
      defaultMessage: "Check again",
    }),
    run: fixes.checkAgain,
  };
  if (checkFailed || state?.failure === "checkFailed") {
    return {
      key,
      tone: "danger",
      title: intl.formatMessage({
        id: "conversation.agentReadinessNotice.sandboxCheckFailed",
        defaultMessage: "Couldn’t check Codex’s Windows setup",
      }),
      actions: [check],
    };
  }
  if (!state || state.status === "checking") {
    return {
      key,
      tone: "warning",
      title: intl.formatMessage({
        id: "conversation.agentReadinessNotice.checkingSandbox",
        defaultMessage: "Checking Codex’s Windows setup…",
      }),
    };
  }
  if (state.status === "settingUp") {
    return {
      key,
      tone: "warning",
      title: intl.formatMessage({
        id: "conversation.agentReadinessNotice.settingUpWindows",
        defaultMessage: "Setting up Codex for Windows…",
      }),
      actions: [
        {
          label: intl.formatMessage({
            id: "conversation.agentReadinessNotice.cancel",
            defaultMessage: "Cancel",
          }),
          run: () => fixes.cancel(state.generation),
        },
      ],
    };
  }
  const titles = defineMessages({
    cancelled: {
      id: "conversation.agentReadinessNotice.sandboxSetupCanceled",
      defaultMessage: "Windows setup was canceled",
    },
    timeout: {
      id: "conversation.agentReadinessNotice.sandboxSetupTimedOut",
      defaultMessage: "Windows setup timed out",
    },
    setupFailed: {
      id: "conversation.agentReadinessNotice.sandboxSetupIncomplete",
      defaultMessage: "Codex’s Windows setup didn’t finish",
    },
    checkFailed: {
      id: "conversation.agentReadinessNotice.sandboxCheckFailed",
      defaultMessage: "Couldn’t check Codex’s Windows setup",
    },
  });
  return {
    key,
    tone: state.failure ? "danger" : "warning",
    title: state.failure
      ? intl.formatMessage(titles[state.failure])
      : state.status === "updateRequired"
        ? intl.formatMessage({
            id: "conversation.agentReadinessNotice.sandboxNeedsUpdate",
            defaultMessage: "Codex’s Windows setup needs an update",
          })
        : intl.formatMessage({
            id: "conversation.agentReadinessNotice.sandboxSetupRequired",
            defaultMessage: "Codex needs a one-time Windows setup to run safely",
          }),
    actions: windowsSandboxSetupActions(state, fixes.setup, check, intl),
  };
}

// Setup asks for administrator approval when allowed; working without it is an explicit fallback.
function windowsSandboxSetupActions(
  state: AgentWindowsSandboxState,
  setup: (mode: WindowsSandboxSetupMode) => Promise<void>,
  check: ComposerNoticeAction,
  intl: IntlShape,
): ComposerNoticeAction[] {
  const preferred = state.allowedModes.includes("elevated") ? "elevated" : state.allowedModes[0];
  if (!preferred) return [check];
  const primary = {
    label: state.failure
      ? intl.formatMessage({
          id: "conversation.agentReadinessNotice.tryAgain",
          defaultMessage: "Try again",
        })
      : intl.formatMessage({
          id: "conversation.agentReadinessNotice.setUp",
          defaultMessage: "Set up",
        }),
    run: () => setup(preferred),
  };
  const fallback =
    state.failure && preferred === "elevated" && state.allowedModes.includes("unelevated")
      ? [
          {
            label: intl.formatMessage({
              id: "conversation.agentReadinessNotice.setUpWithoutAdmin",
              defaultMessage: "Set up without admin",
            }),
            run: () => setup("unelevated"),
          },
        ]
      : [];
  return [primary, ...fallback];
}
