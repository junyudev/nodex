import { formatAppVersion } from "../../shared/app-version";
import { hostCapabilities } from "../../shared/host-capabilities";
import type { AppUpdateSettings, AppUpdateStatus } from "../../shared/types";
import type { AppUpdaterEvent } from "../app-updater";

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

const unavailableReason = (input: {
  readonly architecture?: string;
  readonly isInApplicationsFolder: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly updaterAvailable: boolean;
}): NonNullable<AppUpdateStatus["unavailableReason"]> => {
  if (input.isPackaged && input.platform === "darwin" && !input.isInApplicationsFolder) {
    return "outsideApplications";
  }
  if (
    input.isPackaged &&
    hostCapabilities(input.platform, input.architecture).autoUpdate &&
    !input.updaterAvailable
  ) {
    return "disabledBuild";
  }
  return input.isPackaged ? "unsupportedPlatform" : "unpackaged";
};

export const initialAppUpdateState = (input: {
  readonly currentVersion: string;
  readonly architecture?: string;
  readonly isInApplicationsFolder: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly settings: AppUpdateSettings;
  readonly updaterAvailable: boolean;
}): AppUpdateRuntimeState => {
  const supported =
    input.isPackaged &&
    hostCapabilities(input.platform, input.architecture).autoUpdate &&
    (input.platform !== "darwin" || input.isInApplicationsFolder) &&
    input.updaterAvailable;
  return {
    applicationReady: false,
    automaticCheckStarted: false,
    errorAllowsChannelChange: false,
    settings: input.settings,
    status: {
      availableVersion: null,
      channel: input.settings.channel,
      channelChangeAllowed: supported,
      checkedAt: null,
      currentVersion: input.currentVersion,
      message: null,
      progressPercent: null,
      releaseDate: null,
      releaseName: null,
      releaseNotes: null,
      status: supported ? "idle" : "unsupported",
      supported,
      totalBytes: null,
      transferredBytes: null,
      ...(supported ? {} : { unavailableReason: unavailableReason(input) }),
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
  event: AppUpdaterEvent,
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
        message: null,
        progressPercent: null,
        status: "checking",
        totalBytes: null,
        transferredBytes: null,
      };
    case "update-found": {
      const version = formatAppVersion(
        event.version,
        status.channel === "nightly" ? event.buildVersion : undefined,
      );
      return {
        ...status,
        availableVersion: version,
        checkedAt,
        message: null,
        releaseDate: event.releaseDate ?? null,
        releaseName: event.releaseName ?? null,
        releaseNotes: event.releaseNotes?.trim() || null,
        status: "available",
      };
    }
    case "download-started":
      return {
        ...status,
        message: null,
        progressPercent: 0,
        status: "downloading",
        totalBytes: event.expectedBytes,
        transferredBytes: 0,
      };
    case "download-progress":
      if (status.status !== "downloading" && status.status !== "available") return status;
      return {
        ...status,
        message: null,
        progressPercent: roundProgressPercent(event.receivedBytes, event.expectedBytes),
        status: "downloading",
        totalBytes: event.expectedBytes,
        transferredBytes: event.receivedBytes,
      };
    case "update-ready": {
      const totalBytes = status.totalBytes;
      const version = event.version
        ? formatAppVersion(
            event.version,
            status.channel === "nightly" ? event.buildVersion : undefined,
          )
        : status.availableVersion;
      return {
        ...status,
        availableVersion: version,
        checkedAt,
        message: null,
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
      return { ...status, message: null, status: "installing" };
    case "up-to-date":
      return {
        ...status,
        availableVersion: null,
        checkedAt,
        message: null,
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
