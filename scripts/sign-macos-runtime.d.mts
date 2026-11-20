import type { SignOptions } from "@electron/osx-sign";

type SigningPolicyInput = Pick<SignOptions, "app" | "optionsForFile">;
type SigningPolicyResult<T> = Omit<T, "optionsForFile"> & {
  readonly optionsForFile: NonNullable<SignOptions["optionsForFile"]>;
};

export function refreshSignedAgentRuntimeNativeManifest(appPath: string): void;
export function isPreservedNodeRuntimeVendorCode(appPath: string, filePath: string): boolean;
export function isPreservedCodexRuntimeVendorCode(appPath: string, filePath: string): boolean;
export function sparkleCodeSignArguments(options: {
  readonly identity: string;
  readonly keychain?: string;
  readonly local: boolean;
  readonly targetPath: string;
}): string[];
export function refreshSignedSparkleRuntimeManifest(appPath: string): void;
export function applyMacSigningMode<T extends SigningPolicyInput>(
  options: T,
  mode: "local",
): SigningPolicyResult<T>;
export function applyMacSigningMode<T extends SigningPolicyInput>(
  options: T,
  mode?: string,
): T | SigningPolicyResult<T>;
export function applyMacCodeObjectEntitlementPolicy<T extends SigningPolicyInput>(
  options: T,
): SigningPolicyResult<T>;
export function sign(options: SignOptions): Promise<void>;
