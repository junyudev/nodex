import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, subscribeAppUpdateStatus } from "../../lib/api";
import type { AppUpdateSettings, AppUpdateStatus } from "../../lib/types";
import { cn } from "../../lib/utils";

function isAppUpdateSettings(value: unknown): value is AppUpdateSettings {
  return typeof value === "object"
    && value !== null
    && typeof (value as AppUpdateSettings).automaticChecksEnabled === "boolean";
}

function isAppUpdateStatus(value: unknown): value is AppUpdateStatus {
  return typeof value === "object"
    && value !== null
    && typeof (value as AppUpdateStatus).status === "string"
    && typeof (value as AppUpdateStatus).supported === "boolean"
    && typeof (value as AppUpdateStatus).currentVersion === "string";
}

function formatCheckedAtLabel(checkedAt: string | null): string | null {
  if (!checkedAt) {
    return null;
  }

  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return `Last checked ${parsed.toLocaleString()}`;
}

function formatStatusSummary(status: AppUpdateStatus): string {
  if (status.message?.trim()) {
    return status.message.trim();
  }

  switch (status.status) {
    case "unsupported":
      return "App updates are unavailable in this runtime.";
    case "idle":
      return "Automatic background checks are ready.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return status.availableVersion
        ? `Version ${status.availableVersion} is available.`
        : "An update is available.";
    case "downloading":
      return status.progressPercent !== null
        ? `Downloading update… ${status.progressPercent}%`
        : "Downloading update…";
    case "downloaded":
      return status.availableVersion
        ? `Version ${status.availableVersion} is ready to install.`
        : "An update is ready to install.";
    case "upToDate":
      return "You’re up to date.";
    case "error":
      return "Update check failed.";
    default:
      return "App update status unavailable.";
  }
}

const FALLBACK_STATUS: AppUpdateStatus = {
  status: "unsupported",
  supported: false,
  currentVersion: "dev",
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  checkedAt: null,
  message: "App updates are only available in packaged macOS builds.",
};

function SecondaryButton({
  children,
  className,
  disabled,
  onClick,
}: {
  children: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        disabled
          ? "cursor-not-allowed border-(--border) text-(--foreground-tertiary) opacity-60"
          : "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5 hover:text-(--foreground)",
        className,
      )}
    >
      {children}
    </button>
  );
}

function ToggleButton({
  disabled,
  pressed,
  onPressedChange,
}: {
  disabled?: boolean;
  pressed: boolean;
  onPressedChange: (nextValue: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pressed}
      disabled={disabled}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "relative inline-flex h-6 w-10 items-center rounded-full transition-colors",
        "focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30 focus-visible:outline-none",
        disabled
          ? "cursor-not-allowed bg-foreground-5 opacity-60"
          : pressed
            ? "bg-(--accent-blue)"
            : "bg-foreground-5",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 size-5 rounded-full bg-white transition-transform",
          pressed ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function AppUpdateSettingsControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<AppUpdateSettings>({
    automaticChecksEnabled: true,
  });
  const [status, setStatus] = useState<AppUpdateStatus>(FALLBACK_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const [settingsResult, statusResult] = await Promise.all([
        invoke("settings:app-updates:get"),
        invoke("app:update:status"),
      ]);

      if (!isAppUpdateSettings(settingsResult)) {
        throw new Error("Could not load app update settings.");
      }
      if (!isAppUpdateStatus(statusResult)) {
        throw new Error("Could not load app update status.");
      }

      setSettings(settingsResult);
      setStatus(statusResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load app update settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    void load();
    return subscribeAppUpdateStatus((nextStatus) => {
      setStatus(nextStatus);
    });
  }, [load, open]);

  const handleAutomaticChecksChange = useCallback(async (automaticChecksEnabled: boolean) => {
    const previous = settings;
    setSettings({ automaticChecksEnabled });
    setBusy(true);
    setError(null);

    try {
      const result = await invoke("settings:app-updates:update", {
        automaticChecksEnabled,
      });

      if (!isAppUpdateSettings(result)) {
        throw new Error("Could not save app update settings.");
      }

      setSettings(result);
    } catch (err) {
      setSettings(previous);
      setError(err instanceof Error ? err.message : "Could not save app update settings.");
    } finally {
      setBusy(false);
    }
  }, [settings]);

  const handleCheckNow = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await invoke("app:update:check");
      if (!isAppUpdateStatus(result)) {
        throw new Error("Could not check for app updates.");
      }
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for app updates.");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await invoke("app:update:install");
      if (result !== true) {
        throw new Error("Could not restart to install the update.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restart to install the update.");
      setBusy(false);
    }
  }, []);

  const checkedAtLabel = useMemo(
    () => formatCheckedAtLabel(status.checkedAt),
    [status.checkedAt],
  );

  return (
    <div className="flex max-w-80 flex-col items-end gap-2 text-right">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs font-medium text-(--foreground)">
          Nodex {status.currentVersion}
        </span>
        <span className="text-xs text-(--foreground-secondary)">
          Auto check
        </span>
        <ToggleButton
          disabled={busy || !status.supported}
          pressed={settings.automaticChecksEnabled}
          onPressedChange={(nextValue) => {
            void handleAutomaticChecksChange(nextValue);
          }}
        />
      </div>

      <div className="max-w-72 text-xs text-(--foreground-secondary)">
        {formatStatusSummary(status)}
      </div>

      {checkedAtLabel ? (
        <div className="text-[11px] text-(--foreground-tertiary)">
          {checkedAtLabel}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <SecondaryButton
          disabled={busy || !status.supported}
          onClick={() => {
            void handleCheckNow();
          }}
        >
          Check now
        </SecondaryButton>
        {status.status === "downloaded" ? (
          <SecondaryButton
            className="border-(--accent-blue)/30 bg-(--accent-blue)/10 text-(--accent-blue) hover:bg-(--accent-blue)/15"
            disabled={busy}
            onClick={() => {
              void handleInstall();
            }}
          >
            Restart to Update
          </SecondaryButton>
        ) : null}
      </div>

      {error ? (
        <div className="max-w-72 text-xs text-(--red-text)">
          {error}
        </div>
      ) : null}
    </div>
  );
}
