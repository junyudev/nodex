import { syncDirectorySync } from "../platform/node/filesystem-durability";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  BrowserCapabilityStatus,
  BrowserContactInfo,
  BrowserContactInfoUpsertInput,
  BrowserCredentialSummary,
} from "../../shared/browser-profile";
import {
  BrowserContactInfoFieldsSchema,
  BrowserContactInfoUpsertInputSchema,
} from "../../shared/browser-profile";

const FILE_SCHEMA_VERSION = 2;
const MAX_ORIGIN_LENGTH = 16_384;
const MAX_USERNAME_LENGTH = 8_192;
const MAX_PASSWORD_LENGTH = 1024 * 1024;
const MAX_CREDENTIAL_COUNT = 20_000;
const MAX_CONTACT_COUNT = 1_000;
const MAX_CONTACT_CIPHERTEXT_LENGTH = 256 * 1024;

const StoredCredentialSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    origin: z.string().min(1).max(MAX_ORIGIN_LENGTH),
    username: z.string().max(MAX_USERNAME_LENGTH),
    label: z.string().max(2_048),
    ciphertext: z
      .string()
      .min(1)
      .max(4 * MAX_PASSWORD_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const ContactPayloadSchema = BrowserContactInfoFieldsSchema;

const StoredContactSchema = z
  .object({
    id: z.string().uuid(),
    ciphertext: z.string().min(1).max(MAX_CONTACT_CIPHERTEXT_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const CredentialFileSchema = z
  .object({
    schemaVersion: z.literal(FILE_SCHEMA_VERSION),
    credentials: z.array(StoredCredentialSchema).max(MAX_CREDENTIAL_COUNT),
    contacts: z.array(StoredContactSchema).max(MAX_CONTACT_COUNT),
  })
  .strict();

type StoredCredential = z.infer<typeof StoredCredentialSchema>;
type StoredContact = z.infer<typeof StoredContactSchema>;
type CredentialFile = z.infer<typeof CredentialFileSchema>;

const LegacyCredentialFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    credentials: z.array(StoredCredentialSchema).max(MAX_CREDENTIAL_COUNT),
  })
  .strict();

export interface BrowserCredentialEncryption {
  isAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface BrowserCredentialVaultOptions {
  filePath: string;
  encryption: BrowserCredentialEncryption;
  now?: () => Date;
}

export interface SaveBrowserCredentialInput {
  origin: string;
  username: string;
  password: string;
  label?: string;
}

export interface DecryptedBrowserCredential {
  summary: BrowserCredentialSummary;
  password: string;
}

export class BrowserCredentialVault {
  private readonly filePath: string;
  private readonly encryption: BrowserCredentialEncryption;
  private readonly now: () => Date;
  constructor(options: BrowserCredentialVaultOptions) {
    this.filePath = path.resolve(options.filePath);
    this.encryption = options.encryption;
    this.now = options.now ?? (() => new Date());
  }

  capability(): BrowserCapabilityStatus {
    if (this.encryption.isAvailable()) {
      return {
        available: true,
        provider: "nodex-encrypted-vault",
      };
    }
    return {
      available: false,
      provider: "unavailable",
      reason: "Secure credential storage is unavailable on this device",
    };
  }

  listForOrigin(origin: string): BrowserCredentialSummary[] {
    const normalizedOrigin = normalizeOrigin(origin);
    return this.readFile()
      .credentials.filter((credential) => credential.origin === normalizedOrigin)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toSummary);
  }

  list(): BrowserCredentialSummary[] {
    return this.readFile()
      .credentials.slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toSummary);
  }

  get(id: string): DecryptedBrowserCredential | null {
    const credential = this.readFile().credentials.find((entry) => entry.id === id);
    if (!credential) return null;
    this.requireEncryption();
    const ciphertext = Buffer.from(credential.ciphertext, "base64");
    if (ciphertext.length === 0) {
      throw new Error("Stored Browser credential ciphertext is invalid");
    }
    const password = normalizePassword(this.encryption.decryptString(ciphertext));
    return {
      summary: toSummary(credential),
      password,
    };
  }

  save(input: SaveBrowserCredentialInput): BrowserCredentialSummary {
    this.requireEncryption();
    const origin = normalizeOrigin(input.origin);
    const username = normalizeUsername(input.username);
    const password = normalizePassword(input.password);
    const id = credentialId(origin, username);
    const ciphertext = this.encryption.encryptString(password).toString("base64");
    if (!ciphertext) {
      throw new Error("Browser credential encryption returned an empty result");
    }
    const updatedAt = this.now().toISOString();
    let saved: StoredCredential | null = null;
    this.write((current) => {
      const existing = current.credentials.find((credential) => credential.id === id);
      saved = StoredCredentialSchema.parse({
        id,
        origin,
        username,
        label: normalizeLabel(input.label, origin, username),
        ciphertext,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      });
      return {
        schemaVersion: FILE_SCHEMA_VERSION,
        credentials: [
          saved,
          ...current.credentials.filter((credential) => credential.id !== id),
        ].slice(0, MAX_CREDENTIAL_COUNT),
        contacts: current.contacts,
      };
    });
    if (!saved) throw new Error("Browser credential save did not complete");
    return toSummary(saved);
  }

  remove(id: string): void {
    this.write((current) => ({
      schemaVersion: FILE_SCHEMA_VERSION,
      credentials: current.credentials.filter((credential) => credential.id !== id),
      contacts: current.contacts,
    }));
  }

  matches(input: SaveBrowserCredentialInput): boolean {
    const origin = normalizeOrigin(input.origin);
    const username = normalizeUsername(input.username);
    const existing = this.get(credentialId(origin, username));
    if (!existing) return false;
    return existing.password === normalizePassword(input.password);
  }

  generate(length = 20): string {
    if (!Number.isSafeInteger(length) || length < 12 || length > 128) {
      throw new Error("Generated password length is outside the supported range");
    }
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const symbols = "!@#$%^&*()-_=+";
    const alphabet = `${lower}${upper}${digits}${symbols}`;
    const required = [
      randomCharacter(lower),
      randomCharacter(upper),
      randomCharacter(digits),
      randomCharacter(symbols),
    ];
    while (required.length < length) {
      required.push(randomCharacter(alphabet));
    }
    return shuffleWithSecureRandom(required).join("");
  }

  listContactInfo(): BrowserContactInfo[] {
    this.requireEncryption();
    return this.readFile()
      .contacts.slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((contact) => this.decryptContact(contact));
  }

  getContactInfo(id: string): BrowserContactInfo | null {
    this.requireEncryption();
    const contact = this.readFile().contacts.find((entry) => entry.id === id);
    return contact ? this.decryptContact(contact) : null;
  }

  saveContactInfo(rawInput: BrowserContactInfoUpsertInput): BrowserContactInfo {
    this.requireEncryption();
    const input = BrowserContactInfoUpsertInputSchema.parse(rawInput);
    const payload = ContactPayloadSchema.parse({
      label: input.label || input.fullName || input.email || "Contact",
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      country: input.country,
    });
    const updatedAt = this.now().toISOString();
    let savedId: string | null = null;
    this.write((current) => {
      const existing = input.id
        ? current.contacts.find((contact) => contact.id === input.id)
        : undefined;
      if (input.id && !existing) {
        throw new Error("Browser contact info no longer exists");
      }
      savedId = existing?.id ?? randomUUID();
      const ciphertext = this.encryption.encryptString(JSON.stringify(payload)).toString("base64");
      const contact = StoredContactSchema.parse({
        id: savedId,
        ciphertext,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      });
      return {
        schemaVersion: FILE_SCHEMA_VERSION,
        credentials: current.credentials,
        contacts: [contact, ...current.contacts.filter((entry) => entry.id !== savedId)].slice(
          0,
          MAX_CONTACT_COUNT,
        ),
      };
    });
    if (!savedId) throw new Error("Browser contact info save did not complete");
    const saved = this.getContactInfo(savedId);
    if (!saved) throw new Error("Browser contact info save did not persist");
    return saved;
  }

  removeContactInfo(id: string): void {
    this.write((current) => ({
      schemaVersion: FILE_SCHEMA_VERSION,
      credentials: current.credentials,
      contacts: current.contacts.filter((contact) => contact.id !== id),
    }));
  }

  private decryptContact(contact: StoredContact): BrowserContactInfo {
    const ciphertext = Buffer.from(contact.ciphertext, "base64");
    if (ciphertext.length === 0) {
      throw new Error("Stored Browser contact info ciphertext is invalid");
    }
    const payload = ContactPayloadSchema.parse(
      JSON.parse(this.encryption.decryptString(ciphertext)),
    );
    return {
      id: contact.id,
      ...payload,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
  }

  private requireEncryption(): void {
    if (this.encryption.isAvailable()) return;
    throw new Error("Secure Browser credential storage is unavailable");
  }

  private readFile(): CredentialFile {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyCredentialFile();
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Browser credential path is not a regular file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Browser credential file permissions are too broad");
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const current = CredentialFileSchema.safeParse(parsed);
    if (current.success) return current.data;
    const legacy = LegacyCredentialFileSchema.safeParse(parsed);
    if (!legacy.success) {
      throw current.error;
    }
    return {
      schemaVersion: FILE_SCHEMA_VERSION,
      credentials: legacy.data.credentials,
      contacts: [],
    };
  }

  private write(update: (current: CredentialFile) => CredentialFile): void {
    const current = this.readFile();
    this.writeFileAtomically(CredentialFileSchema.parse(update(current)));
  }

  private writeFileAtomically(value: CredentialFile): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = fs.lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Browser credential directory is unsafe");
    }
    fs.chmodSync(directory, 0o700);

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      syncDirectorySync(directory);
    } finally {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // A completed rename already removed the temporary name.
      }
    }
  }
}

function emptyCredentialFile(): CredentialFile {
  return {
    schemaVersion: FILE_SCHEMA_VERSION,
    credentials: [],
    contacts: [],
  };
}

function normalizeOrigin(value: string): string {
  if (value.length > MAX_ORIGIN_LENGTH) {
    throw new Error("Browser credential origin is too long");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser credential origin is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Browser credentials require an HTTP(S) origin");
  }
  return url.origin;
}

function normalizeUsername(value: string): string {
  const normalized = value.trim();
  if (normalized.length > MAX_USERNAME_LENGTH) {
    throw new Error("Browser credential username is too long");
  }
  return normalized;
}

function normalizePassword(value: string): string {
  if (!value || value.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Browser credential password is empty or too long");
  }
  return value;
}

function normalizeLabel(requested: string | undefined, origin: string, username: string): string {
  const label = requested?.trim() || username || new URL(origin).hostname;
  return label.slice(0, 2_048);
}

function credentialId(origin: string, username: string): string {
  return createHash("sha256").update(`${origin}\0${username}`).digest("hex");
}

function toSummary(credential: StoredCredential): BrowserCredentialSummary {
  return {
    id: credential.id,
    origin: credential.origin,
    username: credential.username,
    label: credential.label,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function randomCharacter(alphabet: string): string {
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return alphabet[byte % alphabet.length]!;
  }
}

function shuffleWithSecureRandom(values: string[]): string[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex]!, values[index]!];
  }
  return values;
}

function randomInteger(upperExclusive: number): number {
  const ceiling = Math.floor(256 / upperExclusive) * upperExclusive;
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return byte % upperExclusive;
  }
}
