import { z } from "zod";

const cloudRequirementsFailure = z.object({
  data: z.object({
    reason: z.enum(["cloudRequirements", "cloudConfigBundle"]),
    errorCode: z.string().optional(),
    action: z.string().optional(),
  }),
});

/** Only structured configuration failures can invalidate authentication without native logout. */
export function isCodexCloudRequirementsAuthFailure(error: unknown): boolean {
  const result = cloudRequirementsFailure.safeParse(error);
  return (
    result.success &&
    (result.data.data.errorCode === "Auth" || result.data.data.action === "relogin")
  );
}
