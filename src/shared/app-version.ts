export const APP_UPDATE_BUILD_VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u;

/** Invert the release build version's encoding of the positive first-parent ordinal. */
export function appBuildOrdinal(buildVersion: string | null | undefined): number | null {
  if (!buildVersion || !APP_UPDATE_BUILD_VERSION_PATTERN.test(buildVersion)) return null;
  const [major, minor, patch] = buildVersion.split(".");
  const ordinal = (Number(major) - 1) * 10_000 + Number(minor) * 100 + Number(patch);
  return ordinal > 0 ? ordinal : null;
}

export function formatAppVersion(version: string, buildVersion?: string | null): string {
  const ordinal = appBuildOrdinal(buildVersion);
  return ordinal === null ? version : `${version} (${ordinal})`;
}
