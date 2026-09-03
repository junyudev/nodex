/** Reads the single deployment target declared by a thin Mach-O load-command listing. */
export function parseMachOMinimumMacosVersion(output: string): string | null {
  const versions: string[] = [];
  let command: "build-version" | "version-min" | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("cmd ")) {
      command = trimmed === "cmd LC_BUILD_VERSION" ? "build-version" : null;
      if (trimmed === "cmd LC_VERSION_MIN_MACOSX") command = "version-min";
      continue;
    }
    const match =
      command === "build-version"
        ? /^minos\s+(\d+(?:\.\d+){0,2})$/u.exec(trimmed)
        : command === "version-min"
          ? /^version\s+(\d+(?:\.\d+){0,2})$/u.exec(trimmed)
          : null;
    if (!match?.[1]) continue;
    versions.push(match[1]);
    command = null;
  }
  return versions.length === 1 ? versions[0]! : null;
}
