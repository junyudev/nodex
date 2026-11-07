import { z } from "zod";
import type { BrowserSidebarTabIdentity } from "./browser-sidebar";
import { BrowserSidebarTabIdentitySchema } from "./browser/browser-schemas";

const BrowserIdSchema = z.string().trim().min(1).max(512);
const BrowserPathSchema = z.string().trim().min(1).max(8_192);
const BrowserUrlSchema = z.string().trim().min(1).max(16_384);
const BrowserLabelSchema = z.string().max(2_048);
const BrowserUsernameSchema = z.string().max(8_192);
const BrowserDomainSchema = z.string().trim().min(1).max(253);

export type BrowserCapabilityProvider =
  | "electron-public-api"
  | "nodex-encrypted-vault"
  | "nodex-profile-import"
  | "unavailable";

export interface BrowserCapabilityStatus {
  available: boolean;
  provider: BrowserCapabilityProvider;
  reason?: string;
}

export interface BrowserProfileCapabilities {
  credentialVault: BrowserCapabilityStatus;
  contactInfo: BrowserCapabilityStatus;
  profileImport: BrowserCapabilityStatus;
  siteInfo: BrowserCapabilityStatus;
  history: BrowserCapabilityStatus;
  extensions: BrowserCapabilityStatus;
}

export type BrowserProfileSource = "atlas" | "chrome";

export interface ImportableBrowserProfile {
  source: BrowserProfileSource;
  appName: string;
  profileName: string;
  profileDirectoryName: string;
  profilePath: string;
  rootPath: string;
  hasCookies: boolean;
  hasPasswords: boolean;
  sourceBrowserOpen: boolean;
  gaiaName?: string;
  userName?: string;
}

export interface BrowserProfileImportInput {
  source: BrowserProfileSource;
  profilePath: string;
  importCookies: boolean;
  importPasswords: boolean;
  cookieDomainAllowlist?: string[];
}

export interface BrowserProfileImportDataResult {
  status: "success" | "partial-success" | "failed";
  discovered: number;
  imported: number;
  skippedExisting: number;
  skippedInvalid: number;
  failed: number;
  error?: string;
}

export interface BrowserProfileImportResult {
  source: BrowserProfileSource;
  profilePath: string;
  cookies?: BrowserProfileImportDataResult;
  passwords?: BrowserProfileImportDataResult;
}

export interface BrowserCredentialSummary {
  id: string;
  origin: string;
  username: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserCredentialSaveCandidate extends BrowserSidebarTabIdentity {
  candidateId: string;
  origin: string;
  username: string;
  label: string;
  expiresAt: number;
}

export type BrowserCredentialListInput = BrowserSidebarTabIdentity;

export interface BrowserCredentialFillInput extends BrowserSidebarTabIdentity {
  credentialId: string;
}

export interface BrowserCredentialGenerateInput extends BrowserSidebarTabIdentity {
  length?: number;
}

export interface BrowserCredentialCandidateActionInput {
  candidateId: string;
  action: "save" | "dismiss";
}

export interface BrowserCredentialActionResult {
  ok: boolean;
  message?: string;
}

export interface BrowserContactInfo {
  id: string;
  label: string;
  fullName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserContactInfoUpsertInput {
  id?: string;
  label: string;
  fullName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface BrowserContactInfoFillInput extends BrowserSidebarTabIdentity {
  contactInfoId: string;
}

export interface BrowserHistoryRecord {
  id: string;
  url: string;
  title: string;
  lastVisitedAt: number;
  visitCount: number;
}

export interface BrowserHistoryListInput {
  query?: string;
  limit?: number;
}

export interface BrowserHistorySnapshot {
  entries: BrowserHistoryRecord[];
  updatedAt: number;
}

export interface BrowserSiteInfo extends BrowserSidebarTabIdentity {
  url: string;
  origin: string | null;
  connection: "secure" | "insecure" | "local" | "none";
  cookieCount: number;
  permissions: Array<{
    permission: import("./browser/browser-permissions").BrowserSitePermissionName;
    state: "allow" | "ask" | "block";
  }>;
}

export interface BrowserExtensionSummary {
  id: string;
  name: string;
  version: string;
  path: string;
  url: string;
}

export interface BrowserExtensionsSnapshot {
  capability: BrowserCapabilityStatus;
  extensions: BrowserExtensionSummary[];
}

export const BrowserProfileImportInputSchema = z
  .object({
    source: z.enum(["atlas", "chrome"]),
    profilePath: BrowserPathSchema,
    importCookies: z.boolean(),
    importPasswords: z.boolean(),
    cookieDomainAllowlist: z.array(BrowserDomainSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.importCookies && !input.importPasswords) {
      context.addIssue({
        code: "custom",
        message: "Select cookies, passwords, or both to import",
      });
    }
    if (!input.importCookies && input.cookieDomainAllowlist !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Cookie domain selection requires cookie import",
        path: ["cookieDomainAllowlist"],
      });
    }
  }) satisfies z.ZodType<BrowserProfileImportInput>;

export const BrowserCredentialListInputSchema =
  BrowserSidebarTabIdentitySchema satisfies z.ZodType<BrowserCredentialListInput>;

export const BrowserCredentialFillInputSchema = BrowserSidebarTabIdentitySchema.extend({
  credentialId: BrowserIdSchema,
}).strict() satisfies z.ZodType<BrowserCredentialFillInput>;

export const BrowserCredentialGenerateInputSchema = BrowserSidebarTabIdentitySchema.extend({
  length: z.number().int().min(12).max(128).optional(),
}).strict() satisfies z.ZodType<BrowserCredentialGenerateInput>;

export const BrowserCredentialCandidateActionInputSchema = z
  .object({
    candidateId: BrowserIdSchema,
    action: z.enum(["save", "dismiss"]),
  })
  .strict() satisfies z.ZodType<BrowserCredentialCandidateActionInput>;

const BrowserContactFieldSchema = z.string().trim().max(4_096);

export const BrowserContactInfoFieldsSchema = z
  .object({
    label: BrowserContactFieldSchema,
    fullName: BrowserContactFieldSchema,
    email: BrowserContactFieldSchema,
    phone: BrowserContactFieldSchema,
    addressLine1: BrowserContactFieldSchema,
    addressLine2: BrowserContactFieldSchema,
    city: BrowserContactFieldSchema,
    region: BrowserContactFieldSchema,
    postalCode: BrowserContactFieldSchema,
    country: BrowserContactFieldSchema,
  })
  .strict();

export const BrowserContactInfoUpsertInputSchema = BrowserContactInfoFieldsSchema.extend({
  id: BrowserIdSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    const values = [
      value.fullName,
      value.email,
      value.phone,
      value.addressLine1,
      value.addressLine2,
      value.city,
      value.region,
      value.postalCode,
      value.country,
    ];
    if (values.some(Boolean)) return;
    context.addIssue({
      code: "custom",
      message: "Contact info must contain at least one value",
    });
  }) satisfies z.ZodType<BrowserContactInfoUpsertInput>;

export const BrowserContactInfoFillInputSchema = BrowserSidebarTabIdentitySchema.extend({
  contactInfoId: BrowserIdSchema,
}).strict() satisfies z.ZodType<BrowserContactInfoFillInput>;

export const BrowserContactInfoRemoveInputSchema = z
  .object({
    contactInfoId: BrowserIdSchema,
  })
  .strict();

export const BrowserHistoryListInputSchema = z
  .object({
    query: BrowserLabelSchema.optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict() satisfies z.ZodType<BrowserHistoryListInput>;

export const BrowserHistoryDeleteInputSchema = z
  .object({
    id: BrowserIdSchema,
  })
  .strict();

export const BrowserSiteInfoInputSchema =
  BrowserSidebarTabIdentitySchema satisfies z.ZodType<BrowserSidebarTabIdentity>;

export const BrowserExtensionRemoveInputSchema = z
  .object({
    extensionId: BrowserIdSchema,
  })
  .strict();

export const BrowserCredentialGuestCandidateSchema = z
  .object({
    username: BrowserUsernameSchema,
    password: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();

export const BrowserContactInfoGuestFillSchema = z
  .object({
    origin: BrowserUrlSchema,
    contactInfo: BrowserContactInfoFieldsSchema.omit({ label: true }),
  })
  .strict();
