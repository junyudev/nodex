/** Validates the native Profile materializer's conversation coverage receipt. */
export interface ProfileConversationSnapshot {
  readonly version: 1;
  readonly captureStartedAt: string;
  readonly captureCompletedAt: string;
  readonly requiredThreadCount: number;
  readonly capturedThreadCount: number;
  readonly externalThreadCount: number;
  readonly missingThreadIds: readonly string[];
  readonly rolloutCount: number;
  readonly nativeStateSchema: "state_5" | null;
  readonly contentSha256: string;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const parseProfileConversationSnapshot = (value: unknown): ProfileConversationSnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "This development Profile has no conversation snapshot. Create a new --home with --from-profile to include native history.",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.version !== 1 ||
    typeof receipt.captureStartedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.captureStartedAt)) ||
    typeof receipt.captureCompletedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.captureCompletedAt)) ||
    Date.parse(receipt.captureCompletedAt) < Date.parse(receipt.captureStartedAt) ||
    !isCount(receipt.requiredThreadCount) ||
    !isCount(receipt.capturedThreadCount) ||
    !isCount(receipt.externalThreadCount) ||
    !isCount(receipt.rolloutCount) ||
    !Array.isArray(receipt.missingThreadIds) ||
    !receipt.missingThreadIds.every(
      (id): id is string => typeof id === "string" && id.length > 0,
    ) ||
    new Set(receipt.missingThreadIds).size !== receipt.missingThreadIds.length ||
    receipt.capturedThreadCount + receipt.missingThreadIds.length !== receipt.requiredThreadCount ||
    (receipt.nativeStateSchema !== null && receipt.nativeStateSchema !== "state_5") ||
    typeof receipt.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.contentSha256)
  ) {
    throw new Error("Profile conversation snapshot receipt is invalid or unsupported");
  }
  return {
    version: 1,
    captureStartedAt: receipt.captureStartedAt,
    captureCompletedAt: receipt.captureCompletedAt,
    requiredThreadCount: receipt.requiredThreadCount,
    capturedThreadCount: receipt.capturedThreadCount,
    externalThreadCount: receipt.externalThreadCount,
    missingThreadIds: receipt.missingThreadIds,
    rolloutCount: receipt.rolloutCount,
    nativeStateSchema: receipt.nativeStateSchema,
    contentSha256: receipt.contentSha256,
  };
};
