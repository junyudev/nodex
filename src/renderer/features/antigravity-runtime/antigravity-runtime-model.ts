import type { IntlShape } from "@/lib/i18n";
import {
  compareSemverVersions,
  parseSemver,
} from "../../../../packages/agent-runtime/vendor/shared/src/semver";
import type {
  AntigravityExecutableChoice,
  AntigravityRuntimeInspection,
  AntigravityRuntimeOperation,
} from "../../../shared/antigravity-runtime";
import type {
  AntigravityRuntimeAction,
  AntigravityRuntimeViewInput,
} from "./antigravity-runtime-owner";

type Action = {
  readonly kind: AntigravityRuntimeAction;
  readonly label: string;
  /** A step the person may take, rather than the one that unblocks them. */
  readonly optional?: boolean;
};

interface RuntimeView {
  readonly text: string;
  readonly primary?: Action;
  readonly canRemove?: boolean;
  readonly tone?: "danger" | "warning";
}

/** Preserve the release date even when the computer is west of UTC. */
export function formatAntigravityVersion(version: string, intl: IntlShape): string {
  const match = /^agy_acp_server_(\d{4})(\d{2})(\d{2})(?:_|$)/u.exec(version);
  if (!match) return version;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return version;
  return intl.formatDate(date, { dateStyle: "medium", timeZone: "UTC" });
}

function isOlderThan(version: string | null, target: string | null): boolean {
  return Boolean(
    version &&
    target &&
    parseSemver(version) &&
    parseSemver(target) &&
    compareSemverVersions(version, target) < 0,
  );
}

export function antigravityRequiredVersion(
  version: string | null,
  inspection: AntigravityRuntimeInspection,
): string | null {
  return isOlderThan(version, inspection.minimumVersion) ? inspection.minimumVersion : null;
}

function compatibilityText(
  version: string | null,
  inspection: AntigravityRuntimeInspection,
  intl: IntlShape,
  managed: boolean,
): Pick<RuntimeView, "text" | "tone"> | null {
  const advisory = managed ? inspection.compatibility : null;
  const minimum = antigravityRequiredVersion(version, inspection);
  const recommended = inspection.recommendedVersion;
  const { formatMessage } = intl;
  if (advisory?.status === "broken" || advisory?.status === "unsupported" || minimum !== null) {
    return {
      tone: "danger",
      text: minimum
        ? formatMessage(
            {
              id: "antigravityRuntime.requiresVersion",
              defaultMessage: "Requires {version} or newer to start chats",
            },
            { version: formatAntigravityVersion(minimum, intl) },
          )
        : (advisory?.message ??
          formatMessage({
            id: "antigravityRuntime.incompatible",
            defaultMessage: "This version can’t start chats",
          })),
    };
  }
  if (advisory?.status === "graceful" || isOlderThan(version, recommended)) {
    return {
      tone: "warning",
      text: recommended
        ? formatMessage(
            {
              id: "antigravityRuntime.recommendedVersion",
              defaultMessage: "{version} recommended",
            },
            { version: formatAntigravityVersion(recommended, intl) },
          )
        : (advisory?.message ??
          formatMessage({
            id: "antigravityRuntime.outdated",
            defaultMessage: "A newer version is recommended",
          })),
    };
  }
  return null;
}

function progressText(operation: AntigravityRuntimeOperation, intl: IntlShape): string {
  const { formatMessage, formatNumber } = intl;
  const progress = operation.progress;
  if (operation.kind === "remove")
    return formatMessage({
      id: "antigravityRuntime.removing",
      defaultMessage: "Removing Antigravity…",
    });
  switch (progress?.phase) {
    case "downloading": {
      const megabytes = (bytes: number) =>
        formatNumber(bytes / 1_000_000, { maximumFractionDigits: 0 });
      if (progress.totalBytes && progress.totalBytes > 0)
        return formatMessage(
          {
            id: "antigravityRuntime.downloadingTotal",
            defaultMessage: "Downloading {done} of {total} MB",
          },
          { done: megabytes(progress.downloadedBytes), total: megabytes(progress.totalBytes) },
        );
      return formatMessage(
        {
          id: "antigravityRuntime.downloading",
          defaultMessage: "Downloading Antigravity · {done} MB",
        },
        { done: megabytes(progress.downloadedBytes) },
      );
    }
    case "verifying":
      return formatMessage({
        id: "antigravityRuntime.verifying",
        defaultMessage: "Verifying download…",
      });
    case "extracting":
      return formatMessage({
        id: "antigravityRuntime.extracting",
        defaultMessage: "Extracting Antigravity…",
      });
    default:
      return formatMessage({
        id: "antigravityRuntime.installing",
        defaultMessage: "Installing Antigravity…",
      });
  }
}

function removalReason(inspection: AntigravityRuntimeInspection, intl: IntlShape): string | null {
  const { formatMessage } = intl;
  return (
    {
      installation_running: formatMessage({
        id: "antigravityRuntime.removeInstalling",
        defaultMessage: "Removal is unavailable during installation",
      }),
      in_use: formatMessage({
        id: "antigravityRuntime.removeInUse",
        defaultMessage: "Removal is unavailable while Antigravity is in use",
      }),
      configured_path: formatMessage({
        id: "antigravityRuntime.removeConfigured",
        defaultMessage: "A profile’s executable path points into the download",
      }),
    }[inspection.removalBlockedBy[0]!] ?? null
  );
}

export function antigravityRuntimeView(
  input: AntigravityRuntimeViewInput,
  intl: IntlShape,
): RuntimeView {
  const { formatMessage } = intl;
  const inspection = input.state?.inspection;
  const operation = input.state?.operation;
  const retry = (kind: AntigravityRuntimeAction): Action => ({
    kind,
    label: formatMessage({ id: "antigravityRuntime.retry", defaultMessage: "Retry" }),
  });
  if (operation?.phase === "running") {
    const cancel: Action = {
      kind: "cancel",
      label: formatMessage({ id: "antigravityRuntime.cancel", defaultMessage: "Cancel" }),
    };
    return {
      text: input.error?.message ?? progressText(operation, intl),
      primary: operation.cancellable ? cancel : undefined,
      tone: input.error ? "danger" : undefined,
    };
  }
  if (input.pending)
    return {
      text: formatMessage({
        id: "antigravityRuntime.checking",
        defaultMessage: "Checking Antigravity runtime…",
      }),
    };
  const blocked = inspection && removalReason(inspection, intl);
  if (input.error || operation?.phase === "failed") {
    const action = input.error?.action ?? operation?.kind ?? "check";
    const message =
      input.error?.message ??
      operation?.error?.message ??
      formatMessage({
        id: "antigravityRuntime.failed",
        defaultMessage: "Antigravity setup couldn’t finish",
      });
    return {
      text: [message, action === "remove" && blocked].filter(Boolean).join(" · "),
      primary:
        (action === "remove" && !inspection?.canRemove) ||
        (action === "install" && inspection?.platform.supported === false)
          ? undefined
          : retry(action === "read" || action === "cancel" ? "check" : action),
      canRemove: inspection?.canRemove,
      tone: "danger",
    };
  }
  if (!inspection)
    return input.state
      ? {
          text: formatMessage({
            id: "antigravityRuntime.unchecked",
            defaultMessage: "Runtime hasn’t been checked",
          }),
          primary: {
            kind: "check",
            label: formatMessage({
              id: "antigravityRuntime.checkRuntime",
              defaultMessage: "Check runtime",
            }),
          },
        }
      : {
          text: formatMessage({
            id: "antigravityRuntime.checking",
            defaultMessage: "Checking Antigravity runtime…",
          }),
        };
  const executable = inspection.managed ?? inspection.path;
  const version = executable?.version ? formatAntigravityVersion(executable.version, intl) : null;
  const compatibility =
    executable && compatibilityText(executable.version, inspection, intl, !!inspection.managed);
  const source = inspection.managed
    ? formatMessage({ id: "antigravityRuntime.managed", defaultMessage: "Downloaded runtime" })
    : formatMessage({ id: "antigravityRuntime.onPath", defaultMessage: "agy on this computer" });
  const status = executable
    ? [source, version, compatibility?.text]
    : [
        inspection.managedIssue ??
          formatMessage({ id: "antigravityRuntime.missing", defaultMessage: "Not installed" }),
      ];
  if (!inspection.platform.supported)
    status.push(
      formatMessage({
        id: "antigravityRuntime.unsupported",
        defaultMessage:
          "Automatic installation isn’t available on this computer. Set an executable path.",
      }),
    );
  const update = inspection.updateAvailable || !!compatibility;
  const installLabel = inspection.managed
    ? update
      ? formatMessage({ id: "antigravityRuntime.update", defaultMessage: "Update" })
      : formatMessage({
          id: "antigravityRuntime.checkUpdates",
          defaultMessage: "Check for updates",
        })
    : inspection.managedIssue
      ? retry("install").label
      : inspection.path
        ? formatMessage({ id: "antigravityRuntime.download", defaultMessage: "Download" })
        : formatMessage({ id: "antigravityRuntime.install", defaultMessage: "Install" });
  if (inspection.updateAvailable && !compatibility)
    status.push(
      formatMessage({
        id: "antigravityRuntime.updateAvailable",
        defaultMessage: "Update available",
      }),
    );
  return {
    text: [...status, blocked].filter(Boolean).join(" · "),
    primary:
      inspection.platform.supported && !inspection.installing
        ? {
            kind: "install",
            label: installLabel,
            // With agy already here, Nodex's own download is a choice, not the next step.
            optional:
              !inspection.managed &&
              !inspection.managedIssue &&
              !!inspection.path &&
              compatibility?.tone !== "danger",
          }
        : undefined,
    canRemove: inspection.canRemove,
    tone: compatibility?.tone ?? (inspection.managedIssue ? "danger" : undefined),
  };
}

/** A draft path is shown as unchecked until the runtime has inspected the saved value. */
export function antigravityExecutableDescription(
  choice: AntigravityExecutableChoice | undefined,
  inspection: AntigravityRuntimeInspection | null | undefined,
  binaryPath: string | undefined,
  intl: IntlShape,
): string {
  const { formatMessage } = intl;
  const draft = binaryPath?.trim();
  if (draft !== undefined && draft !== (choice?.configuredBinaryPath ?? ""))
    return draft
      ? formatMessage(
          {
            id: "antigravityRuntime.customUnchecked",
            defaultMessage: "Custom executable · {path} · Unchecked",
          },
          { path: draft },
        )
      : formatMessage({
          id: "antigravityRuntime.automaticUnchecked",
          defaultMessage: "Automatic executable · Unchecked",
        });
  if (!choice)
    return formatMessage({
      id: "antigravityRuntime.executableUnchecked",
      defaultMessage: "Executable hasn’t been checked",
    });
  if (choice.source === "unavailable")
    return (
      choice.issue ??
      formatMessage({
        id: "antigravityRuntime.executableUnavailable",
        defaultMessage: "Executable unavailable",
      })
    );
  const source =
    choice.source === "managed"
      ? formatMessage({ id: "antigravityRuntime.managed", defaultMessage: "Downloaded runtime" })
      : choice.source === "path"
        ? formatMessage({ id: "antigravityRuntime.onPath", defaultMessage: "agy on this computer" })
        : formatMessage({ id: "antigravityRuntime.custom", defaultMessage: "Custom executable" });
  return [
    source,
    choice.source === "managed" ? null : choice.executablePath,
    choice.version && formatAntigravityVersion(choice.version, intl),
    inspection &&
      compatibilityText(choice.version, inspection, intl, choice.source === "managed")?.text,
    choice.issue,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Facts from installation inspection, independent of the Agent's account and models. */
export function antigravityInstallationReadiness(
  view: AntigravityRuntimeViewInput,
  instanceId?: string,
) {
  const { inspection, operation } = view.state ?? {};
  const choice = inspection?.instances.find((entry) => entry.instanceId === instanceId);
  const executable = choice
    ? choice.executablePath
      ? choice
      : null
    : (inspection?.managed ?? inspection?.path);
  const found = Boolean(executable);
  if (inspection && executable) {
    const version = antigravityRequiredVersion(executable.version, inspection);
    if (version) return { problem: { kind: "needs-update", version }, found } as const;
  }
  if (
    view.pending === "install" ||
    (operation?.phase === "running" && operation.kind === "install")
  ) {
    const progress = operation?.progress;
    return {
      problem: {
        kind: "installing",
        ...(progress?.totalBytes
          ? { progress: Math.min(1, progress.downloadedBytes / progress.totalBytes) }
          : {}),
      },
      found,
    } as const;
  }
  const failure =
    view.error?.action === "install"
      ? view.error.message
      : operation?.kind === "install" && operation.phase === "failed"
        ? operation.error?.message
        : null;
  if (failure)
    return {
      problem: { kind: "installation-failed", retry: "settings" },
      detail: failure,
      found,
    } as const;
  if (inspection && !executable) return { problem: { kind: "not-installed" }, found } as const;
  return undefined;
}
