import type * as Path from "effect/Path";

type PathOperations = Pick<Path.Path, "sep" | "normalize" | "isAbsolute" | "relative" | "join">;

/** Windows canonical paths may carry a namespace prefix absent from stored runtime paths. */
export const profilePathSource = (path: PathOperations, source: string): string => {
  if (path.sep !== "\\") return source;
  return source.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "");
};

/** Relocate only canonical absolute paths contained by the source Profile. */
export const relocateProfilePath = (
  path: PathOperations,
  source: string,
  target: string,
  value: string,
): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) return value;
  const relative = path.relative(profilePathSource(path, source), profilePathSource(path, value));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return value;
  return relative === "" ? target : path.join(target, relative);
};
