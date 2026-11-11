import type { WindowsConfiguration } from "electron-builder";

/** Distribution policy boundary; credentials belong to a future protected signing job. */
export type WindowsSigningPolicy = { readonly kind: "unsigned" };

export function windowsSigningConfiguration(
  _policy: WindowsSigningPolicy,
): Pick<WindowsConfiguration, "signExecutable"> {
  // electron-builder applies resource edits to Nodex.exe only. Disable its signing
  // pass so vendor PEs in extraResources retain their embedded signatures.
  return { signExecutable: false };
}
