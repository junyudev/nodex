import { FormattedMessage, useIntl } from "@/lib/i18n";
import type { AppUpdateStatus } from "../../lib/types";
import { cn } from "../../lib/utils";

export function AppUpdateRestartNotice({
  onDismiss,
  onRestart,
  status,
}: {
  onDismiss: () => void;
  onRestart: () => void;
  status: AppUpdateStatus;
}) {
  const intl = useIntl();
  if (status.status !== "downloaded") {
    return null;
  }

  const notice = status.availableVersion?.trim()
    ? intl.formatMessage(
        {
          id: "workbench.appUpdateRestartNotice.versionReady",
          defaultMessage: "Nodex {version} is ready.",
        },
        { version: status.availableVersion },
      )
    : intl.formatMessage({
        id: "workbench.appUpdateRestartNotice.updateReady",
        defaultMessage: "A Nodex update is ready.",
      });

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2 py-1",
        "border-token-focus-border/25 bg-text-info/10 text-(--foreground)",
      )}
    >
      <span className="text-xs font-medium">{notice}</span>
      <button
        type="button"
        onClick={onRestart}
        className="rounded-full bg-chart-blue px-2 py-0.5 text-xs font-medium text-(--app-color-text-on-accent) transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
      >
        <FormattedMessage
          id="workbench.appUpdateRestartNotice.restartToUpdate"
          defaultMessage={"Restart to Update"}
        />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-(--foreground-secondary) transition-colors hover:text-(--foreground)"
      >
        <FormattedMessage id="workbench.appUpdateRestartNotice.later" defaultMessage={"Later"} />
      </button>
    </div>
  );
}
