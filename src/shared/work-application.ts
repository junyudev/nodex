import { z } from "zod";
const identity = z.string().trim().min(1).max(512);
export const startWorkInputSchema = z.strictObject({
  operationId: identity.optional(),
  pageId: identity,
  selection: z
    .strictObject({
      instanceId: identity,
      model: identity,
      effort: z.string().trim().min(1).max(128).nullable(),
    })
    .optional(),
  again: z.boolean().optional(),
});
export interface StartWorkInput {
  readonly operationId?: string;
  readonly pageId: string;
  readonly again?: boolean;
}
export interface StartWorkResult {
  readonly pageId: string;
  readonly sessionId: string;
  readonly launchId: string;
}
