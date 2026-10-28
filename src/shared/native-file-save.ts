import { z } from "zod";

export const WorkspaceFileSaveDataInputSchema = z.object({
  fileName: z.string().min(1),
  contentsBase64: z.base64(),
});

export type WorkspaceFileSaveDataInput = z.infer<typeof WorkspaceFileSaveDataInputSchema>;

/** Keeps the proposed native save name valid across supported file systems. */
export function sanitizeNativeSaveFileName(fileName: string): string {
  const clean = fileName.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").replace(/[. ]+$/g, "");
  const suffix = /(?: \([\d.]{1,10}x\))?(?:-\d{1,10})?\.[a-z0-9]{1,10}$/i.exec(clean)?.[0] ?? "";
  const encoder = new TextEncoder();
  const stem = clean.slice(0, clean.length - suffix.length);
  const { read } = encoder.encodeInto(stem, new Uint8Array(254 - encoder.encode(suffix).length));
  const truncated = stem.slice(0, read).replace(/[. ]+$/g, "") || "_";
  const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(truncated);
  return `${reserved ? "_" : ""}${truncated}${suffix}`;
}
