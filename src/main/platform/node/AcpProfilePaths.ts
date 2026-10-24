import { realpath } from "node:fs/promises";
import { dirname, basename, isAbsolute, join } from "node:path";

/** Missing profile folders still resolve through their nearest existing physical ancestor. */
export async function canonicalAcpProfilePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Agent profile paths must be absolute.");
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      suffix.push(basename(current));
      current = parent;
    }
  }
}
export async function acpNativeStorageScope(
  environment: readonly {
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
  }[],
): Promise<string> {
  const directories = environment.filter(
    ({ name, sensitive, value }) =>
      !sensitive &&
      isAbsolute(value) &&
      /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME)$|_(?:CONFIG_DIR|HOME)$/u.test(
        name,
      ),
  );
  const normalized = await Promise.all(
    directories.map(
      async ({ name, value }) => [name, await canonicalAcpProfilePath(value)] as const,
    ),
  );
  return JSON.stringify(normalized.sort(([left], [right]) => left.localeCompare(right)));
}
