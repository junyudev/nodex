/** Evidence for the current execution store captured alongside a published content backup. */
export interface ProfileExecutionSnapshot {
  readonly capturedAt: string;
  readonly databaseBytes: number;
  readonly attachmentFiles: number;
  readonly attachmentBytes: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const parseProfileExecutionSnapshot = (value: unknown): ProfileExecutionSnapshot | null => {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Profile execution capture receipt is invalid or unsupported");
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.capturedAt)) ||
    !isCount(receipt.databaseBytes) ||
    !isCount(receipt.attachmentFiles) ||
    !isCount(receipt.attachmentBytes)
  )
    throw new Error("Profile execution capture receipt is invalid or unsupported");
  return {
    capturedAt: receipt.capturedAt,
    databaseBytes: receipt.databaseBytes,
    attachmentFiles: receipt.attachmentFiles,
    attachmentBytes: receipt.attachmentBytes,
  };
};
