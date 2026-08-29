import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeStorage } from "electron";
import type { AgentProviderCredentialStatus } from "../../../shared/agent-runtime";

const CREDENTIAL_FILE_VERSION = 1;
const MAX_API_KEY_LENGTH = 16 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export const PROVIDER_API_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  "kimi-for-coding": "KIMI_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

export type StoredCredentialProviderId = keyof typeof PROVIDER_API_KEY_ENV;

interface StoredCredentialEntry {
  readonly ciphertext: string;
  readonly updatedAt: string;
}

interface StoredCredentialFile {
  readonly version: typeof CREDENTIAL_FILE_VERSION;
  readonly credentials: Partial<Record<StoredCredentialProviderId, StoredCredentialEntry>>;
}

export interface ProviderCredentialEncryption {
  isAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface ProviderCredentialStoreOptions {
  readonly filePath: string;
  readonly encryption: ProviderCredentialEncryption;
  readonly inheritedEnv?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredProviderId(value: string): value is StoredCredentialProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_API_KEY_ENV, value);
}

function parseCredentialFile(value: unknown): StoredCredentialFile {
  if (
    !isRecord(value) ||
    value.version !== CREDENTIAL_FILE_VERSION ||
    !isRecord(value.credentials)
  ) {
    throw new Error("Provider credential file has an unsupported schema");
  }
  const credentials: StoredCredentialFile["credentials"] = {};
  for (const [providerId, rawEntry] of Object.entries(value.credentials)) {
    if (!isStoredProviderId(providerId) || !isRecord(rawEntry)) {
      throw new Error("Provider credential file contains an unsupported provider entry");
    }
    if (
      typeof rawEntry.ciphertext !== "string" ||
      !rawEntry.ciphertext ||
      typeof rawEntry.updatedAt !== "string" ||
      !rawEntry.updatedAt
    ) {
      throw new Error(`Provider credential entry for ${providerId} is invalid`);
    }
    credentials[providerId] = {
      ciphertext: rawEntry.ciphertext,
      updatedAt: rawEntry.updatedAt,
    };
  }
  return { version: CREDENTIAL_FILE_VERSION, credentials };
}

function emptyCredentialFile(): StoredCredentialFile {
  return { version: CREDENTIAL_FILE_VERSION, credentials: {} };
}

function normalizeApiKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_API_KEY_LENGTH) {
    throw new Error("API key is empty or too long");
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error("API key contains unsupported control characters");
  }
  return normalized;
}

export class ProviderCredentialStore {
  private readonly filePath: string;
  private readonly encryption: ProviderCredentialEncryption;
  private readonly inheritedEnv: NodeJS.ProcessEnv;

  constructor(options: ProviderCredentialStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.encryption = options.encryption;
    this.inheritedEnv = { ...(options.inheritedEnv ?? process.env) };
  }

  isEncryptionAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  status(providerId: string): AgentProviderCredentialStatus {
    if (providerId === "openai") return "runtimeManaged";
    if (!isStoredProviderId(providerId)) return "unsupported";

    const file = this.readFile();
    if (file.credentials[providerId]) {
      if (!this.encryption.isAvailable()) return "unavailable";
      try {
        this.decryptEntry(file.credentials[providerId]);
        return "ready";
      } catch {
        return "unavailable";
      }
    }

    const inheritedValue = this.inheritedEnv[PROVIDER_API_KEY_ENV[providerId]];
    if (typeof inheritedValue === "string" && inheritedValue.trim()) return "inherited";
    return this.encryption.isAvailable() ? "missing" : "unavailable";
  }

  statuses(): Record<string, AgentProviderCredentialStatus> {
    const providerIds = ["openai", ...Object.keys(PROVIDER_API_KEY_ENV)];
    return Object.fromEntries(
      providerIds.map((providerId) => [providerId, this.status(providerId)]),
    );
  }

  setApiKey(providerId: string, plaintext: string, updatedAt: string): void {
    if (!isStoredProviderId(providerId)) {
      throw new Error(`API-key storage is unsupported for provider ${providerId}`);
    }
    if (!this.encryption.isAvailable()) {
      throw new Error("Secure credential storage is unavailable");
    }
    const normalized = normalizeApiKey(plaintext);
    const ciphertext = this.encryption.encryptString(normalized).toString("base64");
    if (!ciphertext) throw new Error("Credential encryption returned an empty result");

    this.updateFile((current) => ({
      version: CREDENTIAL_FILE_VERSION,
      credentials: {
        ...current.credentials,
        [providerId]: {
          ciphertext,
          updatedAt,
        },
      },
    }));
  }

  delete(providerId: string): void {
    if (!isStoredProviderId(providerId)) {
      throw new Error(`API-key storage is unsupported for provider ${providerId}`);
    }
    this.updateFile((current) => {
      const credentials = { ...current.credentials };
      delete credentials[providerId];
      return { version: CREDENTIAL_FILE_VERSION, credentials };
    });
  }

  buildRuntimeEnvOverlay(): Readonly<Record<string, string>> {
    const current = this.readFile();
    const overlay: Record<string, string> = {};
    for (const providerId of Object.keys(current.credentials)) {
      if (!isStoredProviderId(providerId)) continue;
      const entry = current.credentials[providerId];
      if (!entry) continue;
      if (!this.encryption.isAvailable()) {
        throw new Error("Secure credential storage is unavailable");
      }
      overlay[PROVIDER_API_KEY_ENV[providerId]] = this.decryptEntry(entry);
    }
    return overlay;
  }

  private decryptEntry(entry: StoredCredentialEntry): string {
    const ciphertext = Buffer.from(entry.ciphertext, "base64");
    if (ciphertext.length === 0) throw new Error("Stored credential ciphertext is invalid");
    return normalizeApiKey(this.encryption.decryptString(ciphertext));
  }

  private readFile(): StoredCredentialFile {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentialFile();
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Provider credential path is not a regular file");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("Provider credential file permissions are too broad");
    }
    return parseCredentialFile(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  private updateFile(update: (current: StoredCredentialFile) => StoredCredentialFile): void {
    const current = this.readFile();
    this.writeFileAtomically(update(current));
  }

  private writeFileAtomically(value: StoredCredentialFile): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Provider credential directory is unsafe");
    }
    fs.chmodSync(directory, 0o700);

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The rename may already have committed the replacement.
      }
      throw error;
    }
  }
}

export function createElectronProviderCredentialStore(filePath: string): ProviderCredentialStore {
  return new ProviderCredentialStore({
    filePath,
    encryption: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plaintext) => safeStorage.encryptString(plaintext),
      decryptString: (ciphertext) => safeStorage.decryptString(ciphertext),
    },
  });
}
