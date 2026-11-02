import { hostCapabilities } from "../../shared/host-capabilities";
import type { AppUpdateSettings, AppUpdateStatus } from "../../shared/types";
import type { MacAppUpdaterEvent } from "../mac-app-updater";

export interface AppUpdateRuntimeState {
  readonly applicationReady: boolean;
  readonly automaticCheckStarted: boolean;
  readonly errorAllowsChannelChange: boolean;
  readonly settings: AppUpdateSettings;
  readonly status: AppUpdateStatus;
}

const roundProgressPercent = (received: number, total: number | null): number | null => {
  if (total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((received / total) * 10_000) / 100));
};

const unsupportedRuntimeMessage = (input: {
  readonly isInApplicationsFolder: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly updaterAvailable: boolean;
}): string => {
  if (
    input.isPackaged &&
    hostCapabilities(input.platform).autoUpdate &&
    !input.isInApplicationsFolder
  ) {
    return "Move Nodex to Applications to enable app updates.";
  }
  if (input.isPackaged && hostCapabilities(input.platform).autoUpdate && !input.updaterAvailable) {
    return "App updates are disabled in this build.";
  }
  return "App updates are only available in packaged macOS builds.";
};

export const initialAppUpdateState = (input: {
  readonly buildDefaultChannel: AppUpdateSettings["channel"];
  readonly currentVersion: string;
  readonly isInApplicationsFolder: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly settings: AppUpdateSettings;
  readonly updaterAvailable: boolean;
}): AppUpdateRuntimeState => {
  const supported =
    input.isPackaged &&
    hostCapabilities(input.platform).autoUpdate &&
    input.isInApplicationsFolder &&
    input.updaterAvailable;
  return {
    applicationReady: false,
    automaticCheckStarted: false,
    errorAllowsChannelChange: false,
    settings: input.settings,
    status: {
      availableVersion: null,
      buildDefaultChannel: input.buildDefaultChannel,
      channel: input.settings.channel,
      channelChangeAllowed: supported,
      checkedAt: null,
      currentVersion: input.currentVersion,
      message: supported ? null : unsupportedRuntimeMessage(input),
      progressPercent: null,
      releaseDate: null,
      releaseName: null,
      releaseNotes: null,
      status: supported ? "idle" : "unsupported",
      supported,
      totalBytes: null,
      transferredBytes: null,
    },
  };
};

export const withChannelChangeAvailability = (
  status: AppUpdateStatus,
  errorAllowsChannelChange: boolean,
): AppUpdateStatus => ({
  ...status,
  channelChangeAllowed:
    status.supported &&
    (status.status === "idle" ||
      status.status === "upToDate" ||
      (status.status === "error" && errorAllowsChannelChange)),
});

export const reduceAppUpdateStatus = (
  status: AppUpdateStatus,
  event: MacAppUpdaterEvent,
  checkedAt: string,
): AppUpdateStatus => {
  if (!status.supported) return status;
  switch (event.type) {
    case "check-started":
      if (
        status.status === "downloading" ||
        status.status === "downloaded" ||
        status.status === "installing"
      ) {
        return status;
      }
      return {
        ...status,
        message: "Checking for updates…",
        progressPercent: null,
        status: "checking",
        totalBytes: null,
        transferredBytes: null,
      };
    case "update-found":
      return {
        ...status,
        availableVersion: event.version,
        checkedAt,
        message: "Update found. Downloading in the background…",
        releaseDate: event.releaseDate ?? null,
        releaseName: event.releaseName ?? null,
        releaseNotes: event.releaseNotes?.trim() || null,
        status: "available",
      };
    case "download-started":
      return {
        ...status,
        message: "Downloading update…",
        progressPercent: 0,
        status: "downloading",
        totalBytes: event.expectedBytes,
        transferredBytes: 0,
      };
    case "download-progress":
      if (status.status !== "downloading" && status.status !== "available") return status;
      return {
        ...status,
        message: "Downloading update…",
        progressPercent: roundProgressPercent(event.receivedBytes, event.expectedBytes),
        status: "downloading",
        totalBytes: event.expectedBytes,
        transferredBytes: event.receivedBytes,
      };
    case "update-ready": {
      const totalBytes = status.totalBytes;
      return {
        ...status,
        availableVersion: event.version || status.availableVersion,
        checkedAt,
        message: "Update ready. Restart Nodex to install it.",
        progressPercent: 100,
        releaseDate: event.releaseDate ?? status.releaseDate,
        releaseName: event.releaseName ?? status.releaseName,
        releaseNotes: event.releaseNotes?.trim() || status.releaseNotes,
        status: "downloaded",
        transferredBytes: totalBytes ?? status.transferredBytes,
      };
    }
    case "installing":
      if (status.status !== "downloaded" && status.status !== "installing") return status;
      return { ...status, message: "Installing update…", status: "installing" };
    case "up-to-date":
      return {
        ...status,
        availableVersion: null,
        checkedAt,
        message: "You’re up to date.",
        progressPercent: null,
        releaseDate: null,
        releaseName: null,
        releaseNotes: null,
        status: "upToDate",
        totalBytes: null,
        transferredBytes: null,
      };
    case "error":
      return {
        ...status,
        checkedAt,
        message: event.message,
        status: "error",
      };
  }
};

export const resetStatusForChannel = (
  status: AppUpdateStatus,
  channel: AppUpdateSettings["channel"],
): AppUpdateStatus => ({
  ...status,
  availableVersion: null,
  channel,
  checkedAt: null,
  message: null,
  progressPercent: null,
  releaseDate: null,
  releaseName: null,
  releaseNotes: null,
  status: "idle",
  totalBytes: null,
  transferredBytes: null,
});
