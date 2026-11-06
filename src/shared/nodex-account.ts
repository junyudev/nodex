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

const tokenPrice = z.number().finite().nonnegative().nullable();
const NodexTokenPricesSchema = z.object({
  input: tokenPrice,
  cacheRead: tokenPrice,
  cacheWrite: tokenPrice,
  output: tokenPrice,
});
export type NodexTokenPrices = z.infer<typeof NodexTokenPricesSchema>;

/** What the gateway charges, resolved on the server; the desktop only formats it. */
export const NodexModelPricingSchema = z.object({
  currency: z.literal("USD"),
  perTokens: z.number().int().positive(),
  notes: z.array(z.string().min(1).max(300)).max(8),
  groups: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
        description: z.string().max(300).nullable(),
        available: z.boolean(),
        models: z
          .array(
            z.object({
              id: z.string().min(1).max(256),
              label: z.string().min(1).max(128),
              /** Picks the brand mark only; an unknown provider simply shows none. */
              provider: z.string().min(1).max(64),
              /** The provider's official API price. */
              reference: NodexTokenPricesSchema,
              /** What this group charges for the model now. */
              effective: NodexTokenPricesSchema,
              /** Set only when one factor explains every price; otherwise no rate is claimed. */
              multiplier: z.number().finite().positive().nullable(),
            }),
          )
          .max(64),
      }),
    )
    .min(1)
    .max(8),
});
export type NodexModelPricing = z.infer<typeof NodexModelPricingSchema>;

/** Public supply observations; never an authorization to spend. */
export const NodexModelStatusSchema = z.object({
  /** The wallet stays in USD; people see credits at this server-owned rate. */
  creditsPerUsd: z.number().int().positive(),
  /** Display data can never cost a person their supply or Top up, so a bad table only hides. */
  pricing: NodexModelPricingSchema.nullable().optional().catch(null),
  models: z.array(z.object({ id: z.string().min(1).max(256), available: z.boolean() })).max(100),
  topUp: z.object({
    available: z.boolean(),
    currency: z.literal("USD"),
    tiers: z
      .array(
        z.object({
          amount: z.number().finite().positive(),
          credit: z.number().finite().positive(),
          available: z.boolean(),
        }),
      )
      .max(20),
  }),
});
export type NodexModelStatus = z.infer<typeof NodexModelStatusSchema>;
export const NODEX_CHECKOUT_ERROR_CODES = [
  "unauthenticated",
  "forbidden_client",
  "tier_unavailable",
  "unavailable",
  "browser-open",
] as const;

export const NodexAccountSnapshotSchema = z
  .object({
    modelStatus: NodexModelStatusSchema.nullable().optional(),
    /** The last rate seen, so a status outage doesn't take a known balance off the screen. */
    creditsPerUsd: z.number().int().positive().nullable().optional(),
    checkoutPending: z.boolean().optional(),
    checkoutError: z.enum(NODEX_CHECKOUT_ERROR_CODES).nullable().optional(),
    credit: z
      .object({ balance: z.number().finite(), unit: z.literal("USD") })
      .nullable()
      .optional(),
    modelAccessError: z
      .enum(["unauthenticated", "forbidden_client", "email_unverified", "unavailable"])
      .nullable()
      .optional(),
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

/** The balance in credits, or null until both the wallet and the rate have been observed. */
export const nodexCreditBalance = (
  snapshot: Pick<NodexAccountSnapshot, "credit" | "creditsPerUsd"> | undefined,
): number | null =>
  snapshot?.credit && snapshot.creditsPerUsd
    ? snapshot.credit.balance * snapshot.creditsPerUsd
    : null;
