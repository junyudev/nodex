import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AcpFailure, AcpOperations, AcpResult } from "../../../shared/acp-api";
import type {
  AcpAgentInstanceConfig,
  AcpAgentInstanceInput,
} from "../../../shared/acp-agent-settings";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { formatBytes } from "../../lib/file-metadata-format";

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

/** A rejected IPC call loses its structure; the readable part follows Electron's prefix. */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/u;
export const describeAcpCause = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .replace(REMOTE_METHOD_PREFIX, "")
    .trim() || "Something went wrong.";

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
const PROGRESS_PHASE: Record<AcpProgress["phase"], string> = {
  downloading: "Downloading",
  verifying: "Verifying",
  extracting: "Unpacking",
  installing: "Installing",
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
  const connected =
    activity?.phase === "succeeded" && activity.kind === "connect" && activity.result
      ? activity.result
      : null;
  if (provider?.auth.status === "unauthenticated")
    return status("sign-in", "Sign-in required", "default", "sign-in");
  if (provider?.status === "error")
    return status("failed", "Error", "danger", "connect", provider.message ?? null);
  if (provider && acpProviderDiscovered(provider))
    return status("ready", "Ready", "info", null, modelCount(provider.models.length));
  if (connected && "models" in connected)
    return status("ready", "Ready", "info", null, modelCount(connected.models.length));
  return status("not-connected", "Not connected", "muted", "connect");
}

/**
 * Whether the Runtime learned this Agent's capabilities from a real connection or session.
 * Before that, its only model is the startup Default it offers so a chat can still begin.
 */
export const acpProviderDiscovered = (provider: AcpProviderSnapshot): boolean =>
  provider.nativeSessions !== undefined ||
  provider.models.some(
    (model) => !model.isCustom && !(model.slug === "default" && model.name === "Default"),
  );

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
 * What the model menu offers for an enabled ACP instance whose models aren't usable yet, read
 * from the Runtime's last known state only. Null when its models are already listed.
 */
export function acpComposerSetupHint(
  provider: AcpProviderSnapshot | undefined,
  activity?: AcpActivity,
): { readonly hint: string; readonly tone: "default" | "danger" } | null {
  if (!provider || !provider.enabled) return null;
  // This window's latest Connect is newer evidence than the Runtime's last known account.
  const refused =
    activity?.phase === "failed" && activity.failure?.reason === "authentication_failed";
  if (refused || provider.auth.status === "unauthenticated")
    return { hint: "Sign in", tone: "default" };
  if (!provider.installed) return { hint: "Install", tone: "default" };
  if (provider.status === "error") return { hint: "Unavailable", tone: "danger" };
  if (!acpProviderDiscovered(provider)) return { hint: "Connect", tone: "default" };
  return null;
}

/** The Settings anchor that reveals one instance, used by deep links from conversations. */
export const acpAgentAnchor = (instanceId: string) => `acp-agent-${instanceId}`;

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
