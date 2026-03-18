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
  if (status.status !== "downloaded") {
    return null;
  }

  const versionLabel = status.availableVersion?.trim()
    ? `Nodex ${status.availableVersion}`
    : "A Nodex update";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2 py-1",
        "border-(--accent-blue)/25 bg-(--accent-blue)/10 text-(--foreground)",
      )}
    >
      <span className="text-xs font-medium">
        {versionLabel} is ready.
      </span>
      <button
        type="button"
        onClick={onRestart}
        className="rounded-full bg-(--accent-blue) px-2 py-0.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
      >
        Restart to Update
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-(--foreground-secondary) transition-colors hover:text-(--foreground)"
      >
        Later
      </button>
    </div>
  );
}
