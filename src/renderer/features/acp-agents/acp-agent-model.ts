import type { AgentInstallationReadiness } from "../../../shared/agents/readiness";
import { defineMessage, getIntl, type MessageDescriptor, type IntlShape } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AcpFailure, AcpOperations } from "../../../shared/acp-api";
import type {
  AcpAgentInstanceConfig,
  AcpAgentInstanceInput,
} from "../../../shared/acp-agent-settings";
import { formatBytes } from "../../lib/file-metadata-format";
import type { AgentAccountState } from "../../../shared/agent-accounts-api";

export type AcpInspection = AcpOperations["acp.inspect"]["output"];
export type AcpOperation = AcpOperations["acp.operation.read"]["output"];
export type AcpRegistryAgent = AcpOperations["acp.registry.search"]["output"]["agents"][number];
export type AcpInstallPreview = AcpOperations["acp.install.preview"]["output"];
export type AcpNativeSessionPage = AcpOperations["acp.sessions.list"]["output"];
export type AcpNativeSession = AcpNativeSessionPage["sessions"][number];
export type AcpModelServices = AcpOperations["acp.modelProviders.list"]["output"];
export type AcpModelService = AcpModelServices["providers"][number];
export type AcpProviderSnapshot = AgentRuntimeOperations["providers.read"]["output"][number];
export type AcpDistribution = "binary" | "npx" | "uvx";
export type AcpDistributionChoice = "auto" | AcpDistribution;
export type AcpUrlAuthAction = NonNullable<AcpFailure["authAction"]>;

export {
  describeAgentManagementCause as describeAcpCause,
  settleAgentManagement as settle,
} from "../../lib/agent-management-result";

export const acpProviderId = (instance: Pick<AcpAgentInstanceConfig, "id" | "agentDefinitionId">) =>
  instance.id;

/** Saved instances round-trip as update input; masked secrets stay `null` to keep their value. */
export const acpInstanceInput = (instance: AcpAgentInstanceConfig): AcpAgentInstanceInput => ({
  ...instance,
  environment: instance.environment.map((variable) => ({ ...variable })),
});

const DISTRIBUTION_LABELS: Record<AcpDistributionChoice, string | MessageDescriptor> = {
  auto: defineMessage({
    id: "acpAgents.acpAgentModel.automaticDistribution",
    defaultMessage: "Automatic",
  }),
  binary: defineMessage({
    id: "acpAgents.acpAgentModel.binaryDistribution",
    defaultMessage: "Binary",
  }),
  npx: "npm",
  uvx: "uv",
};
function formatDistributionLabel(label: string | MessageDescriptor): string {
  return typeof label === "string" ? label : getIntl().formatMessage(label);
}
export const acpDistributionLabel = (
  distribution: AcpDistributionChoice | "local",
  intl: IntlShape = getIntl(),
) =>
  distribution === "local"
    ? intl.formatMessage({
        id: "acpAgents.acpAgentModel.localCommand",
        defaultMessage: "Local command",
      })
    : formatDistributionLabel(DISTRIBUTION_LABELS[distribution]);

const RUNNER_LABELS: Record<string, string> = {
  npm: "npm",
  uv: "uv",
  tar: "tar",
  unzip: "unzip",
};
export const acpRunnerLabel = (runner: string | null | undefined): string =>
  (runner && RUNNER_LABELS[runner]) ?? runner ?? "its runner";

export type AcpAvailabilityReason = AcpRegistryAgent["distributions"][number]["reason"];
export const acpAvailabilityText = (
  reason: AcpAvailabilityReason,
  runner: string | null,
  intl: IntlShape = getIntl(),
): string | null => {
  switch (reason) {
    case null:
      return null;
    case "unsupported_platform":
      return intl.formatMessage({
        id: "acpAgents.acpAgentModel.noBuildForThisComputer",
        defaultMessage: "No build for this computer",
      });
    case "unsupported_distribution":
      return intl.formatMessage({
        id: "acpAgents.acpAgentModel.notOffered",
        defaultMessage: "Not offered",
      });
    case "runner_unavailable":
      return intl.formatMessage(
        { id: "acpAgents.acpAgentModel.requiresValue", defaultMessage: "Requires {value1}" },
        { value1: acpRunnerLabel(runner) },
      );
  }
};

/** Why a Registry Agent cannot be installed at all, or null when one distribution can. */
export const acpRegistryUnavailableText = (
  agent: AcpRegistryAgent,
  intl: IntlShape = getIntl(),
): string | null => {
  if (agent.distributions.some((entry) => entry.available)) return null;
  const runnerMissing = agent.distributions.find((entry) => entry.reason === "runner_unavailable");
  if (runnerMissing) return acpAvailabilityText(runnerMissing.reason, runnerMissing.runner, intl);
  return intl.formatMessage({
    id: "acpAgents.acpAgentModel.noBuildForThisComputer",
    defaultMessage: "No build for this computer",
  });
};

/** Arguments display shell-quoted so spaces stay visible; execution never uses a shell. */
export const acpCommandLine = (executable: string, args: readonly string[]): string =>
  [executable, ...args]
    .map((part) => (part === "" || /[\s"'\\$`]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");

/**
 * Pasted multi-line text becomes one argument per line, so a copied command list splits into
 * arguments; a single line stays one argument even when it contains spaces.
 */
export const splitPastedAcpArguments = (text: string): string[] =>
  text.split(/\r?\n/u).filter((line) => line.length > 0);

/** One model ID per line, trimmed and de-duplicated in order. */
export const parseAcpCustomModels = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

export const acpSourceSummary = (
  instance: AcpAgentInstanceConfig,
  inspection: AcpInspection | null,
): string => {
  const source = instance.source;
  if (source.kind === "local") return acpCommandLine(source.executable, source.args);
  const version =
    inspection && "version" in inspection && inspection.version ? `v${inspection.version}` : null;
  const distribution =
    inspection && "distribution" in inspection && inspection.distribution !== "local"
      ? inspection.distribution
      : source.distribution;
  return [source.agentId, version, acpDistributionLabel(distribution)].filter(Boolean).join(" · ");
};

/** An available update for a pinned Registry installation, from the cached catalog only. */
export const acpUpdateVersion = (
  instance: AcpAgentInstanceConfig,
  inspection: AcpInspection | null,
): string | null => {
  if (instance.source.kind !== "registry" || !inspection) return null;
  if (inspection.status !== "ready" || !inspection.version || !inspection.latestVersion)
    return null;
  return inspection.latestVersion !== inspection.version ? inspection.latestVersion : null;
};

export type AcpFailureContext =
  | "install"
  | "connect"
  | "sign-in"
  | "sign-out"
  | "uninstall"
  | "history"
  | "import"
  | "delete"
  | "model-services"
  | "inspect";

const CONTEXT_FALLBACK: Record<AcpFailureContext, MessageDescriptor> = {
  install: defineMessage({
    id: "acpAgents.acpAgentModel.installationFailed",
    defaultMessage: "Installation failed.",
  }),
  connect: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTConnectToThe",
    defaultMessage: "Couldn't connect to the Agent.",
  }),
  "sign-in": defineMessage({
    id: "acpAgents.acpAgentModel.signInDidnTFinish",
    defaultMessage: "Sign-in didn't finish.",
  }),
  "sign-out": defineMessage({
    id: "acpAgents.acpAgentModel.couldnTSignOut",
    defaultMessage: "Couldn't sign out.",
  }),
  uninstall: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTUninstall",
    defaultMessage: "Couldn't uninstall.",
  }),
  history: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTReadTheAgent",
    defaultMessage: "Couldn't read the Agent's conversations.",
  }),
  import: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTImportThisConversation",
    defaultMessage: "Couldn't import this conversation.",
  }),
  delete: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTDeleteThisConversation",
    defaultMessage: "Couldn't delete this conversation.",
  }),
  "model-services": defineMessage({
    id: "acpAgents.acpAgentModel.couldnTUpdateModelServices",
    defaultMessage: "Couldn't update model services.",
  }),
  inspect: defineMessage({
    id: "acpAgents.acpAgentModel.couldnTCheckThisAgent",
    defaultMessage: "Couldn't check this Agent.",
  }),
};

/**
 * Recovery wording comes from the typed reason. Generic reasons keep the Agent's own message as
 * detail because it names the specific step; it never carries secrets or command lines.
 */
export function acpFailureCopy(
  failure: AcpFailure,
  context: AcpFailureContext,
): { readonly title: string; readonly detail: string | null } {
  const own = (title: string) => ({ title, detail: null });
  const withMessage = (title: string) => ({
    title,
    detail: failure.message && failure.message !== title ? failure.message : null,
  });
  switch (failure.reason) {
    case "busy": {
      const count = failure.affectedSessions?.length ?? failure.affectedThreadIds?.length ?? 0;
      return own(
        count > 0
          ? getIntl().formatMessage(
              {
                id: "acpAgents.acpAgentModel.agentInUse",
                defaultMessage:
                  "{count, plural, one {In use by # chat. Stop it first.} other {In use by # chats. Stop them first.}}",
              },
              { count },
            )
          : getIntl().formatMessage({
              id: "acpAgents.acpAgentModel.theAgentIsBusyTry",
              defaultMessage: "The Agent is busy. Try again when its current work finishes.",
            }),
      );
    }
    case "configuration_pending":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.savedChangesApplyWhenThe",
          defaultMessage:
            "Saved changes apply when the Agent's current work finishes. Try again then.",
        }),
      );
    case "disabled":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.turnThisAgentOnFirst",
          defaultMessage: "Turn this Agent on first.",
        }),
      );
    case "operation_expired":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisStepIsNoLonger",
          defaultMessage: "This step is no longer active. Start it again.",
        }),
      );
    case "authentication_failed":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.signInToContinue",
          defaultMessage: "Sign in to continue.",
        }),
      );
    case "agent_not_configured":
    case "instance_not_found":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentIsNoLonger",
          defaultMessage: "This Agent is no longer configured.",
        }),
      );
    case "agent_not_found":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentIsNoLonger2",
          defaultMessage: "This Agent is no longer in the ACP Registry.",
        }),
      );
    case "registry_unavailable":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.couldnTReachTheACP",
          defaultMessage: "Couldn't reach the ACP Registry. Check your connection and try again.",
        }),
      );
    case "download_failed":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.theDownloadFailedCheckYour",
          defaultMessage: "The download failed. Check your connection and try again.",
        }),
      );
    case "archive_invalid":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.theDownloadedArchiveIsInvalid",
          defaultMessage: "The downloaded archive is invalid.",
        }),
      );
    case "checksum_mismatch":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.theDownloadDidnTMatch",
          defaultMessage: "The download didn't match its published checksum.",
        }),
      );
    case "unsupported_platform":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.noBuildIsAvailableFor",
          defaultMessage: "No build is available for this computer.",
        }),
      );
    case "unsupported_distribution":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thatDistributionIsnTOffered",
          defaultMessage: "That distribution isn't offered for this Agent.",
        }),
      );
    case "runner_unavailable":
      return withMessage(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.aRequiredRunnerIsnT",
          defaultMessage: "A required runner isn't installed.",
        }),
      );
    case "logout_unsupported":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentDoesnTSupport",
          defaultMessage: "This Agent doesn't support signing out from Nodex.",
        }),
      );
    case "session_list_unsupported":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentDoesnTList",
          defaultMessage: "This Agent doesn't list its conversations.",
        }),
      );
    case "session_delete_unsupported":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentCanTDelete",
          defaultMessage: "This Agent can't delete its conversations.",
        }),
      );
    case "session_resume_unsupported":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentCanTReopen",
          defaultMessage: "This Agent can't reopen its conversations.",
        }),
      );
    case "providers_unsupported":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.thisAgentDoesnTManage",
          defaultMessage: "This Agent doesn't manage model services.",
        }),
      );
    case "project_not_found":
      return own(
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.chooseAnActiveProjectWith",
          defaultMessage: "Choose an active Project with a folder.",
        }),
      );
    default:
      return withMessage(getIntl().formatMessage(CONTEXT_FALLBACK[context]));
  }
}

export const acpFailureText = (failure: AcpFailure, context: AcpFailureContext): string => {
  const copy = acpFailureCopy(failure, context);
  return copy.detail ? `${copy.title} ${copy.detail}` : copy.title;
};

export type AcpSignInMethod =
  | {
      readonly kind: "agent" | "terminal";
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
    }
  | {
      readonly kind: "environment";
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly variables: readonly string[];
      readonly link: string | null;
    };

type AdvertisedMethod =
  | NonNullable<AgentAccountState["methods"]>[number]
  | NonNullable<AcpFailure["authMethods"]>[number];

/** Normalizes methods from an auth read or a failed connection; ACP env methods become rows. */
export function acpSignInMethods(
  ...sources: readonly (readonly AdvertisedMethod[] | undefined)[]
): AcpSignInMethod[] {
  const methods = new Map<string, AcpSignInMethod>();
  for (const source of sources)
    for (const method of source ?? []) {
      if (methods.has(method.id)) continue;
      const base = { id: method.id, name: method.name, description: method.description ?? null };
      const variables = "envVarNames" in method ? (method.envVarNames ?? []) : [];
      if (method.type === "env_var" || method.type === "credentials")
        methods.set(method.id, {
          ...base,
          kind: "environment",
          variables,
          link: "link" in method ? (method.link ?? null) : null,
        });
      else if (method.type === "terminal" || method.type === "agent")
        methods.set(method.id, { ...base, kind: method.type });
    }
  return [...methods.values()];
}

export const acpSignInActionLabel = (
  method: AcpSignInMethod,
  intl: IntlShape = getIntl(),
): string => {
  switch (method.kind) {
    case "agent":
      return intl.formatMessage(
        { id: "acpAgents.acpAgentModel.signInWithValue", defaultMessage: "Sign in with {value1}" },
        { value1: method.name },
      );
    case "terminal":
      return intl.formatMessage(
        { id: "acpAgents.acpAgentModel.openValue", defaultMessage: "Open {value1}" },
        { value1: method.name },
      );
    case "environment":
      return method.variables.length > 0
        ? intl.formatMessage(
            { id: "acpAgents.acpAgentModel.setVariables", defaultMessage: "Set {variables}" },
            { variables: intl.formatList(method.variables, { type: "unit" }) },
          )
        : intl.formatMessage(
            { id: "acpAgents.acpAgentModel.useValue", defaultMessage: "Use {value1}" },
            { value1: method.name },
          );
  }
};

export type AcpProgress = NonNullable<AcpOperation["progress"]>;
/** The final phase repeats the Installing status, so it adds no detail. */
const PROGRESS_PHASE: Record<AcpProgress["phase"], MessageDescriptor | null> = {
  downloading: defineMessage({
    id: "acpAgents.acpAgentModel.downloading",
    defaultMessage: "Downloading",
  }),
  verifying: defineMessage({
    id: "acpAgents.acpAgentModel.verifying",
    defaultMessage: "Verifying",
  }),
  extracting: defineMessage({
    id: "acpAgents.acpAgentModel.unpacking",
    defaultMessage: "Unpacking",
  }),
  installing: null,
};
/** A percentage only exists with a known total; otherwise bytes or the phase stand alone. */
export const acpProgressText = (progress: AcpProgress | undefined): string | null => {
  if (!progress) return null;
  if (progress.phase === "downloading" && progress.totalBytes)
    return `${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`;
  if (progress.phase === "downloading" && progress.downloadedBytes > 0)
    return formatBytes(progress.downloadedBytes);
  const descriptor = PROGRESS_PHASE[progress.phase];
  return descriptor ? getIntl().formatMessage(descriptor) : null;
};
export const acpProgressFraction = (progress: AcpProgress | undefined): number | null =>
  progress?.phase === "downloading" && progress.totalBytes
    ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
    : null;

/** The owner's view of the latest install or connect operation for one instance. */
export interface AcpActivity {
  readonly kind: "install" | "connect";
  readonly operationId: string;
  readonly phase: "starting" | AcpOperation["phase"];
  readonly progress?: AcpProgress;
  readonly failure: AcpFailure | null;
  readonly result: AcpOperation["result"];
  readonly cancelling: boolean;
}

export type AcpInspectionState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: AcpInspection }
  | { readonly status: "failed"; readonly failure: AcpFailure };

export type AcpStatusTone = "default" | "info" | "danger" | "muted";
export type AcpStatusAction = "install" | "connect" | "sign-in" | "cancel" | null;
export interface AcpInstanceStatus {
  readonly kind:
    | "off"
    | "checking"
    | "installing"
    | "connecting"
    | "not-installed"
    | "needs-runner"
    | "unsupported"
    | "missing"
    | "sign-in"
    | "not-connected"
    | "ready"
    | "pending"
    | "failed";
  readonly label: string;
  readonly detail: string | null;
  readonly tone: AcpStatusTone;
  readonly action: AcpStatusAction;
}

const status = (
  kind: AcpInstanceStatus["kind"],
  label: string,
  tone: AcpStatusTone,
  action: AcpStatusAction,
  detail: string | null = null,
): AcpInstanceStatus => ({ kind, label, detail, tone, action });

const modelCount = (count: number) =>
  getIntl().formatMessage(
    {
      id: "acpAgents.acpAgentModel.modelCount",
      defaultMessage: "{count, plural, one {# model} other {# models}}",
    },
    { count },
  );

// A local command is its own runner: the program it names is what couldn't be found.
const commandNotFound = () =>
  status(
    "needs-runner",
    getIntl().formatMessage({
      id: "acpAgents.acpAgentModel.commandNotFound",
      defaultMessage: "Command not found",
    }),
    "danger",
    null,
    getIntl().formatMessage({
      id: "acpAgents.acpAgentModel.useAnAbsolutePathOr",
      defaultMessage: "Use an absolute path or a command on PATH.",
    }),
  );

function failureStatus(
  failure: AcpFailure,
  kind: AcpActivity["kind"],
  instance: AcpAgentInstanceConfig,
): AcpInstanceStatus {
  const retry: AcpStatusAction = kind;
  switch (failure.reason) {
    case "authentication_failed":
      return status(
        "sign-in",
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.signInRequired",
          defaultMessage: "Sign-in required",
        }),
        "default",
        "sign-in",
      );
    case "runner_unavailable":
      return instance.source.kind === "local"
        ? commandNotFound()
        : status(
            "needs-runner",
            getIntl().formatMessage({
              id: "acpAgents.acpAgentModel.needsARunner",
              defaultMessage: "Needs a runner",
            }),
            "danger",
            null,
            failure.message,
          );
    case "unsupported_platform":
      return status(
        "unsupported",
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.unavailable",
          defaultMessage: "Unavailable",
        }),
        "danger",
        null,
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.noBuildForThisComputer",
          defaultMessage: "No build for this computer",
        }),
      );
    case "configuration_pending":
      return status(
        "pending",
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.changesPending",
          defaultMessage: "Changes pending",
        }),
        "muted",
        null,
        getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.appliesWhenItsCurrentWork",
          defaultMessage: "Applies when its current work finishes",
        }),
      );
    case "disabled":
      return status(
        "off",
        getIntl().formatMessage({ id: "acpAgents.acpAgentModel.off", defaultMessage: "Off" }),
        "muted",
        null,
      );
    default:
      return status(
        "failed",
        kind === "install"
          ? getIntl().formatMessage({
              id: "acpAgents.acpAgentModel.installFailed",
              defaultMessage: "Install failed",
            })
          : getIntl().formatMessage({
              id: "acpAgents.acpAgentModel.couldnTConnect",
              defaultMessage: "Couldn't connect",
            }),
        "danger",
        retry,
        acpFailureText(failure, kind),
      );
  }
}

/**
 * One status per instance: a live operation first, then its last failure, then passive
 * installation state, then what the Runtime last learned from an explicit connection.
 */
export function acpInstanceStatus(
  input: {
    readonly instance: AcpAgentInstanceConfig;
    readonly inspection: AcpInspectionState | undefined;
    readonly provider: AcpProviderSnapshot | undefined;
    readonly activity: AcpActivity | undefined;
  },
  intl: IntlShape = getIntl(),
): AcpInstanceStatus {
  const { instance, inspection, provider, activity } = input;
  if (!instance.enabled)
    return status(
      "off",
      intl.formatMessage({ id: "acpAgents.acpAgentModel.off", defaultMessage: "Off" }),
      "muted",
      null,
    );
  if (activity && (activity.phase === "running" || activity.phase === "starting"))
    return activity.kind === "install"
      ? status(
          "installing",
          intl.formatMessage({
            id: "acpAgents.acpAgentModel.installing",
            defaultMessage: "Installing",
          }),
          "default",
          "cancel",
          activity.cancelling
            ? intl.formatMessage({
                id: "acpAgents.acpAgentModel.cancelling",
                defaultMessage: "Cancelling…",
              })
            : acpProgressText(activity.progress),
        )
      : status(
          "connecting",
          intl.formatMessage({
            id: "acpAgents.acpAgentModel.connecting",
            defaultMessage: "Connecting",
          }),
          "default",
          "cancel",
          activity.cancelling
            ? intl.formatMessage({
                id: "acpAgents.acpAgentModel.cancelling",
                defaultMessage: "Cancelling…",
              })
            : null,
        );
  // The owner retires a sign-in failure once sign-in is verified; a later Connect is newer
  // evidence than the Runtime's last known account state.
  if (activity?.phase === "failed" && activity.failure)
    return failureStatus(activity.failure, activity.kind, instance);
  if (!inspection || inspection.status === "loading")
    return status(
      "checking",
      intl.formatMessage({
        id: "acpAgents.acpAgentModel.checking",
        defaultMessage: "Checking",
      }),
      "muted",
      null,
    );
  if (inspection.status === "failed") return failureStatus(inspection.failure, "connect", instance);
  const inspected = inspection.value;
  switch (inspected.status) {
    case "unconfigured":
    case "not_found":
      return status(
        "missing",
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.notInRegistry",
          defaultMessage: "Not in Registry",
        }),
        "danger",
        null,
      );
    case "unsupported":
      return status(
        "unsupported",
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.unavailable",
          defaultMessage: "Unavailable",
        }),
        "danger",
        null,
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.noBuildForThisComputer",
          defaultMessage: "No build for this computer",
        }),
      );
    case "missing_runner":
      return inspected.distribution === "local"
        ? commandNotFound()
        : status(
            "needs-runner",
            intl.formatMessage(
              { id: "acpAgents.acpAgentModel.needsValue", defaultMessage: "Needs {value1}" },
              { value1: acpRunnerLabel(inspected.runner) },
            ),
            "danger",
            null,
            intl.formatMessage(
              {
                id: "acpAgents.acpAgentModel.installValueToRunThis",
                defaultMessage: "Install {value1} to run this Agent",
              },
              { value1: acpRunnerLabel(inspected.runner) },
            ),
          );
    case "unprepared":
      return status(
        "not-installed",
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.notInstalled",
          defaultMessage: "Not installed",
        }),
        "default",
        "install",
      );
    case "ready":
      break;
  }
  if (provider?.auth.status === "unauthenticated")
    return status(
      "sign-in",
      intl.formatMessage({
        id: "acpAgents.acpAgentModel.signInRequired",
        defaultMessage: "Sign-in required",
      }),
      "default",
      "sign-in",
    );
  if (provider?.status === "error")
    return status(
      "failed",
      intl.formatMessage({ id: "acpAgents.acpAgentModel.error", defaultMessage: "Error" }),
      "danger",
      "connect",
      provider.message ?? null,
    );
  switch (provider?.discovery?.status) {
    case "ready":
      return status(
        "ready",
        intl.formatMessage({ id: "acpAgents.acpAgentModel.ready", defaultMessage: "Ready" }),
        "info",
        null,
        provider.discovery.supportsModelSelection === false
          ? intl.formatMessage({
              id: "acpAgents.acpAgentModel.startupModel",
              defaultMessage: "Startup model",
            })
          : modelCount(provider.models.length),
      );
    case "failed":
      return status(
        "failed",
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.couldnTConnect",
          defaultMessage: "Couldn't connect",
        }),
        "danger",
        "connect",
        provider.message ??
          intl.formatMessage({
            id: "acpAgents.acpAgentModel.checkCommand",
            defaultMessage: "Check the Agent's command and try again.",
          }),
      );
    default:
      return status(
        "not-connected",
        intl.formatMessage({
          id: "acpAgents.acpAgentModel.notConnected",
          defaultMessage: "Not connected",
        }),
        "muted",
        "connect",
      );
  }
}

/**
 * Whether a real connection or session reported this Agent's capabilities. Installation and
 * sign-in don't prove it; until then the Agent offers no models.
 */
export const acpProviderDiscovered = (provider: AcpProviderSnapshot): boolean =>
  provider.discovery?.status === "ready";

export const ACP_STATUS_ACTION_LABELS: Record<Exclude<AcpStatusAction, null>, MessageDescriptor> = {
  install: defineMessage({
    id: "acpAgents.acpAgentModel.installAction",
    defaultMessage: "Install",
  }),
  connect: defineMessage({
    id: "acpAgents.acpAgentModel.connectAction",
    defaultMessage: "Connect",
  }),
  "sign-in": defineMessage({ id: "acpAgents.acpAgentModel.signIn", defaultMessage: "Sign in" }),
  cancel: defineMessage({ id: "acpAgents.acpAgentModel.cancelAction", defaultMessage: "Cancel" }),
};

/** A unique name for another instance of the same Agent: "Qoder", then "Qoder 2", ... */
export function acpInstanceName(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!names.has(base.trim().toLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/** A Profile-local identity that never repurposes an Agent name or executable basename. */
export const acpLocalAgentIdentity = (uuid: string): string => `local-${uuid}`;

export const ACP_REGISTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

const REGISTRY_ICON_HOST = "cdn.agentclientprotocol.com";
/** Registry artwork loads only from the credential-free official CDN. */
export function acpRegistryIconUrl(icon: string | null): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    return url.protocol === "https:" &&
      url.hostname === REGISTRY_ICON_HOST &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Translate Registry inspection and setup activity into facts used by Agent readiness. */
export function acpInstallationReadiness(
  status: AcpInstanceStatus,
): AgentInstallationReadiness | undefined {
  const found = true;
  switch (status.kind) {
    case "ready":
      return undefined;
    case "checking":
      return { problem: { kind: "checking" }, found };
    case "installing":
    case "pending":
      return { problem: { kind: "installing" }, found };
    case "connecting":
      return { problem: { kind: "connecting" }, found };
    case "off":
      return { problem: { kind: "turned-off" }, found };
    case "sign-in":
      return { problem: { kind: "signed-out" }, found };
    case "not-installed":
      return { problem: { kind: "not-installed" }, found };
    case "not-connected":
      return { problem: { kind: "not-connected" }, found };
    case "failed":
      return {
        problem: { kind: "connection-failed" },
        found,
        detail: status.detail ?? status.label,
      };
    default:
      return { problem: { kind: "could-not-start" }, found, detail: status.detail ?? status.label };
  }
}

/**
 * What the collapsed Settings section says about its instances: how many there are, and how many
 * an enabled instance's next step is waiting on the user (a failure, sign-in or install).
 */
export function acpAgentsSummary(
  statuses: readonly AcpInstanceStatus[],
  intl: IntlShape = getIntl(),
): {
  readonly text: string;
  readonly attention: string | null;
} {
  if (statuses.length === 0)
    return {
      text: intl.formatMessage({
        id: "acpAgents.acpAgentModel.noneAdded",
        defaultMessage: "None added",
      }),
      attention: null,
    };
  const waiting = statuses.filter((status) => {
    const kind = acpInstallationReadiness(status)?.problem.kind;
    return (
      kind === "could-not-start" ||
      kind === "connection-failed" ||
      kind === "signed-out" ||
      kind === "not-installed"
    );
  }).length;
  return {
    text:
      statuses.length === 1
        ? intl.formatMessage({
            id: "acpAgents.acpAgentModel.label1Agent",
            defaultMessage: "1 agent",
          })
        : intl.formatMessage(
            { id: "acpAgents.acpAgentModel.valueAgents", defaultMessage: "{value1} agents" },
            { value1: statuses.length },
          ),
    attention:
      waiting === 0
        ? null
        : waiting === 1
          ? intl.formatMessage({
              id: "acpAgents.acpAgentModel.label1NeedsAttention",
              defaultMessage: "1 needs attention",
            })
          : intl.formatMessage(
              {
                id: "acpAgents.acpAgentModel.valueNeedAttention",
                defaultMessage: "{value1} need attention",
              },
              { value1: waiting },
            ),
  };
}

/** The Settings anchor that reveals one instance, used by deep links from conversations. */
export const acpAgentAnchor = (instanceId: string) => `acp-agent-${instanceId}`;

/** The Settings button that opens the Add agent dialog; focus returns to it on close. */
export const ACP_ADD_AGENT_ID = "acp-add-agent";

/** Whether a Settings anchor points inside Other agents: at one instance or at Add agent. */
export const isAcpAgentsAnchor = (anchor: string) =>
  anchor.startsWith(acpAgentAnchor("")) || anchor === ACP_ADD_AGENT_ID;

interface ImportProjection {
  readonly thread: { readonly activeProviderThreadId: string | null } | null;
  readonly providerThreads: readonly {
    readonly id: string;
    readonly status: string;
    readonly nativeMetadata?: {
      readonly nativeImport?: { readonly canLoad: boolean; readonly canResume: boolean };
    } | null;
  }[];
}

/**
 * An imported native conversation the Agent hasn't restored yet: its active provider thread is
 * still not loaded. Restoration changes that status, so the state ends without a second owner.
 */
export function acpPendingImportedHistory(
  projection: ImportProjection | null | undefined,
): { readonly canLoad: boolean; readonly canResume: boolean } | null {
  const activeId = projection?.thread?.activeProviderThreadId;
  if (!activeId) return null;
  const active = projection.providerThreads.find((row) => row.id === activeId);
  return active?.status === "not_loaded" ? (active.nativeMetadata?.nativeImport ?? null) : null;
}

/** What an empty imported transcript means; continuing asks the Agent to restore it. */
export const acpImportedHistoryEmptyState = (
  agent: string,
  imported: { readonly canLoad: boolean; readonly canResume: boolean },
): { readonly title: string; readonly description: string } => ({
  title: getIntl().formatMessage(
    { id: "acpAgents.acpAgentModel.importedFrom", defaultMessage: "Imported from {agent}" },
    { agent },
  ),
  description: imported.canLoad
    ? getIntl().formatMessage(
        {
          id: "acpAgents.acpAgentModel.restoreMessages",
          defaultMessage:
            "Send a message to continue. {agent} will try to restore the earlier messages.",
        },
        { agent },
      )
    : imported.canResume
      ? getIntl().formatMessage(
          {
            id: "acpAgents.acpAgentModel.keepContext",
            defaultMessage:
              "Send a message to continue. {agent} keeps the earlier context, but its messages can't be shown here.",
          },
          { agent },
        )
      : getIntl().formatMessage({
          id: "acpAgents.acpAgentModel.continueHistory",
          defaultMessage: "Send a message to continue.",
        }),
});
