import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const manifestSchema = z
  .object({
    version: z.literal(1),
    providers: z
      .array(
        z
          .object({
            providerInstanceId: z.string().min(1).max(512),
            driver: z.enum(["codex", "claudeAgent", "opencode", "acpRegistry"]),
            relativeHome: z
              .string()
              .regex(/^native-history\/[a-f0-9]{64}$/u)
              .nullable(),
            continuation: z.enum(["captured", "external"]),
            requiredThreadCount: z.number().int().nonnegative().max(100000),
            credentialPolicy: z.literal("external"),
          })
          .strict(),
      )
      .max(256),
    limitations: z.array(z.string().max(4096)).max(32),
  })
  .strict();
export interface AgentRuntimeNativeHistory {
  readonly driver: "codex" | "claudeAgent";
  readonly homePath: string;
}

const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

/** Only the verified, credential-free native history closure is adopted after restore or clone. */
export async function readAgentRuntimeNativeHistory(
  profileHome: string,
): Promise<ReadonlyMap<string, AgentRuntimeNativeHistory>> {
  const home = resolve(profileHome, "agent-runtime");
  const manifestPath = join(home, "native-history", "manifest.json");
  const entry = await lstat(manifestPath).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });
  if (!entry) return new Map();
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size > MAX_MANIFEST_BYTES
  )
    throw new Error("Native history manifest must be a bounded private regular file");
  const root = await realpath(home);
  const tree = join(root, "native-history");
  if ((await realpath(join(home, "native-history"))) !== tree)
    throw new Error("Native history must remain inside its managed Profile closure");
  const file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: z.infer<typeof manifestSchema>;
  try {
    const stat = await file.stat();
    if (
      stat.ino !== entry.ino ||
      stat.dev !== entry.dev ||
      stat.nlink !== 1 ||
      stat.size > MAX_MANIFEST_BYTES
    )
      throw new Error("Native history manifest changed during admission");
    const data = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let count = 0;
    while (count < data.length) {
      const read = await file.read(data, count, data.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count > MAX_MANIFEST_BYTES)
      throw new Error("Native history manifest exceeds its admission bound");
    parsed = manifestSchema.parse(JSON.parse(data.subarray(0, count).toString("utf8")));
  } finally {
    await file.close();
  }
  const result = new Map<string, AgentRuntimeNativeHistory>();
  const seen = new Set<string>();
  for (const provider of parsed.providers) {
    if (seen.has(provider.providerInstanceId))
      throw new Error("Native history contains duplicate provider identities");
    seen.add(provider.providerInstanceId);
    if (provider.continuation === "external") {
      if (
        provider.relativeHome !== null ||
        provider.driver === "codex" ||
        provider.driver === "claudeAgent"
      )
        throw new Error("Native history continuation does not match its provider");
      continue;
    }
    if (
      provider.relativeHome === null ||
      (provider.driver !== "codex" && provider.driver !== "claudeAgent")
    )
      throw new Error("Captured native history has no supported managed provider");
    const path = join(root, provider.relativeHome);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Captured native history must be a physical managed directory");
    result.set(provider.providerInstanceId, { driver: provider.driver, homePath: path });
  }
  return result;
}
