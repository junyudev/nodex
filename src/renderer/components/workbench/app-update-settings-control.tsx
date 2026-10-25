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
import { NodexSettingsRow as SettingRow } from "../ui/settings";
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
    <>
      <SettingRow
        label={`Nodex ${status.currentVersion}`}
        description={
          <>
            {formatStatusSummary(status)}
            {checkedAtLabel ? ` ${checkedAtLabel}.` : null}
            {error ? (
              <span role="alert" className="block text-danger">
                {error}
              </span>
            ) : null}
          </>
        }
      >
        {status.status === "downloaded" ? (
          <NodexButton variant="primary" size="xs" disabled={busy} onClick={onInstall}>
            Restart to update
          </NodexButton>
        ) : status.supported ? (
          <NodexButton
            variant="secondary"
            size="xs"
            disabled={busy || updateAlreadyActive}
            onClick={onCheckNow}
          >
            Check now
          </NodexButton>
        ) : null}
      </SettingRow>
      {status.supported ? (
        <>
          <SettingRow
            label="Check automatically"
            description="Look for updates in the background and download them when they're ready."
          >
            <NodexSwitch
              ariaLabel="Check for updates automatically"
              disabled={busy}
              checked={settings.automaticChecksEnabled}
              onCheckedChange={onAutomaticChecksChange}
            />
          </SettingRow>
          <SettingRow
            label="Update channel"
            description="Nightly gets new builds first. Switching channels never installs an older build."
          >
            <ConfigValueDropdown
              value={settings.channel}
              options={[
                { value: "stable", label: "Stable" },
                { value: "nightly", label: "Nightly" },
              ]}
              disabled={busy || !status.channelChangeAllowed}
              onSelect={onChannelChange}
            />
          </SettingRow>
        </>
      ) : null}
    </>
  );
}

/** Version, update status and update preferences, as rows of the General page's App section. */
export function AppUpdateSettingRows({ open }: { open: boolean }) {
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
