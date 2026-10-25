import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AcpFailure, AcpOperations, AcpResult } from "../../../shared/acp-api";
import type {
  AcpAgentInstanceConfig,
  AcpAgentInstanceInput,
} from "../../../shared/acp-agent-settings";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { formatBytes } from "../../lib/file-metadata-format";
import { readableIpcError } from "../../lib/ipc-error-message";

export type AcpInspection = AcpOperations["acp.inspect"]["output"];
export type AcpOperation = AcpOperations["acp.operation.read"]["output"];
export type AcpAuthState = AcpOperations["acp.auth.read"]["output"];
export type AcpAuthInteraction = NonNullable<AcpAuthState["interaction"]>;
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

/** A rejected IPC call loses its structure; only its readable reason remains. */
export const describeAcpCause = (cause: unknown): string =>
  readableIpcError(cause, "Something went wrong.");

/** Transport and programming failures become an `invalid_request` failure with their message. */
export const transportFailure = (cause: unknown): AcpFailure => ({
  reason: "invalid_request",
  message: describeAcpCause(cause),
});

export const settle = async <Value>(
  run: () => Promise<AcpResult<Value>>,
): Promise<AcpResult<Value>> => {
  try {
    return await run();
  } catch (cause) {
    return { ok: false, error: transportFailure(cause) };
  }
};

export const acpProviderId = (instance: Pick<AcpAgentInstanceConfig, "id" | "agentDefinitionId">) =>
  agentRuntimeProviderId({
    kind: "acp",
    agentDefinitionId: instance.agentDefinitionId,
    instanceConfigId: instance.id,
  });

/** Saved instances round-trip as update input; masked secrets stay `null` to keep their value. */
export const acpInstanceInput = (instance: AcpAgentInstanceConfig): AcpAgentInstanceInput => ({
  ...instance,
  environment: instance.environment.map((variable) => ({ ...variable })),
});

const DISTRIBUTION_LABELS: Record<AcpDistributionChoice, string> = {
  auto: "Automatic",
  binary: "Binary",
  npx: "npm",
  uvx: "uv",
};
export const acpDistributionLabel = (distribution: AcpDistributionChoice | "local") =>
  distribution === "local" ? "Local command" : DISTRIBUTION_LABELS[distribution];

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
): string | null => {
  switch (reason) {
    case null:
      return null;
    case "unsupported_platform":
      return "No build for this computer";
    case "unsupported_distribution":
      return "Not offered";
    case "runner_unavailable":
      return `Requires ${acpRunnerLabel(runner)}`;
  }
};

/** Why a Registry Agent cannot be installed at all, or null when one distribution can. */
export const acpRegistryUnavailableText = (agent: AcpRegistryAgent): string | null => {
  if (agent.distributions.some((entry) => entry.available)) return null;
  const runnerMissing = agent.distributions.find((entry) => entry.reason === "runner_unavailable");
  if (runnerMissing) return acpAvailabilityText(runnerMissing.reason, runnerMissing.runner);
  return "No build for this computer";
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

const CONTEXT_FALLBACK: Record<AcpFailureContext, string> = {
  install: "Installation failed.",
  connect: "Couldn't connect to the Agent.",
  "sign-in": "Sign-in didn't finish.",
  "sign-out": "Couldn't sign out.",
  uninstall: "Couldn't uninstall.",
  history: "Couldn't read the Agent's conversations.",
  import: "Couldn't import this conversation.",
  delete: "Couldn't delete this conversation.",
  "model-services": "Couldn't update model services.",
  inspect: "Couldn't check this Agent.",
};

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

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
          ? `In use by ${count} ${plural(count, "chat", "chats")}. Stop ${plural(count, "it", "them")} first.`
          : "The Agent is busy. Try again when its current work finishes.",
      );
    }
    case "configuration_pending":
      return own("Saved changes apply when the Agent's current work finishes. Try again then.");
    case "disabled":
      return own("Turn this Agent on first.");
    case "operation_expired":
      return own("This step is no longer active. Start it again.");
    case "authentication_failed":
      return own("Sign in to continue.");
    case "agent_not_configured":
    case "instance_not_found":
      return own("This Agent is no longer configured.");
    case "agent_not_found":
      return own("This Agent is no longer in the ACP Registry.");
    case "registry_unavailable":
      return own("Couldn't reach the ACP Registry. Check your connection and try again.");
    case "download_failed":
      return own("The download failed. Check your connection and try again.");
    case "archive_invalid":
      return own("The downloaded archive is invalid.");
    case "checksum_mismatch":
      return own("The download didn't match its published checksum.");
    case "unsupported_platform":
      return own("No build is available for this computer.");
    case "unsupported_distribution":
      return own("That distribution isn't offered for this Agent.");
    case "runner_unavailable":
      return withMessage("A required runner isn't installed.");
    case "logout_unsupported":
      return own("This Agent doesn't support signing out from Nodex.");
    case "session_list_unsupported":
      return own("This Agent doesn't list its conversations.");
    case "session_delete_unsupported":
      return own("This Agent can't delete its conversations.");
    case "session_resume_unsupported":
      return own("This Agent can't reopen its conversations.");
    case "providers_unsupported":
      return own("This Agent doesn't manage model services.");
    case "project_not_found":
      return own("Choose an active Project with a folder.");
    default:
      return withMessage(CONTEXT_FALLBACK[context]);
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
  | NonNullable<AcpAuthState["methods"]>[number]
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

export const acpSignInActionLabel = (method: AcpSignInMethod): string => {
  switch (method.kind) {
    case "agent":
      return `Sign in with ${method.name}`;
    case "terminal":
      return `Open ${method.name}`;
    case "environment":
      return method.variables.length > 0
        ? `Set ${method.variables.join(", ")}`
        : `Use ${method.name}`;
  }
};

const ACTIVE_AUTH_PHASES = new Set<AcpAuthState["phase"]>(["starting", "waiting", "verifying"]);
export const isAcpAuthActive = (state: AcpAuthState | null | undefined): boolean =>
  state !== null && state !== undefined && ACTIVE_AUTH_PHASES.has(state.phase);

export type AcpProgress = NonNullable<AcpOperation["progress"]>;
/** The final phase repeats the Installing status, so it adds no detail. */
const PROGRESS_PHASE: Record<AcpProgress["phase"], string | null> = {
  downloading: "Downloading",
  verifying: "Verifying",
  extracting: "Unpacking",
  installing: null,
};
/** A percentage only exists with a known total; otherwise bytes or the phase stand alone. */
export const acpProgressText = (progress: AcpProgress | undefined): string | null => {
  if (!progress) return null;
  if (progress.phase === "downloading" && progress.totalBytes)
    return `${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`;
  if (progress.phase === "downloading" && progress.downloadedBytes > 0)
    return formatBytes(progress.downloadedBytes);
  return PROGRESS_PHASE[progress.phase];
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

const modelCount = (count: number) => `${count} ${plural(count, "model", "models")}`;

function failureStatus(failure: AcpFailure, kind: AcpActivity["kind"]): AcpInstanceStatus {
  const retry: AcpStatusAction = kind;
  switch (failure.reason) {
    case "authentication_failed":
      return status("sign-in", "Sign-in required", "default", "sign-in");
    case "runner_unavailable":
      return status("needs-runner", "Needs a runner", "danger", null, failure.message);
    case "unsupported_platform":
      return status("unsupported", "Unavailable", "danger", null, "No build for this computer");
    case "configuration_pending":
      return status(
        "pending",
        "Changes pending",
        "muted",
        null,
        "Applies when its current work finishes",
      );
    case "disabled":
      return status("off", "Off", "muted", null);
    default:
      return status(
        "failed",
        kind === "install" ? "Install failed" : "Couldn't connect",
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
export function acpInstanceStatus(input: {
  readonly instance: AcpAgentInstanceConfig;
  readonly inspection: AcpInspectionState | undefined;
  readonly provider: AcpProviderSnapshot | undefined;
  readonly activity: AcpActivity | undefined;
}): AcpInstanceStatus {
  const { instance, inspection, provider, activity } = input;
  if (!instance.enabled) return status("off", "Off", "muted", null);
  if (activity && (activity.phase === "running" || activity.phase === "starting"))
    return activity.kind === "install"
      ? status(
          "installing",
          "Installing",
          "default",
          "cancel",
          activity.cancelling ? "Cancelling…" : acpProgressText(activity.progress),
        )
      : status(
          "connecting",
          "Connecting",
          "default",
          "cancel",
          activity.cancelling ? "Cancelling…" : null,
        );
  // The owner retires a sign-in failure once sign-in is verified; a later Connect is newer
  // evidence than the Runtime's last known account state.
  if (activity?.phase === "failed" && activity.failure)
    return failureStatus(activity.failure, activity.kind);
  if (!inspection || inspection.status === "loading")
    return status("checking", "Checking", "muted", null);
  if (inspection.status === "failed") return failureStatus(inspection.failure, "connect");
  const inspected = inspection.value;
  switch (inspected.status) {
    case "unconfigured":
    case "not_found":
      return status("missing", "Not in Registry", "danger", null);
    case "unsupported":
      return status("unsupported", "Unavailable", "danger", null, "No build for this computer");
    case "missing_runner":
      return inspected.distribution === "local"
        ? status("needs-runner", "Command not found", "danger", null)
        : status(
            "needs-runner",
            `Needs ${acpRunnerLabel(inspected.runner)}`,
            "danger",
            null,
            `Install ${acpRunnerLabel(inspected.runner)} to run this Agent`,
          );
    case "unprepared":
      return status("not-installed", "Not installed", "default", "install");
    case "ready":
      break;
  }
  if (provider?.auth.status === "unauthenticated")
    return status("sign-in", "Sign-in required", "default", "sign-in");
  if (provider?.status === "error")
    return status("failed", "Error", "danger", "connect", provider.message ?? null);
  switch (provider?.discovery?.status) {
    case "ready":
      return status(
        "ready",
        "Ready",
        "info",
        null,
        provider.discovery.supportsModelSelection === false
          ? "Startup model"
          : modelCount(provider.models.length),
      );
    case "failed":
      return status(
        "failed",
        "Couldn't connect",
        "danger",
        "connect",
        provider.message ?? "Check the Agent's command and try again.",
      );
    default:
      return status("not-connected", "Not connected", "muted", "connect");
  }
}

/**
 * Whether a real connection or session reported this Agent's capabilities. Installation and
 * sign-in don't prove it; until then the Agent offers no models.
 */
export const acpProviderDiscovered = (provider: AcpProviderSnapshot): boolean =>
  provider.discovery?.status === "ready";

export const ACP_STATUS_ACTION_LABELS: Record<Exclude<AcpStatusAction, null>, string> = {
  install: "Install",
  connect: "Connect",
  "sign-in": "Sign in",
  cancel: "Cancel",
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

/**
 * What the model menu offers for an enabled ACP instance whose models aren't usable yet, from the
 * Runtime's provider state, which also records a refused Connect. Null once its models are known.
 */
export function acpComposerSetupHint(
  provider: AcpProviderSnapshot | undefined,
): { readonly hint: string; readonly tone: "default" | "danger" } | null {
  if (!provider || !provider.enabled) return null;
  if (provider.auth.status === "unauthenticated") return { hint: "Sign in", tone: "default" };
  if (!provider.installed) return { hint: "Install", tone: "default" };
  if (provider.status === "error") return { hint: "Unavailable", tone: "danger" };
  if (provider.discovery?.status === "failed") return { hint: "Connect", tone: "danger" };
  if (!acpProviderDiscovered(provider)) return { hint: "Connect", tone: "default" };
  return null;
}

/**
 * What the collapsed Settings section says about its instances: how many there are, and how many
 * an enabled instance's next step is waiting on the user (a failure, sign-in or install).
 */
export function acpAgentsSummary(statuses: readonly AcpInstanceStatus[]): {
  readonly text: string;
  readonly attention: string | null;
} {
  if (statuses.length === 0) return { text: "None added", attention: null };
  const waiting = statuses.filter(
    (status) =>
      status.tone === "danger" || status.kind === "sign-in" || status.kind === "not-installed",
  ).length;
  return {
    text: statuses.length === 1 ? "1 agent" : `${statuses.length} agents`,
    attention:
      waiting === 0 ? null : waiting === 1 ? "1 needs attention" : `${waiting} need attention`,
  };
}

/** The Settings anchor that reveals one instance, used by deep links from conversations. */
export const acpAgentAnchor = (instanceId: string) => `acp-agent-${instanceId}`;

/** The Settings button that opens the Add agent dialog; focus returns to it on close. */
export const ACP_ADD_AGENT_ID = "acp-add-agent";

/** Whether a Settings anchor points inside Other agents: at one instance or at Add agent. */
export const isAcpAgentsAnchor = (anchor: string) =>
  anchor.startsWith(acpAgentAnchor("")) || anchor === ACP_ADD_AGENT_ID;

/**
 * The Runtime sends a bounded tail of the sign-in transcript and the total characters written.
 * Returns what to append since `written`, or the whole tail after a gap the tail no longer covers.
 */
export function acpTerminalDelta(
  written: number,
  output: string,
  outputOffset: number,
): { readonly reset: boolean; readonly data: string } {
  const unseen = outputOffset - written;
  if (unseen < 0 || unseen > output.length) return { reset: true, data: output };
  return { reset: false, data: unseen === 0 ? "" : output.slice(output.length - unseen) };
}

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
  title: `Imported from ${agent}`,
  description: imported.canLoad
    ? `Send a message to continue. ${agent} will try to restore the earlier messages.`
    : imported.canResume
      ? `Send a message to continue. ${agent} keeps the earlier context, but its messages can't be shown here.`
      : "Send a message to continue.",
});
