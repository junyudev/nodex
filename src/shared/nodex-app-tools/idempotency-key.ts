import { z } from "zod";

// Accepts a scalar in both Unicode-aware and UTF-16 regular expression engines.
const retryKeyPattern = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]){1,128}(?![\s\S])/u;

export const idempotencyKeySchema = z
  .string()
  .regex(retryKeyPattern, "Idempotency key must contain 1 to 128 Unicode scalar values")
  .meta({ minLength: 1, maxLength: 128 })
  .describe(
    "Optional: any string of 1 to 128 Unicode scalar values. Nodex remembers a key for 7 days. Use a descriptive prefix and a unique random or timestamp suffix for each new intent. Reuse the key and identical arguments only after an uncertain result.",
  );
