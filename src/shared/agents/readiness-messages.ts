import type { AgentReadinessProblem } from "./readiness";

const titles = {
  checking: { id: "firstRun.firstRunModel.checking", defaultMessage: "Checking…" },
  connecting: { id: "agentReadiness.connecting", defaultMessage: "Connecting…" },
  installing: { id: "appComponents.claudeSetup.installing", defaultMessage: "Installing {name}…" },
  downloading: {
    id: "appComponents.claudeSetup.downloading",
    defaultMessage: "Installing {name}… {percent, number, percent}",
  },
  retrying: {
    id: "agentReadiness.installationWillRetry",
    defaultMessage: "Couldn’t install {label}. Nodex will try again.",
  },
  "installation-failed": {
    id: "appComponents.claudeSetup.failed",
    defaultMessage: "Couldn’t install {name}",
  },
  "turned-off": {
    id: "conversation.agentReadinessNotice.agentOff",
    defaultMessage: "{label} is turned off",
  },
  "signed-out": {
    id: "conversation.agentReadinessNotice.agentSignedOut",
    defaultMessage: "{label} isn’t signed in",
  },
  "not-installed": {
    id: "conversation.agentReadinessNotice.agentNotInstalled",
    defaultMessage: "{label} isn’t installed",
  },
  "no-connection": {
    id: "conversation.agentReadinessNotice.agentNoConnection",
    defaultMessage: "{label} is signed in but can’t connect",
  },
  "not-responding": {
    id: "conversation.agentReadinessNotice.agentNotResponding",
    defaultMessage: "{label} didn’t respond in time",
  },
  "could-not-start": {
    id: "agentReadiness.couldNotStart",
    defaultMessage: "Couldn’t start {label}",
  },
  "needs-update": {
    id: "agentReadiness.needsUpdate",
    defaultMessage: "{label} needs {version} or newer",
  },
  "no-models": {
    id: "agentReadiness.noModels",
    defaultMessage: "{label} hasn’t offered any models yet",
  },
  "choose-model": {
    id: "agentReadiness.chooseModel",
    defaultMessage: "Choose a model for {label}",
  },
  "model-missing": {
    id: "conversation.agentReadinessNotice.antigravityModelMissing",
    defaultMessage: "That model is no longer available. Choose another model.",
  },
  "not-connected": {
    id: "acpAgents.acpAgentModel.notConnected",
    defaultMessage: "Not connected",
  },
  "connection-failed": {
    id: "acpAgents.acpAgentModel.couldnTConnect",
    defaultMessage: "Couldn't connect",
  },
} as const;

/** The standing problem's title, used in the UI and when an unattended action reports it. */
export function agentReadinessTitle(label: string, problem: AgentReadinessProblem) {
  if (problem.kind === "installation-failed" && problem.retry === "automatic")
    return { message: titles.retrying, values: { label } };
  if (problem.kind === "installing" && problem.progress !== undefined)
    return { message: titles.downloading, values: { name: label, percent: problem.progress } };
  switch (problem.kind) {
    case "installing":
    case "installation-failed":
      return { message: titles[problem.kind], values: { name: label } };
    case "needs-update":
      return { message: titles[problem.kind], values: { label, version: problem.version } };
    case "connecting":
    case "checking":
    case "model-missing":
    case "not-connected":
    case "connection-failed":
      return { message: titles[problem.kind], values: undefined };
    default:
      return { message: titles[problem.kind], values: { label } };
  }
}
