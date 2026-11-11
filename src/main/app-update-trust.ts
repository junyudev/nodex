import { APP_UPDATE_BUILD_VERSION_PATTERN } from "../shared/app-version";

/** Shared release signing authority. Packaged configuration cannot replace this key. */
export const APP_UPDATE_PUBLIC_KEY = "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs=";

/** Release Identity versions are numeric tuples, never display-version semver or floats. */
export function compareAppBuildVersions(left: string, right: string): number {
  if (
    !APP_UPDATE_BUILD_VERSION_PATTERN.test(left) ||
    !APP_UPDATE_BUILD_VERSION_PATTERN.test(right)
  ) {
    throw new Error("App update build version is invalid.");
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a.reduce((order, part, index) => order || Math.sign(part - b[index]!), 0);
}
