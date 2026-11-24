import { createHash } from "node:crypto";
import path from "node:path";
export function chooseCacheAudits(
  hits: readonly string[],
  seed: string,
  auditedAt: Readonly<Record<string, number>> = {},
  count = 1,
): string[] {
  const ranked = [...new Set(hits)].map((file) => ({
    file,
    lastAudit: auditedAt[file] ?? 0,
    rank: createHash("sha256")
      .update(JSON.stringify([seed, file]))
      .digest("hex"),
  }));
  return ranked
    .toSorted((a, b) => a.lastAudit - b.lastAudit || a.rank.localeCompare(b.rank))
    .slice(0, count)
    .map(({ file }) => file);
}

export function relativeInput(root: string, file: string): string | undefined {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
    return undefined;
  return relative;
}
