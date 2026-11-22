import { z } from "zod";

/**
 * One window's long animation frames over a reporting window, counted only while the window was
 * visible. `worst` describes the longest frame: its style and layout time, and the script that ran
 * longest in it, named by code (invoker, file and function), never by content.
 */
export const RendererFrameHealthSchema = z.strictObject({
  windowMs: z.number().nonnegative(),
  visibleMs: z.number().nonnegative(),
  frames: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  blockingMs: z.number().nonnegative(),
  maxDurationMs: z.number().nonnegative(),
  maxBlockingMs: z.number().nonnegative(),
  worst: z
    .strictObject({
      durationMs: z.number().nonnegative(),
      layoutMs: z.number().nonnegative(),
      script: z
        .strictObject({
          invoker: z.string().max(160),
          source: z.string().max(160),
          durationMs: z.number().nonnegative(),
        })
        .nullable(),
    })
    .nullable(),
});

export type RendererFrameHealth = z.infer<typeof RendererFrameHealthSchema>;
