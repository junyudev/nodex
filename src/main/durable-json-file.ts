import { syncDirectory } from "./platform/node/filesystem-durability";
export { syncDirectory };
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeDurableJson(
  filePath: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    throw new Error("Durable JSON payload exceeds its size limit");
  }
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
