import { z } from "zod";

const retryKeyPattern = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]){1,128}(?![\s\S])/u;

/**
 * JSON Schema counts a string's length in Unicode characters, so the advertised lengths already say
 * "1 to 128 scalar values". The pattern that checks it exactly stays out of the advertised schema:
 * its lookahead and `\u` escapes don't compile in every Agent's regular expression engine.
 */
export const idempotencyKeySchema = z
  .string()
  .regex(retryKeyPattern, "Idempotency key must contain 1 to 128 Unicode scalar values")
  .meta({ minLength: 1, maxLength: 128, pattern: undefined })
  .describe(
    "Optional: any string of 1 to 128 Unicode scalar values. Nodex remembers a key for 7 days. Use a descriptive prefix and a unique random or timestamp suffix for each new intent. Reuse the key and identical arguments only after an uncertain result.",
  );
