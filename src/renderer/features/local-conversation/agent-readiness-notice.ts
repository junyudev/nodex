import { agentReadinessActionLabel, agentReadinessView } from "@/lib/agent-readiness-view";
import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type { AgentWindowsSandboxState } from "@nodex/agent-runtime/contracts";
import type { WindowsSandboxSetupMode } from "@nodex/codex-app-server-protocol/v2";
import type { AgentReadiness } from "../../../shared/agents/readiness";
import type { ComposerNotice, ComposerNoticeAction } from "./thread-stage-types";

export function agentReadinessNotice(
  instanceId: string,
  label: string,
  readiness: AgentReadiness,
  run: (() => void | Promise<void>) | undefined,
  intl: IntlShape,
): ComposerNotice | null {
  if (readiness.problem.kind === "checking") return null;
  const { title, tone, detail } = agentReadinessView(label, readiness, intl);
  const action = readiness.action;
  const pendingLabel =
    action?.kind === "check-again"
      ? intl.formatMessage({
          id: "conversation.agentReadinessNotice.checking",
          defaultMessage: "Checking…",
        })
      : action?.kind === "sign-in" && (action.via === "browser" || action.via === "dialog")
        ? intl.formatMessage({
            id: "conversation.agentReadinessNotice.opening",
            defaultMessage: "Opening…",
          })
        : undefined;
  return {
    key: `agent:${instanceId}:${readiness.problem.kind}`,
    title,
    tone,
    detail,
    actions:
      action && run
        ? [
            {
              label: agentReadinessActionLabel(action, intl),
              ...(pendingLabel ? { pendingLabel } : {}),
              run,
            },
          ]
        : [],
  };
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
