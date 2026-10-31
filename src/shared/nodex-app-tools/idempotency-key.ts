import { z } from "zod";

/** Opaque model input; only the host constructs bounded operation identities. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Optional: any string you choose, from 1 to 128 characters. Reuse it with identical arguments only to retry a call whose outcome you did not see. Never needed on a first attempt.",
  );
