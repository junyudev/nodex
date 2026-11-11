import type { WindowsAuthenticodePublisherPolicy } from "../../shared/browser-runtime-metadata";

export type WindowsRuntimeVerificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export type VerifiedAuthenticodeSigner = {
  /** Leaf subject and direct issuer in RFC 2253 format. */
  subject: string;
  issuer: string;
};

export interface WindowsBrowserRuntimeVerifierPort {
  /**
   * Open without following reparse points. Check the closure root, its path
   * from the installation boundary, and all descendants (including directories
   * and the manifest). Reject foreign owners and write access granted to
   * untrusted principals. Use the effective user and trusted system owners.
   */
  verifyClosurePaths(
    rootPath: string,
    signal?: AbortSignal,
  ): Promise<WindowsRuntimeVerificationResult<undefined>>;

  /**
   * Use WinVerifyTrust for the embedded Authenticode signature, with code-signing
   * usage, trusted timestamp handling and chain revocation checking (fail if
   * revocation cannot be established). Read back the signer of the signature
   * that passed trust and match both policy names. Catalog-only trust fails.
   */
  verifyAuthenticode(
    path: string,
    policy: WindowsAuthenticodePublisherPolicy,
    signal?: AbortSignal,
  ): Promise<WindowsRuntimeVerificationResult<VerifiedAuthenticodeSigner>>;
}

export const WINDOWS_BROWSER_RUNTIME_VERIFICATION_UNAVAILABLE =
  "Windows Desktop Tool verification unavailable";
