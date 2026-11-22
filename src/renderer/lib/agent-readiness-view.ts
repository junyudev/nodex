import { agentReadinessTitle } from "../../shared/agents/readiness-messages";
import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type { AgentReadiness, AgentReadinessAction } from "../../shared/agents/readiness";

const hints = defineMessages({
  checking: { id: "firstRun.firstRunModel.checking", defaultMessage: "Checking…" },
  connecting: { id: "agentReadiness.connecting", defaultMessage: "Connecting…" },
  installing: { id: "appComponents.setup.installing", defaultMessage: "Installing" },
  "installation-failed": {
    id: "opencodeSetup.opencodeSetupModel.failed",
    defaultMessage: "Failed",
  },
  "turned-off": { id: "appComponents.setup.turnedOff", defaultMessage: "Turned off" },
  "not-installed": {
    id: "conversation.agentReadinessNotice.notInstalled",
    defaultMessage: "Not installed",
  },
  "signed-out": { id: "conversation.agentReadinessNotice.signIn", defaultMessage: "Sign in" },
  "no-connection": {
    id: "conversation.agentReadinessNotice.cantConnect",
    defaultMessage: "Can’t connect",
  },
  "not-responding": {
    id: "conversation.agentReadinessNotice.notResponding",
    defaultMessage: "Not responding",
  },
  "could-not-start": {
    id: "opencodeSetup.opencodeSetupModel.unavailable",
    defaultMessage: "Unavailable",
  },
  "needs-update": { id: "opencodeSetup.opencodeSetupModel.update", defaultMessage: "Update" },
  "no-models": { id: "conversation.agentReadinessNotice.setUp", defaultMessage: "Set up" },
  "choose-model": { id: "agentReadiness.chooseModelAction", defaultMessage: "Choose model" },
  "model-missing": { id: "agentReadiness.chooseModelAction", defaultMessage: "Choose model" },
  "not-connected": { id: "conversation.agentReadinessNotice.connect", defaultMessage: "Connect" },
  "connection-failed": {
    id: "conversation.agentReadinessNotice.connect",
    defaultMessage: "Connect",
  },
});

const actions = defineMessages({
  "sign-in": { id: "conversation.agentReadinessNotice.signIn", defaultMessage: "Sign in" },
  settings: { id: "conversation.agentReadinessNotice.settings", defaultMessage: "Settings" },
  components: { id: "conversation.agentReadinessNotice.settings", defaultMessage: "Settings" },
  "check-again": {
    id: "conversation.agentReadinessNotice.checkAgain",
    defaultMessage: "Check again",
  },
  install: { id: "conversation.agentReadinessNotice.install", defaultMessage: "Install" },
  "retry-installation": { id: "appComponents.tryAgain", defaultMessage: "Try again" },
  connect: { id: "conversation.agentReadinessNotice.connect", defaultMessage: "Connect" },
  "choose-model": { id: "agentReadiness.chooseModelAction", defaultMessage: "Choose model" },
});

export const agentReadinessActionLabel = (action: AgentReadinessAction, intl: IntlShape) =>
  intl.formatMessage(actions[action.kind]);

/** The same words describe a checked fact wherever an Agent appears. */
export function agentReadinessView(
  label: string,
  readiness: AgentReadiness,
  intl: IntlShape = getIntl(),
) {
  const { problem } = readiness;
  const progress = problem.kind === "installing" ? problem.progress : undefined;
  const retrying = problem.kind === "installation-failed" && problem.retry === "automatic";
  const tone =
    problem.kind === "checking" ||
    problem.kind === "connecting" ||
    problem.kind === "installing" ||
    retrying
      ? "progress"
      : problem.kind === "installation-failed" ||
          problem.kind === "could-not-start" ||
          problem.kind === "connection-failed"
        ? "danger"
        : "warning";
  const { message, values } = agentReadinessTitle(label, problem);
  const title = intl.formatMessage(message, values);
  const hint =
    progress !== undefined
      ? intl.formatNumber(progress, { style: "percent" })
      : problem.kind === "not-installed" &&
          (readiness.action?.kind === "install" || readiness.action?.kind === "connect")
        ? intl.formatMessage(actions.install)
        : intl.formatMessage(hints[problem.kind]);
  const detail =
    problem.kind === "could-not-start" ||
    problem.kind === "connection-failed" ||
    problem.kind === "not-responding" ||
    problem.kind === "installation-failed" ||
    problem.kind === "not-installed" ||
    (problem.kind === "signed-out" &&
      readiness.action?.kind === "sign-in" &&
      readiness.action.via === "terminal")
      ? readiness.detail
      : problem.kind === "no-connection"
        ? (readiness.detail ??
          intl.formatMessage({
            id: "conversation.agentReadinessNotice.checkNetworkOrProxy",
            defaultMessage: "Check your network connection or proxy.",
          }))
        : null;
  return { title, hint, detail, tone } as const;
}
