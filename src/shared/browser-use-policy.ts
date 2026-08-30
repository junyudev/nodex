import { z } from "zod";

export const BrowserUseApprovalModeSchema = z.enum(["alwaysAsk", "neverAsk"]);
export const BrowserUsePolicyResourceSchema = z.enum(["origin", "download", "upload", "fullCdp"]);
export const BrowserUseOriginRuleKindSchema = z.enum(["allowed", "denied"]);
export const MAX_BROWSER_USE_POLICY_ORIGINS = 1_000;

const BrowserUseOriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin === value &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "Browser Use policy requires an http(s) origin");

export const BrowserUsePolicySnapshotSchema = z.strictObject({
  fullCdpAccessEnabled: z.boolean(),
  approvalMode: BrowserUseApprovalModeSchema,
  historyApprovalMode: BrowserUseApprovalModeSchema,
  downloadApprovalMode: BrowserUseApprovalModeSchema,
  uploadApprovalMode: BrowserUseApprovalModeSchema,
  allowedOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  deniedOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  allowedDownloadOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  deniedDownloadOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  allowedUploadOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  deniedUploadOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  allowedFullCdpOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
  deniedFullCdpOrigins: z.array(BrowserUseOriginSchema).max(MAX_BROWSER_USE_POLICY_ORIGINS),
});

export const BrowserUsePolicyModesUpdateSchema = z
  .strictObject({
    approvalMode: BrowserUseApprovalModeSchema.optional(),
    historyApprovalMode: BrowserUseApprovalModeSchema.optional(),
    downloadApprovalMode: BrowserUseApprovalModeSchema.optional(),
    uploadApprovalMode: BrowserUseApprovalModeSchema.optional(),
    fullCdpAccessEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Policy update is empty");

export const BrowserUseOriginRuleUpdateSchema = z.strictObject({
  action: z.enum(["add", "remove"]),
  kind: BrowserUseOriginRuleKindSchema,
  origin: z.string().trim().min(1).max(2_048),
  resource: BrowserUsePolicyResourceSchema,
});

export type BrowserUseApprovalMode = z.infer<typeof BrowserUseApprovalModeSchema>;
export type BrowserUsePolicyResource = z.infer<typeof BrowserUsePolicyResourceSchema>;
export type BrowserUsePolicySnapshot = z.infer<typeof BrowserUsePolicySnapshotSchema>;
export type BrowserUsePolicyModesUpdate = z.infer<typeof BrowserUsePolicyModesUpdateSchema>;
export type BrowserUseOriginRuleUpdate = z.infer<typeof BrowserUseOriginRuleUpdateSchema>;

export const DEFAULT_BROWSER_USE_POLICY: BrowserUsePolicySnapshot = {
  fullCdpAccessEnabled: false,
  approvalMode: "alwaysAsk",
  historyApprovalMode: "alwaysAsk",
  downloadApprovalMode: "alwaysAsk",
  uploadApprovalMode: "alwaysAsk",
  allowedOrigins: [],
  deniedOrigins: [],
  allowedDownloadOrigins: [],
  deniedDownloadOrigins: [],
  allowedUploadOrigins: [],
  deniedUploadOrigins: [],
  allowedFullCdpOrigins: [],
  deniedFullCdpOrigins: [],
};

export function normalizeBrowserUsePolicyOrigin(value: string): string {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Invalid Browser Use origin");
  }
  return BrowserUseOriginSchema.parse(parsed.origin);
}
