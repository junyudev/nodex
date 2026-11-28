import { NodexButton } from "@/components/ui/button";
import { formatBytes } from "@/lib/file-metadata-format";
import { defineMessages, useIntl, type IntlShape } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AppComponentId } from "../../../shared/app-components";
import { appComponentCanRetry, type AppComponentStatus } from "./app-component-status";

export const APP_COMPONENT_NAMES = defineMessages({
  "desktop-tools": { id: "appComponents.desktopTools.name", defaultMessage: "Desktop Tools" },
  codex: { id: "appComponents.codex.name", defaultMessage: "Codex" },
  "claude-code": { id: "appComponents.claudeCode.name", defaultMessage: "Claude Code" },
  "document-tools": { id: "appComponents.documentTools.name", defaultMessage: "Document Tools" },
}) satisfies Record<AppComponentId, unknown>;

const failures = defineMessages({
  integrity: {
    id: "appComponents.failure.integrity",
    defaultMessage: "The download was damaged.",
  },
  "disk-space": {
    id: "appComponents.failure.diskSpace",
    defaultMessage: "Not enough free space.",
  },
  location: {
    id: "appComponents.failure.location",
    defaultMessage: "This Profile’s folder isn’t private.",
  },
  rejected: {
    id: "appComponents.failure.rejected",
    defaultMessage: "This version of Nodex couldn’t use the download.",
  },
  unknown: {
    id: "appComponents.failure.unknown",
    defaultMessage: "Couldn’t install.",
  },
});

function statusText(intl: IntlShape, status: AppComponentStatus): string {
  switch (status.kind) {
    case "installed":
      return formatBytes(status.bytes);
    case "not-installed":
      return intl.formatMessage(
        { id: "appComponents.status.downloadSize", defaultMessage: "{size} download" },
        { size: formatBytes(status.downloadBytes) },
      );
    case "on-demand":
      return intl.formatMessage(
        {
          id: "appComponents.status.onDemand",
          defaultMessage: "Installs on first use · {size}",
        },
        { size: formatBytes(status.downloadBytes) },
      );
    case "queued":
      return intl.formatMessage({
        id: "appComponents.status.queued",
        defaultMessage: "Waiting to download",
      });
    case "downloading":
      return intl.formatMessage(
        {
          id: "appComponents.status.downloading",
          defaultMessage: "Downloading {percent} of {size}",
        },
        {
          percent: intl.formatNumber(status.fraction, { style: "percent" }),
          size: formatBytes(status.totalBytes),
        },
      );
    case "installing":
      return intl.formatMessage({
        id: "appComponents.status.installing",
        defaultMessage: "Installing…",
      });
    case "retrying":
      return intl.formatMessage({
        id: "appComponents.status.retrying",
        defaultMessage: "Couldn’t download. Trying again soon.",
      });
    case "failed":
      return intl.formatMessage(failures[status.reason]);
    case "removal-pending":
      return intl.formatMessage({
        id: "appComponents.status.removalPending",
        defaultMessage: "Removed when Nodex restarts",
      });
  }
}

/** What is true of a component now, in one quiet line. Only a standing failure takes danger. */
export function AppComponentStatusLine({ status }: { status: AppComponentStatus }) {
  const intl = useIntl();
  return (
    <span
      role={status.kind === "failed" ? "alert" : "status"}
      className={cn(
        "min-w-0 text-xs tabular-nums",
        status.kind === "failed" ? "text-danger" : "text-token-text-secondary",
      )}
    >
      {statusText(intl, status)}
    </span>
  );
}

export function AppComponentRetryButton({
  status,
  disabled,
  onRetry,
}: {
  status: AppComponentStatus;
  disabled: boolean;
  onRetry: () => void;
}) {
  const intl = useIntl();
  if (!appComponentCanRetry(status)) return null;
  return (
    <NodexButton size="xs" variant="secondary" disabled={disabled} onClick={onRetry}>
      {status.kind === "retrying"
        ? intl.formatMessage({ id: "appComponents.tryNow", defaultMessage: "Try now" })
        : intl.formatMessage({ id: "appComponents.tryAgain", defaultMessage: "Try again" })}
    </NodexButton>
  );
}
