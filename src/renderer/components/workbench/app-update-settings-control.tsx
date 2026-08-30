import { useCallback, useEffect, useState } from "react";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import type { AppUpdateSettings, AppUpdateStatus } from "../../lib/types";
import {
  checkForAppUpdate,
  installAppUpdate,
  readAppUpdateSettings,
  readAppUpdateStatus,
  subscribeAppUpdateStatus,
  updateAppUpdateSettings,
} from "./app-update-settings-control-deps";
import { useAppUpdateStatus } from "../../app-providers";
import { ConfigValueDropdown } from "./config-value-dropdown";

function isAppUpdateSettings(value: unknown): value is AppUpdateSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppUpdateSettings).automaticChecksEnabled === "boolean" &&
    ((value as AppUpdateSettings).channel === "stable" ||
      (value as AppUpdateSettings).channel === "nightly")
  );
}

function isAppUpdateStatus(value: unknown): value is AppUpdateStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppUpdateStatus).status === "string" &&
    typeof (value as AppUpdateStatus).supported === "boolean" &&
    typeof (value as AppUpdateStatus).currentVersion === "string"
  );
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
    case "installing":
      return "Installing update…";
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
  channel: "stable",
  buildDefaultChannel: "stable",
  channelChangeAllowed: false,
};

export function AppUpdateSettingsControlView({
  busy,
  error,
  onAutomaticChecksChange,
  onChannelChange,
  onCheckNow,
  onInstall,
  settings,
  status,
}: {
  busy: boolean;
  error: string | null;
  onAutomaticChecksChange: (enabled: boolean) => void;
  onChannelChange: (channel: string) => void;
  onCheckNow: () => void;
  onInstall: () => void;
  settings: AppUpdateSettings;
  status: AppUpdateStatus;
}) {
  const checkedAtLabel = formatCheckedAtLabel(status.checkedAt);
  const updateAlreadyActive =
    status.status === "checking" ||
    status.status === "downloading" ||
    status.status === "downloaded" ||
    status.status === "installing";

  return (
    <div className="flex max-w-80 flex-col items-end gap-2 text-right">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs font-medium text-(--foreground)">
          Nodex {status.currentVersion}
        </span>
        <span className="text-xs text-(--foreground-secondary)">Auto check</span>
        <NodexSwitch
          ariaLabel="Auto check"
          disabled={busy || !status.supported}
          checked={settings.automaticChecksEnabled}
          onCheckedChange={onAutomaticChecksChange}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-(--foreground-secondary)">Channel</span>
        <ConfigValueDropdown
          value={settings.channel}
          options={[
            { value: "stable", label: "Stable — Recommended" },
            { value: "nightly", label: "Nightly" },
          ]}
          disabled={busy || !status.channelChangeAllowed}
          onSelect={onChannelChange}
        />
      </div>
      <div className="max-w-72 text-[11px] text-(--foreground-tertiary)">
        Nightly receives new mainline builds first. Switching channels does not install an older
        build.
      </div>
      <div className="max-w-72 text-xs text-(--foreground-secondary)">
        {formatStatusSummary(status)}
      </div>
      {checkedAtLabel ? (
        <div className="text-[11px] text-(--foreground-tertiary)">{checkedAtLabel}</div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <NodexButton
          variant="outline"
          size="xs"
          disabled={busy || !status.supported || updateAlreadyActive}
          onClick={onCheckNow}
        >
          Check now
        </NodexButton>
        {status.status === "downloaded" ? (
          <NodexButton
            variant="secondary"
            size="xs"
            className="border-(--accent-blue)/30 bg-(--accent-blue)/10 text-(--accent-blue) hover:bg-(--accent-blue)/15 hover:text-(--accent-blue)"
            disabled={busy}
            onClick={onInstall}
          >
            Restart to Update
          </NodexButton>
        ) : null}
      </div>
      {error ? <div className="max-w-72 text-xs text-(--red-text)">{error}</div> : null}
    </div>
  );
}

export function AppUpdateSettingsControl({ open }: { open: boolean }) {
  const sharedStatus = useAppUpdateStatus();
  const [settings, setSettings] = useState<AppUpdateSettings>({
    automaticChecksEnabled: true,
    channel: "stable",
  });
  const [status, setStatus] = useState<AppUpdateStatus>(FALLBACK_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const [settingsResult, statusResult] = await Promise.all([
        readAppUpdateSettings(),
        readAppUpdateStatus(),
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
    if (sharedStatus) return;
    return subscribeAppUpdateStatus((nextStatus) => {
      setStatus(nextStatus);
    });
  }, [load, open, sharedStatus]);

  useEffect(() => {
    if (sharedStatus) setStatus(sharedStatus);
  }, [sharedStatus]);

  const handleAutomaticChecksChange = useCallback(
    async (automaticChecksEnabled: boolean) => {
      const previous = settings;
      setSettings({ ...settings, automaticChecksEnabled });
      setBusy(true);
      setError(null);

      try {
        const result = await updateAppUpdateSettings({
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
    },
    [settings],
  );

  const handleChannelChange = useCallback(
    async (channel: string) => {
      if (channel !== "stable" && channel !== "nightly") return;
      const previous = settings;
      setBusy(true);
      setError(null);
      try {
        const result = await updateAppUpdateSettings({ channel });
        if (!isAppUpdateSettings(result)) throw new Error("Could not save update channel.");
        setSettings(result);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save update channel.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const handleCheckNow = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await checkForAppUpdate();
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
      const result = await installAppUpdate();
      if (result !== true) {
        throw new Error("Could not restart to install the update.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restart to install the update.");
      setBusy(false);
    }
  }, []);

  return (
    <AppUpdateSettingsControlView
      busy={busy}
      error={error}
      onAutomaticChecksChange={(value) => {
        void handleAutomaticChecksChange(value);
      }}
      onChannelChange={(value) => {
        void handleChannelChange(value);
      }}
      onCheckNow={() => {
        void handleCheckNow();
      }}
      onInstall={() => {
        void handleInstall();
      }}
      settings={settings}
      status={status}
    />
  );
}
