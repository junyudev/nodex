import { safeStorage } from "electron";
import * as Layer from "effect/Layer";
import { SecretEncryption } from "../SecretEncryption";

export const live = Layer.succeed(
  SecretEncryption,
  SecretEncryption.of({
    isAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  }),
);
