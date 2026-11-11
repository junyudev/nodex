export const COMPUTER_USE_SOUND_MODES = [
  "foregroundClicks",
  "foregroundAndBackgroundClicks",
  "off",
] as const;

export type ComputerUseSoundMode = (typeof COMPUTER_USE_SOUND_MODES)[number];

export interface ComputerUseApprovedApp {
  readonly bundleIdentifier: string;
  readonly displayName: string;
}

export interface ComputerUseApprovedMessageThread {
  readonly chatGuid: string;
  readonly displayName: string;
}

export type ComputerUseSettingsSnapshot = {
  readonly approvedApps: readonly ComputerUseApprovedApp[];
  readonly available: boolean;
  readonly message: string | null;
} & (
  | { readonly windows: { readonly enabled: boolean } }
  | {
      readonly windows?: never;
      readonly alwaysHidePictureInPicture: boolean;
      readonly approvedMessageThreads: readonly ComputerUseApprovedMessageThread[];
      readonly lockedUseAllowed: boolean;
      readonly lockedUseEnabled: boolean | null;
      readonly soundMode: ComputerUseSoundMode;
    }
);

export function isComputerUseSoundMode(value: unknown): value is ComputerUseSoundMode {
  return (
    typeof value === "string" && (COMPUTER_USE_SOUND_MODES as readonly string[]).includes(value)
  );
}
