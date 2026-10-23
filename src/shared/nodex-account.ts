import { z } from "zod";

/** Public identity only; Clerk credentials remain in the Profile's Main process. */
export const NodexAccountIdentitySchema = z
  .object({
    issuer: z.string().url(),
    subject: z.string().min(1).max(1024),
    email: z.string().max(1024).nullable(),
    name: z.string().max(1024).nullable(),
    imageUrl: z.string().max(4096).nullable(),
  })
  .strict();
export type NodexAccountIdentity = z.infer<typeof NodexAccountIdentitySchema>;

export const NODEX_ACCOUNT_ERROR_CODES = [
  "not-configured",
  "configuration",
  "network",
  "oauth-denied",
  "oauth-invalid-response",
  "oauth-timeout",
  "secure-storage",
  "invalid-grant",
  "identity-changed",
  "browser-open",
  "revocation-failed",
] as const;
export type NodexAccountErrorCode = (typeof NODEX_ACCOUNT_ERROR_CODES)[number];

export const NodexAccountSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    configured: z.boolean(),
    status: z.enum(["signed-out", "signing-in", "signed-in", "reauthentication-required"]),
    account: NodexAccountIdentitySchema.nullable(),
    connection: z.enum(["available", "unavailable"]),
    persistence: z.enum(["secure", "memory"]).nullable(),
    error: z.enum(NODEX_ACCOUNT_ERROR_CODES).nullable(),
  })
  .strict();
export type NodexAccountSnapshot = z.infer<typeof NodexAccountSnapshotSchema>;
