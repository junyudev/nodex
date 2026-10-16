import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { defaultOpenCodeInstance } from "../../../shared/opencode-agent-settings";
import type {
  OpenCodeInstallFailureReason,
  OpenCodeInstallerLog,
} from "../../../shared/opencode-setup";
import type { OpenCodeSetupSnapshot } from "./opencode-setup-owner";

export const OPENCODE_FREE_MODELS_LABEL = "Free OpenCode models";

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
  !instance.serverUrl &&
  instance.binaryPath.trim() === defaultOpenCodeInstance().binaryPath &&
  !instance.environment.some(({ name }) => name.trim() === "PATH");

export interface OpenCodeSetupInstance {
  readonly binding: Pick<AgentBackendBinding, "kind">;
  readonly enabled: boolean;
  readonly usesHostExecutable?: boolean;
}

/** Host setup matters to the model menu only while an enabled profile depends on it. */
export const dependsOnHostOpenCode = (instances: readonly OpenCodeSetupInstance[]): boolean =>
  instances.some(
    (instance) =>
      instance.binding.kind === "opencode" &&
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

export interface OpenCodeModelSetupEntry {
  readonly hint: string;
  readonly tone: "default" | "danger";
  /** Opening the dialog never starts installation; only its Install action does. */
  readonly action: "dialog" | "settings";
}

/** The model menu offers host setup only where installing could add an enabled profile's models. */
export function openCodeModelSetupEntry(
  snapshot: OpenCodeSetupSnapshot,
  instances: readonly OpenCodeSetupInstance[],
): OpenCodeModelSetupEntry | null {
  if (!dependsOnHostOpenCode(instances) || !snapshot.state?.supported) return null;
  const view = openCodeInstallView(snapshot);
  switch (view.kind) {
    case "loading":
    case "unreadable":
    case "ready":
      return null;
    case "idle":
      return { hint: "Install", tone: "default", action: "dialog" };
    case "running":
      return {
        hint: formatInstallProgress(view.log.progress) ?? "Installing…",
        tone: "default",
        action: "dialog",
      };
    case "failed":
      return { hint: "Failed", tone: "danger", action: "dialog" };
    case "outdated":
      return { hint: "Update", tone: "default", action: "settings" };
    case "unusable":
      return { hint: "Unavailable", tone: "default", action: "settings" };
  }
}

export type OpenCodeExecutableStatusAction =
  | { readonly kind: "dialog"; readonly label: "Install" | "Show progress" | "Show output" }
  | { readonly kind: "refresh"; readonly label: "Check again" };

/** Settings describe the saved host executable and offer at most one next step. */
export function openCodeExecutableStatusAction(
  view: OpenCodeInstallView,
): OpenCodeExecutableStatusAction | null {
  switch (view.kind) {
    case "loading":
    case "ready":
      return null;
    case "idle":
      return view.supported ? { kind: "dialog", label: "Install" } : null;
    case "running":
      return { kind: "dialog", label: "Show progress" };
    case "failed":
      // The dialog keeps the output beside its own Retry, so Settings never restarts blindly.
      return { kind: "dialog", label: "Show output" };
    case "unreadable":
    case "outdated":
    case "unusable":
      return { kind: "refresh", label: "Check again" };
  }
}
