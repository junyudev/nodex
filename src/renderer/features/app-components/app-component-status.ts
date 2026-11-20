import type { AppComponentFailureReason, AppComponentState } from "../../../shared/app-components";

/** What one component's row says and offers, derived from the person's choice and the install. */
export type AppComponentStatus =
  | { readonly kind: "installed"; readonly bytes: number }
  | { readonly kind: "removal-pending" }
  | { readonly kind: "not-installed"; readonly downloadBytes: number }
  /** Turned on and waiting for the first feature that needs it. */
  | { readonly kind: "on-demand"; readonly downloadBytes: number }
  | { readonly kind: "queued" }
  | {
      readonly kind: "downloading";
      /** 0 to 1. */
      readonly fraction: number;
      readonly totalBytes: number;
    }
  | { readonly kind: "installing" }
  /** Nodex will try again by itself; a person may hurry it. */
  | { readonly kind: "retrying" }
  /** Nothing more happens until a person retries. */
  | {
      readonly kind: "failed";
      readonly reason: Exclude<AppComponentFailureReason, "network">;
      readonly message: string;
    };

export function appComponentStatus(component: AppComponentState): AppComponentStatus {
  if (component.removalPending) return { kind: "removal-pending" };
  const { installation } = component;
  switch (installation.status) {
    case "installed":
      return { kind: "installed", bytes: installation.installedBytes };
    case "not-installed":
      // Turned on with nothing started yet reads as waiting, never as a size to opt into.
      return component.enabled
        ? { kind: "queued" }
        : { kind: "not-installed", downloadBytes: component.downloadBytes };
    case "on-demand":
      return { kind: "on-demand", downloadBytes: component.downloadBytes };
    case "queued":
      return { kind: "queued" };
    case "downloading":
      return {
        kind: "downloading",
        fraction:
          installation.totalBytes > 0
            ? Math.min(1, Math.max(0, installation.receivedBytes / installation.totalBytes))
            : 0,
        totalBytes: installation.totalBytes,
      };
    case "installing":
      return { kind: "installing" };
    case "failed":
      if (installation.retryAt !== null) return { kind: "retrying" };
      return {
        kind: "failed",
        reason: installation.reason === "network" ? "unknown" : installation.reason,
        message: installation.message,
      };
  }
}

/** The row's hairline bar: download progress, then full while files are unpacked and checked. */
export function appComponentProgress(status: AppComponentStatus): number | null {
  if (status.kind === "downloading") return status.fraction;
  if (status.kind === "installing") return 1;
  return null;
}

export const appComponentCanRetry = (status: AppComponentStatus): boolean =>
  status.kind === "retrying" || status.kind === "failed";
