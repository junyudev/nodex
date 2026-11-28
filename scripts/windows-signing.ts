import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { WindowsConfiguration } from "electron-builder";

/** Authenticode is applied to the finished installer by the distribution job. */
export type WindowsSigningPolicy =
  | { readonly kind: "unsigned" }
  | { readonly kind: "authenticode"; readonly certificateSha256: string };

export function windowsSigningConfiguration(
  _policy: Extract<WindowsSigningPolicy, { kind: "unsigned" }>,
): Pick<WindowsConfiguration, "signExecutable"> {
  // Keep the packaging signing pass disabled so the vendor PEs retain their signatures.
  return { signExecutable: false };
}

const CERTIFICATE_SHA256 = /^[0-9a-f]{64}$/u;

export function windowsAuthenticodePolicy(certificateSha256 = ""): WindowsSigningPolicy {
  const fingerprint = certificateSha256.trim().toLowerCase();
  if (!CERTIFICATE_SHA256.test(fingerprint))
    throw new Error("Windows Authenticode requires the expected leaf certificate SHA-256.");
  return { kind: "authenticode", certificateSha256: fingerprint };
}

export function verifyWindowsInstallerSignature(
  installer: string,
  policy: WindowsSigningPolicy,
): WindowsSigningPolicy {
  if (policy.kind === "unsigned") return policy;
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(import.meta.dirname, "verify-windows-authenticode.ps1"),
      "-Installer",
      installer,
      "-CertificateSha256",
      policy.certificateSha256,
    ],
    { stdio: "inherit" },
  );
  return policy;
}
