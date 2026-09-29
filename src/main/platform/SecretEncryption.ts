import * as Context from "effect/Context";

export interface SecretEncryptionAdapter {
  readonly isAvailable: () => boolean;
  readonly encryptString: (plaintext: string) => Buffer;
  readonly decryptString: (ciphertext: Buffer) => string;
}

/** Platform-backed encryption; keys and plaintext never enter settings snapshots. */
export class SecretEncryption extends Context.Service<SecretEncryption, SecretEncryptionAdapter>()(
  "nodex/main/platform/SecretEncryption",
) {}
