import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
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

function formatCheckedAtLabel(intl: IntlShape, checkedAt: string | null): string | null {
  if (!checkedAt) {
    return null;
  }

  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return intl.formatMessage(
    { id: "settings.appUpdates.lastCheckedAt", defaultMessage: "Last checked {value}." },
    { value: parsed.toLocaleString(intl.locale) },
  );
}

function formatStatusSummary(intl: IntlShape, status: AppUpdateStatus): string {
  switch (status.status) {
    case "unsupported":
      switch (status.unavailableReason) {
        case "unpackaged":
          return intl.formatMessage({
            id: "settings.appUpdates.packagedBuildsOnly",
            defaultMessage: "App updates are only available in packaged builds.",
          });
        case "outsideApplications":
          return intl.formatMessage({
            id: "settings.appUpdates.moveToApplications",
            defaultMessage: "Move Nodex to Applications to enable app updates.",
          });
        case "disabledBuild":
          return intl.formatMessage({
            id: "settings.appUpdates.disabledBuild",
            defaultMessage: "App updates are disabled in this build.",
          });
        case "unsupportedPlatform":
          return intl.formatMessage({
            id: "settings.appUpdates.unsupportedPlatform",
            defaultMessage: "App updates are unavailable on this platform.",
          });
      }
      return intl.formatMessage({
        id: "settings.appUpdates.appUpdatesAreUnavailableInThis",
        defaultMessage: "App updates are unavailable in this runtime.",
      });
    case "idle":
      return intl.formatMessage({
        id: "settings.appUpdates.automaticBackgroundChecksAreReady",
        defaultMessage: "Automatic background checks are ready.",
      });
    case "checking":
      return intl.formatMessage({
        id: "settings.appUpdates.checkingForUpdates",
        defaultMessage: "Checking for updates…",
      });
    case "available":
      return status.channel === "nightly" && status.availableVersion
        ? intl.formatMessage(
            {
              id: "settings.appUpdates.versionFound",
              defaultMessage:
                "Version {availableVersion} is available. Downloading in the background…",
            },
            { availableVersion: status.availableVersion },
          )
        : intl.formatMessage({
            id: "settings.appUpdates.updateFound",
            defaultMessage: "Update found. Downloading in the background…",
          });
    case "downloading":
      return intl.formatMessage({
        id: "settings.appUpdates.downloadingUpdate2",
        defaultMessage: "Downloading update…",
      });
    case "downloaded":
      return status.channel === "nightly" && status.availableVersion
        ? intl.formatMessage(
            {
              id: "settings.appUpdates.versionReady",
              defaultMessage: "Version {availableVersion} is ready. Restart Nodex to install it.",
            },
            { availableVersion: status.availableVersion },
          )
        : intl.formatMessage({
            id: "settings.appUpdates.updateReady",
            defaultMessage: "Update ready. Restart Nodex to install it.",
          });
    case "installing":
      return intl.formatMessage({
        id: "settings.appUpdates.installingUpdate",
        defaultMessage: "Installing update…",
      });
    case "upToDate":
      return intl.formatMessage({
        id: "settings.appUpdates.youreUpToDate",
        defaultMessage: "You’re up to date.",
      });
    case "error":
      return (
        status.message?.trim() ||
        intl.formatMessage({
          id: "settings.appUpdates.updateCheckFailed",
          defaultMessage: "Update check failed.",
        })
      );
    default:
      return intl.formatMessage({
        id: "settings.appUpdates.appUpdateStatusUnavailable",
        defaultMessage: "App update status unavailable.",
      });
  }
}

const FALLBACK_STATUS: AppUpdateStatus = {
  status: "unsupported",
  supported: false,
  unavailableReason: "unpackaged",
  currentVersion: "dev",
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  checkedAt: null,
  message: null,
  channel: "stable",
  channelChangeAllowed: false,
};

async function restartForAppUpdate(): Promise<void> {
  const result = await installAppUpdate();
  if (result !== true)
    throw new Error(
      getIntl().formatMessage({
        id: "settings.appUpdates.couldNotRestartToInstallThe",
        defaultMessage: "Could not restart to install the update.",
      }),
    );
}

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
  const intl = useIntl();
  const updatesAvailable = readSettingsHostPresentation().appUpdates;
  const checkedAtLabel = formatCheckedAtLabel(intl, status.checkedAt);
  const updateAlreadyActive =
    status.status === "checking" ||
    status.status === "downloading" ||
    status.status === "downloaded" ||
    status.status === "installing";

  return (
    <>
      <SettingRow
        label={intl.formatMessage(
          { id: "settings.appUpdates.version", defaultMessage: "Nodex {version}" },
          { version: status.currentVersion },
        )}
        description={
          updatesAvailable ? (
            <>
              {formatStatusSummary(intl, status)}
              {checkedAtLabel ? ` ${checkedAtLabel}` : null}
              {error ? (
                <span role="alert" className="block text-danger">
                  {error}
                </span>
              ) : null}
            </>
          ) : undefined
        }
      >
        {updatesAvailable && status.status === "downloaded" ? (
          <NodexButton variant="primary" size="toolbar" disabled={busy} onClick={onInstall}>
            {intl.formatMessage(settingsMessages.appUpdatesRestartToUpdate)}
          </NodexButton>
        ) : updatesAvailable && status.supported ? (
          <NodexButton
            variant="secondary"
            size="toolbar"
            disabled={busy || updateAlreadyActive}
            onClick={onCheckNow}
          >
            {intl.formatMessage(settingsMessages.appUpdatesCheckNow)}
          </NodexButton>
        ) : null}
      </SettingRow>
      {updatesAvailable && status.supported ? (
        <>
          <SettingRow
            label={intl.formatMessage(settingsMessages.appUpdatesCheckAutomatically)}
            description={intl.formatMessage(
              settingsMessages.appUpdatesLookForUpdatesInTheBackground,
            )}
          >
            <NodexSwitch
              ariaLabel={intl.formatMessage({
                id: "settings.appUpdates.checkForUpdatesAutomatically",
                defaultMessage: "Check for updates automatically",
              })}
              disabled={busy}
              checked={settings.automaticChecksEnabled}
              onCheckedChange={onAutomaticChecksChange}
            />
          </SettingRow>
          <SettingRow
            label={intl.formatMessage(settingsMessages.appUpdatesUpdateChannel)}
            description={intl.formatMessage(
              settingsMessages.appUpdatesNightlyGetsNewBuildsFirstSwitching,
            )}
          >
            <ConfigValueDropdown
              value={settings.channel}
              options={[
                { value: "stable", label: intl.formatMessage(settingsMessages.appUpdatesStable) },
                { value: "nightly", label: intl.formatMessage(settingsMessages.appUpdatesNightly) },
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
  const [status, setStatus] = useState<AppUpdateStatus>(sharedStatus ?? FALLBACK_STATUS);
  const [busy, setBusy] = useState(open);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const request = async () => Promise.all([readAppUpdateSettings(), readAppUpdateStatus()]);
    return request()
      .then(([settingsResult, statusResult]) => {
        if (!isAppUpdateSettings(settingsResult))
          throw new Error(
            getIntl().formatMessage({
              id: "settings.appUpdates.couldNotLoadAppUpdateSettings",
              defaultMessage: "Could not load app update settings.",
            }),
          );
        if (!isAppUpdateStatus(statusResult))
          throw new Error(
            getIntl().formatMessage({
              id: "settings.appUpdates.couldNotLoadAppUpdateStatus",
              defaultMessage: "Could not load app update status.",
            }),
          );
        setSettings(settingsResult);
        setStatus(statusResult);
      })
      .catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : getIntl().formatMessage({
                id: "settings.appUpdates.couldNotLoadAppUpdateSettings",
                defaultMessage: "Could not load app update settings.",
              }),
        ),
      )
      .finally(() => setBusy(false));
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

  const [loadInput, setLoadInput] = useState({ open, sharedStatus });
  if (loadInput.open !== open || loadInput.sharedStatus !== sharedStatus) {
    setLoadInput({ open, sharedStatus });
    if (open) {
      setBusy(true);
      setError(null);
    }
    if (sharedStatus) setStatus(sharedStatus);
  }

  const handleAutomaticChecksChange = useCallback(
    async (automaticChecksEnabled: boolean) => {
      const previous = settings;
      setSettings({ ...settings, automaticChecksEnabled });
      setBusy(true);
      setError(null);

      return runWithCleanup(
        async () => {
          const result = await updateAppUpdateSettings({
            automaticChecksEnabled,
          });

          if (!isAppUpdateSettings(result)) {
            throw new Error(
              getIntl().formatMessage({
                id: "settings.appUpdates.couldNotSaveAppUpdateSettings",
                defaultMessage: "Could not save app update settings.",
              }),
            );
          }

          setSettings(result);
        },
        {
          cleanup: () => setBusy(false),
          onError: (err) => {
            setSettings(previous);
            setError(
              err instanceof Error
                ? err.message
                : getIntl().formatMessage({
                    id: "settings.appUpdates.couldNotSaveAppUpdateSettings",
                    defaultMessage: "Could not save app update settings.",
                  }),
            );
          },
        },
      );
    },
    [settings],
  );

  const handleChannelChange = useCallback(
    async (channel: string) => {
      if (channel !== "stable" && channel !== "nightly") return;
      const previous = settings;
      setBusy(true);
      setError(null);
      return runWithCleanup(
        async () => {
          const result = await updateAppUpdateSettings({ channel });
          if (!isAppUpdateSettings(result))
            throw new Error(
              getIntl().formatMessage({
                id: "settings.appUpdates.couldNotSaveUpdateChannel",
                defaultMessage: "Could not save update channel.",
              }),
            );
          setSettings(result);
        },
        {
          cleanup: () => setBusy(false),
          onError: (err) => {
            setSettings(previous);
            setError(
              err instanceof Error
                ? err.message
                : getIntl().formatMessage({
                    id: "settings.appUpdates.couldNotSaveUpdateChannel",
                    defaultMessage: "Could not save update channel.",
                  }),
            );
          },
        },
      );
    },
    [settings],
  );

  const handleCheckNow = useCallback(async () => {
    setBusy(true);
    setError(null);

    return runWithCleanup(
      async () => {
        const result = await checkForAppUpdate();
        if (!isAppUpdateStatus(result)) {
          throw new Error(
            getIntl().formatMessage({
              id: "settings.appUpdates.couldNotCheckForAppUpdates",
              defaultMessage: "Could not check for app updates.",
            }),
          );
        }
        setStatus(result);
      },
      {
        cleanup: () => setBusy(false),
        onError: (err) => {
          setError(
            err instanceof Error
              ? err.message
              : getIntl().formatMessage({
                  id: "settings.appUpdates.couldNotCheckForAppUpdates",
                  defaultMessage: "Could not check for app updates.",
                }),
          );
        },
      },
    );
  }, []);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      await restartForAppUpdate();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : getIntl().formatMessage({
              id: "settings.appUpdates.couldNotRestartToInstallThe",
              defaultMessage: "Could not restart to install the update.",
            }),
      );
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
