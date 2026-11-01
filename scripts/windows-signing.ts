import type { WindowsConfiguration } from "electron-builder";

/** Distribution policy boundary; credentials belong to a future protected signing job. */
export type WindowsSigningPolicy = { readonly kind: "unsigned" };

export function windowsSigningConfiguration(
  _policy: WindowsSigningPolicy,
): Pick<WindowsConfiguration, "signExecutable"> {
  return { signExecutable: false };
}
