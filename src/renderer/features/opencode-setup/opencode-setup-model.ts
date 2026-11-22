import type { AgentInstallationReadiness } from "../../../shared/agents/readiness";
import { getIntl, defineMessage } from "@/lib/i18n";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { openCodeAgent } from "../../../shared/agents/opencode";
import type {
  OpenCodeInstallFailureReason,
  OpenCodeInstallerLog,
} from "../../../shared/opencode-setup";
import type { OpenCodeSetupSnapshot } from "./opencode-setup-owner";

export const OPENCODE_FREE_MODELS_LABEL = defineMessage({
  id: "opencodeSetup.opencodeSetupModel.freeModels",
  defaultMessage: "Free OpenCode models",
});

/**
 * A local profile that resolves the bare default `opencode` through the host search path, which is
 * the executable host setup installs. An explicit `PATH` makes the profile own that resolution.
 * Accepts saved instances and unsaved editor rows alike.
 */
export const usesHostOpenCodeExecutable = (instance: {
  readonly binaryPath: string;
  readonly serverUrl: string | null;
  readonly environment: readonly { readonly name: string }[];
}): boolean =>
  openCodeAgent.profile.usesHostExecutable({
    ...instance,
    settings: { serverUrl: instance.serverUrl },
  });

export interface OpenCodeSetupInstance {
  readonly binding: Pick<AgentBackendBinding, "driver">;
  readonly enabled: boolean;
  readonly usesHostExecutable?: boolean;
}

/** Host setup matters to the model menu only while an enabled profile depends on it. */
export const dependsOnHostOpenCode = (instances: readonly OpenCodeSetupInstance[]): boolean =>
  instances.some(
    (instance) =>
      instance.binding.driver === "opencode" &&
      instance.enabled &&
      instance.usesHostExecutable === true,
  );

const RETRYABLE_FAILURES: ReadonlySet<OpenCodeInstallFailureReason> = new Set([
  "process",
  "timeout",
  "output-limit",
  "configuration",
]);

export type OpenCodeInstallView =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "idle"; readonly command: string; readonly supported: boolean }
  | {
      readonly kind: "running";
      readonly command: string;
      readonly log: OpenCodeInstallerLog;
      readonly cancelling: boolean;
      readonly cancelError: string | null;
    }
  | {
      readonly kind: "ready";
      readonly command: string;
      readonly log: OpenCodeInstallerLog | null;
      readonly version: string;
      readonly binaryPath: string;
    }
  | {
      readonly kind: "outdated";
      readonly command: string;
      readonly log: OpenCodeInstallerLog | null;
      readonly version: string;
      readonly minimumVersion: string;
    }
  | {
      readonly kind: "unusable";
      readonly command: string;
      readonly log: OpenCodeInstallerLog | null;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly command: string;
      readonly log: OpenCodeInstallerLog | null;
      readonly message: string;
      readonly retryable: boolean;
    };

const EMPTY_LOG: OpenCodeInstallerLog = { lines: [], progress: null };

/** One projection of host setup for every OpenCode setup surface. */
export function openCodeInstallView(snapshot: OpenCodeSetupSnapshot): OpenCodeInstallView {
  const { state } = snapshot;
  if (!state)
    return snapshot.loadError
      ? { kind: "unreadable", message: snapshot.loadError }
      : { kind: "loading" };
  const { command, executable, installation } = state;
  const log = installation.phase === "idle" ? null : installation.log;
  if (snapshot.requestError?.request === "install")
    return {
      kind: "failed",
      command,
      log,
      message: snapshot.requestError.message,
      retryable: true,
    };
  if (installation.phase === "running" || snapshot.request === "install")
    return {
      kind: "running",
      command,
      log: installation.phase === "running" ? installation.log : EMPTY_LOG,
      cancelling: snapshot.request === "cancel",
      cancelError:
        snapshot.requestError?.request === "cancel" ? snapshot.requestError.message : null,
    };
  // A failed provider refresh leaves an installed executable that chats still cannot use.
  if (
    installation.phase === "failed" &&
    (executable.status !== "ready" || installation.reason === "configuration")
  )
    return {
      kind: "failed",
      command,
      log,
      message: installation.message,
      retryable: RETRYABLE_FAILURES.has(installation.reason),
    };
  switch (executable.status) {
    case "ready":
      return {
        kind: "ready",
        command,
        log,
        version: executable.version,
        binaryPath: executable.binaryPath,
      };
    case "incompatible":
      return {
        kind: "outdated",
        command,
        log,
        version: executable.version,
        minimumVersion: executable.minimumVersion,
      };
    case "unusable":
      return { kind: "unusable", command, log, message: executable.message };
    case "missing":
      return { kind: "idle", command, supported: state.supported };
  }
}

export const formatInstallProgress = (progress: number | null): string | null =>
  progress === null ? null : `${Math.round(progress * 100)}%`;

/** The host installer supplies facts to Agent readiness. The dialog owns its log and controls. */
export function openCodeInstallationReadiness(
  view: OpenCodeInstallView,
): AgentInstallationReadiness | undefined {
  switch (view.kind) {
    case "loading":
      return { problem: { kind: "checking" } };
    case "ready":
      return undefined;
    case "unreadable":
    case "unusable":
      return { problem: { kind: "could-not-start" }, detail: view.message };
    case "idle":
      return view.supported ? { problem: { kind: "not-installed" } } : undefined;
    case "running":
      return {
        problem: {
          kind: "installing",
          ...(view.log.progress !== null ? { progress: view.log.progress } : {}),
        },
      };
    case "failed":
      return {
        problem: { kind: "installation-failed", retry: view.retryable ? "manual" : "settings" },
        detail: view.message,
      };
    case "outdated":
      return { problem: { kind: "needs-update", version: view.minimumVersion }, found: true };
  }
}

export interface OpenCodeExecutableStatusAction {
  readonly kind: "dialog" | "refresh";
  readonly label: string;
}

/** Settings describe the saved host executable and offer at most one next step. */
export function openCodeExecutableStatusAction(
  view: OpenCodeInstallView,
  intl = getIntl(),
): OpenCodeExecutableStatusAction | null {
  switch (view.kind) {
    case "loading":
    case "ready":
      return null;
    case "idle":
      return view.supported
        ? {
            kind: "dialog",
            label: intl.formatMessage({
              id: "opencodeSetup.opencodeSetupModel.install",
              defaultMessage: "Install",
            }),
          }
        : null;
    case "running":
      return {
        kind: "dialog",
        label: intl.formatMessage({
          id: "opencodeSetup.opencodeSetupModel.showProgress",
          defaultMessage: "Show progress",
        }),
      };
    case "failed":
      // The dialog keeps the output beside its own Retry, so Settings never restarts blindly.
      return {
        kind: "dialog",
        label: intl.formatMessage({
          id: "opencodeSetup.opencodeSetupModel.showOutput",
          defaultMessage: "Show output",
        }),
      };
    case "unreadable":
    case "outdated":
    case "unusable":
      return {
        kind: "refresh",
        label: intl.formatMessage({
          id: "opencodeSetup.opencodeSetupModel.checkAgain",
          defaultMessage: "Check again",
        }),
      };
  }
}
