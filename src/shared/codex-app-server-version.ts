const versionPattern =
  /(?:^|\s)(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\s|$)/u;
export const parseCodexCliVersion = (output: string): string | null =>
  versionPattern.exec(output)?.groups?.version ?? null;
/** Desktop connections require the stable 0.141.0 protocol or an explicit development build. */
export const isSupportedCodexAppServerVersion = (version: string): boolean => {
  if (version === "0.0.0") return true;
  const parsed = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.*)?$/u.exec(version);
  if (!parsed) return false;
  const major = Number(parsed[1]),
    minor = Number(parsed[2]),
    patch = Number(parsed[3]);
  return major > 0 || minor > 141 || (minor === 141 && (patch > 0 || parsed[4] === undefined));
};
