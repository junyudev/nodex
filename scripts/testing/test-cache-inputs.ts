import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { relativeInput } from "./test-cache-policy.ts";

export const cleanId = (id: string) => id.split(/[?#]/u, 1)[0];

export type PathState = "absent" | "directory" | "file";

export interface LocalInputs {
  readonly probes: Readonly<Record<string, PathState>>;
  readonly globs: Readonly<Record<string, readonly string[]>>;
  readonly topology?: string;
}

export function portablePath(file: string) {
  return (
    file !== "" &&
    file !== "." &&
    file !== ".." &&
    !file.startsWith("../") &&
    !path.isAbsolute(file) &&
    path.posix.normalize(file) === file
  );
}

function memoize<T>(read: (key: string) => Promise<T>) {
  const reads = new Map<string, Promise<T>>();
  const get = (key: string) => {
    const cached = reads.get(key);
    if (cached) return cached;
    const pending = read(key);
    reads.set(key, pending);
    return pending;
  };
  return Object.assign(get, { reads });
}

/** Observe names directly, including untracked paths and case-insensitive filesystem lookups. */
export function localInputReader(root: string) {
  const canonicalRoot = realpath(root).catch(() => undefined);
  const state = memoize(async (file): Promise<PathState | undefined> => {
    const absolute = path.join(root, file);
    try {
      const entry = await lstat(absolute);
      const canonical = await canonicalRoot;
      if (
        !canonical ||
        (!entry.isFile() && !entry.isDirectory()) ||
        (await realpath(absolute)) !== path.join(canonical, file)
      )
        return undefined;
      return entry.isFile() ? "file" : "directory";
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return "absent";
      return undefined;
    }
  });
  const glob = memoize(async (pattern): Promise<readonly string[] | undefined> => {
    const directory = path.posix.dirname(pattern);
    const basename = path.posix.basename(pattern);
    if (!simpleGlob(pattern)) return undefined;
    const directoryState = await state(directory);
    if (directoryState === "absent") return [];
    if (directoryState !== "directory") return undefined;
    const [prefix, suffix] = basename.split("*");
    try {
      const entries = await readdir(path.join(root, directory), { withFileTypes: true });
      const matches = entries.filter(
        ({ name }) =>
          !name.startsWith(".") &&
          name.length >= prefix.length + suffix.length &&
          name.startsWith(prefix) &&
          name.endsWith(suffix),
      );
      if (matches.some((entry) => !entry.isFile() && !entry.isDirectory())) return undefined;
      return matches
        .filter((entry) => entry.isFile())
        .map(({ name }) => path.posix.join(directory, name))
        .sort();
    } catch {
      return undefined;
    }
  });
  return {
    state,
    glob,
    async unchanged() {
      const current = localInputReader(root);
      const changes = await Promise.all([
        ...[...state.reads].map(
          async ([file, previous]) => (await previous) !== (await current.state(file)),
        ),
        ...[...glob.reads].map(async ([pattern, previous]) => {
          const before = await previous;
          const after = await current.glob(pattern);
          return before !== after && (!before || !after || !sameMembers(before, after));
        }),
      ]);
      return !changes.some(Boolean);
    },
  };
}

export const sameMembers = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((name, index) => name === right[index]);

export function simpleGlob(pattern: string) {
  return (
    /^(?:[\w.-]+\/)*[\w.-]*\*[\w.-]*$/u.test(pattern) &&
    path.posix.normalize(pattern) === pattern &&
    !pattern.startsWith("../") &&
    !pattern.split("/").includes("node_modules") &&
    !path.posix.basename(pattern).startsWith(".")
  );
}

// The pinned Vite resolver probes direct files, JS-to-TS substitutions, extensions,
// then directory package entries and index extensions. Verify every earlier candidate
// and accept only an actual resolver result in this sequence.
export async function resolutionProbes(
  root: string,
  importer: string,
  request: string,
  resolved: string,
  extensions: readonly string[],
  reader: ReturnType<typeof localInputReader>,
) {
  const specifier = cleanId(request);
  const base = specifier.startsWith("@/")
    ? path.resolve(root, "src/renderer", specifier.slice(2))
    : /^\.\.?\//u.test(specifier)
      ? path.resolve(path.dirname(importer), specifier)
      : undefined;
  if (!base || !relativeInput(root, base) || !/^[\w./@ -]+$/u.test(specifier)) return undefined;
  const target = relativeInput(root, cleanId(resolved));
  if (!target || specifier.endsWith("/")) return undefined;
  const extension = path.extname(base);
  const substitutes = /^(?:\.js|\.jsx|\.mjs|\.cjs)$/u.test(extension)
    ? [
        base.slice(0, -extension.length) + extension.replace("js", "ts"),
        ...(extension === ".js" ? [base.slice(0, -3) + ".tsx"] : []),
      ]
    : [];
  const candidates = [
    base,
    ...substitutes,
    ...extensions.map((suffix) => base + suffix),
    path.join(base, "package.json"),
    ...extensions.map((suffix) => path.join(base, "index" + suffix)),
  ].map((candidate) => relativeInput(root, candidate)!);
  const index = candidates.indexOf(target);
  if (index < 0 || (await reader.state(target)) !== "file") return undefined;

  const probes: Record<string, PathState> = { [target]: "file" };
  for (const candidate of candidates.slice(0, index)) {
    const state = await reader.state(candidate);
    if (state === "absent" || (state === "directory" && candidate === candidates[0])) {
      probes[candidate] = state;
      continue;
    }
    return undefined;
  }
  return probes;
}

// These workspace exports are fixed by the shared package manifests. Match the
// actual target and every branch of a conditional export before using local evidence.
export function workspaceExportReader(root: string, workspace: ReadonlySet<string>) {
  const manifest = memoize(
    async (file): Promise<{ name?: string; exports?: unknown } | undefined> =>
      readFile(path.join(root, file), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined),
  );
  const pointsTo = (value: unknown, target: string, wildcard?: string): boolean => {
    if (typeof value === "string")
      return (wildcard === undefined ? value : value.replaceAll("*", () => wildcard)) === target;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const conditions = Object.values(value);
    return (
      conditions.length > 0 &&
      conditions.every((condition) => pointsTo(condition, target, wildcard))
    );
  };
  const exportMatches = (value: unknown, key: string, target: string) => {
    if (typeof value === "string") return key === "." && pointsTo(value, target);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    if (Object.hasOwn(value, key)) return pointsTo((value as Record<string, unknown>)[key], target);
    if (key === "." && !entries.some(([entry]) => entry.startsWith(".")))
      return pointsTo(value, target);
    // Exact subpaths win. Require one matching pattern so precedence cannot
    // select another export.
    const patterns = entries.flatMap(([pattern, exportValue]) => {
      const [prefix, suffix, extra] = pattern.split("*");
      if (
        suffix === undefined ||
        extra !== undefined ||
        !prefix.startsWith("./") ||
        key.length <= prefix.length + suffix.length ||
        !key.startsWith(prefix) ||
        !key.endsWith(suffix)
      )
        return [];
      return [{ exportValue, wildcard: key.slice(prefix.length, key.length - suffix.length) }];
    });
    return patterns.length === 1 && pointsTo(patterns[0].exportValue, target, patterns[0].wildcard);
  };

  return async (request: string, file: string) => {
    if (!workspace.has(file)) return false;
    const [, name, subpath] = /^((?:@[\w.-]+\/)?[\w.-]+)(\/.*)?$/u.exec(request) ?? [];
    if (!name) return false;
    const key = subpath ? "." + subpath : ".";
    for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
      const candidate = path.posix.join(directory, "package.json");
      const data = workspace.has(candidate) ? await manifest(candidate) : undefined;
      // An export can point at a file inside a nested package with its own name.
      if (data?.name === name)
        return exportMatches(data.exports, key, "./" + path.posix.relative(directory, file));
      if (directory === ".") return false;
    }
  };
}
