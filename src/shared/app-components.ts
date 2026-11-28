import type { CodexPackageUnavailableReason } from "../../packages/agent-runtime/vendor/contracts/src/providerInstance";

export type CodexComponentUnavailableReason = Exclude<
  CodexPackageUnavailableReason,
  "external-unusable"
>;

/**
 * Components are parts of Nodex that install after the app does. Each one is a sealed archive
 * the app's own release lock pins by size and SHA-256, so the installer and every update stay
 * small, and a person can remove a part they do not use.
 */
export const APP_COMPONENT_IDS = [
  "desktop-tools",
  "codex",
  "claude-code",
  "document-tools",
] as const;
export type AppComponentId = (typeof APP_COMPONENT_IDS)[number];

export const isAppComponentId = (value: unknown): value is AppComponentId =>
  typeof value === "string" && (APP_COMPONENT_IDS as readonly string[]).includes(value);

export type AppComponentFailureReason =
  /** The download could not start or finish; Nodex retries by itself. */
  | "network"
  /** The downloaded or installed bytes differ from the release lock. */
  | "integrity"
  /** The volume holding the Profile has too little free space. */
  | "disk-space"
  /** Other accounts can change the Profile's folder, so Components cannot be kept private there. */
  | "location"
  /** The files installed correctly, and this build of Nodex refused to load them. */
  | "rejected"
  | "unknown";

export type AppComponentInstallation =
  /** Turned off. */
  | { readonly status: "not-installed" }
  /** Turned on, and nothing on this computer has needed it yet. It installs on first use. */
  | { readonly status: "on-demand" }
  /** Waiting for its turn or for the next automatic retry. */
  | { readonly status: "queued" }
  | {
      readonly status: "downloading";
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  /** Unpacking and verifying every file against the lock. */
  | { readonly status: "installing" }
  | { readonly status: "installed"; readonly installedBytes: number }
  | {
      readonly status: "failed";
      readonly reason: AppComponentFailureReason;
      readonly message: string;
      /** Epoch milliseconds of the next automatic attempt, or null when only a person can retry. */
      readonly retryAt: number | null;
    };

export interface AppComponentState {
  readonly id: AppComponentId;
  /** The person's choice: on keeps the component installed, off removes it. */
  readonly enabled: boolean;
  /** Size of the archive Nodex downloads to install it. */
  readonly downloadBytes: number;
  readonly installation: AppComponentInstallation;
  /**
   * The component was turned off while this process was using its files. They stay in place
   * until Nodex next starts, and turning it back on before then keeps them.
   */
  readonly removalPending: boolean;
}

/** Components this build installs after the app; empty where everything ships inside it. */
export interface AppComponentsState {
  readonly revision: number;
  readonly components: readonly AppComponentState[];
}

export interface SetAppComponentEnabledInput {
  readonly id: AppComponentId;
  readonly enabled: boolean;
}

export const EMPTY_APP_COMPONENTS_STATE: AppComponentsState = { revision: 0, components: [] };
