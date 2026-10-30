import * as Schema from "effect/Schema";
import type { StructuredGenerationImage } from "@t3tools/provider-core/server/textGeneration";

/** Main fits images before they cross this transport boundary. */
export const PromptImage = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isBase64()),
}) satisfies Schema.Codec<StructuredGenerationImage>;
