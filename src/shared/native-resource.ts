import { z } from "zod";

export const NativeResourceReadInputSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
  })
  .strict();

export const BrowserLinkSaveInputSchema = NativeResourceReadInputSchema.extend({
  conversationId: z.string().optional(),
}).strict();

export type NativeResourceReadInput = z.infer<typeof NativeResourceReadInputSchema>;
export interface NativeResourceData {
  readonly contentsBase64: string;
  readonly mimeType: string;
}
