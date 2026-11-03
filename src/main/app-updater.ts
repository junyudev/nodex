export type AppUpdaterCheckKind = "background" | "user";
export type AppUpdateChannel = "stable" | "nightly";

export type AppUpdaterEvent =
  | { readonly type: "check-started"; readonly kind: AppUpdaterCheckKind }
  | {
      readonly type: "update-found";
      readonly version: string;
      readonly buildVersion: string;
      readonly releaseName?: string;
      readonly releaseDate?: string;
      readonly releaseNotes?: string;
    }
  | { readonly type: "download-started"; readonly expectedBytes: number | null }
  | {
      readonly type: "download-progress";
      readonly receivedBytes: number;
      readonly expectedBytes: number | null;
    }
  | {
      readonly type: "update-ready";
      readonly version: string;
      readonly buildVersion: string;
      readonly releaseName?: string;
      readonly releaseDate?: string;
      readonly releaseNotes?: string;
    }
  | { readonly type: "installing" }
  | { readonly type: "up-to-date"; readonly version: string }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };

/** Synchronous capabilities exposed by one Scope-owned platform lease. */
export interface AppUpdaterSession {
  readonly check: (kind: AppUpdaterCheckKind) => void;
  readonly installDownloadedUpdate: () => void;
  /** Capture a verified handoff before release; invoke only after graceful runtime shutdown. */
  readonly prepareQuit?: () => (() => void | Promise<void>) | null;
  readonly setChannel: (channel: AppUpdateChannel) => void;
}

/**
 * Stateless packaged-runtime descriptor. Acquiring it creates the only native
 * updater lease; the caller must register `release` in its owning Scope.
 */
export interface AppUpdaterPlatform {
  readonly buildDefaultChannel: AppUpdateChannel;
  readonly acquire: (
    channel: AppUpdateChannel,
    onEvent: (event: AppUpdaterEvent) => void,
  ) => {
    readonly release: () => void | Promise<void>;
    readonly session: AppUpdaterSession;
  };
}
