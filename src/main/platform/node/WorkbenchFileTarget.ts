/* oxlint-disable effecttsgo/async-function -- Local file identity is resolved at the Node filesystem boundary. */
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Resolves an actual local file without reading its contents or borrowing process cwd. */
export async function resolveWorkbenchFileTarget(input: {
  readonly path: string;
  readonly cwd: string | null;
  readonly roots: readonly string[];
  readonly fullAccess: boolean;
}): Promise<{ readonly path: string; readonly workspaceRoot: string } | null> {
  if (!isAbsolute(input.path) && !input.cwd) return null;
  const requested = isAbsolute(input.path) ? input.path : resolve(input.cwd!, input.path);
  const path = await realpath(requested).catch(() => null);
  if (!path || !(await stat(path).catch(() => null))?.isFile()) return null;
  const roots = await Promise.all(input.roots.map((root) => realpath(root).catch(() => null)));
  const root = roots.find((candidate) => candidate !== null && contains(candidate, path));
  if (!root && !input.fullAccess) return null;
  return { path, workspaceRoot: root ?? dirname(path) };
}
