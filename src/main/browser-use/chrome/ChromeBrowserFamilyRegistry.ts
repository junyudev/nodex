import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const MAX_DESCRIPTOR_BYTES = 256 * 1024;

export type ChromeBrowserFamily = string;

export interface ChromeBrowserFamilyDescriptor {
  readonly applicationNames: readonly string[];
  readonly browserIconAssetPath: string;
  readonly bundleId: string;
  readonly displayName: string;
  readonly extensionIds: readonly string[];
  readonly extensionManagementUrl: string;
  readonly family: ChromeBrowserFamily;
  readonly nativeMessagingManifestDirectories: readonly string[];
  readonly processNames: readonly string[];
  readonly shortDisplayName: string;
  readonly storeUrl: string;
  readonly userDataDirectorySegments: readonly string[];
}

/** Authority projected from the hash-attested Chrome runtime family descriptor. */
export interface ChromeBrowserAuthority {
  readonly extensionIds: readonly string[];
  readonly families: readonly ChromeBrowserFamilyDescriptor[];
  readonly hostName: string;
}

export interface LoadChromeBrowserAuthorityOptions {
  readonly descriptorPath: string;
  readonly expectedExtensionIds: readonly string[];
  readonly expectedHostName: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${label} is invalid`);
  }
  const entries = value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicates`);
  return entries;
}

function extensionIds(value: unknown, label: string): readonly string[] {
  const entries = stringArray(value, label);
  if (!entries.every((entry) => /^[a-p]{32}$/u.test(entry))) {
    throw new Error(`${label} contains an invalid extension ID`);
  }
  return entries;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((entry, index) => entry === sortedRight[index]);
}

function safeFamily(value: unknown): ChromeBrowserFamily {
  const family = boundedString(value, "Chrome browser family");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(family)) {
    throw new Error("Chrome browser family is invalid");
  }
  return family;
}

function safeHostName(value: unknown): string {
  const hostName = boundedString(value, "Chrome native messaging host name");
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u.test(hostName)) {
    throw new Error("Chrome native messaging host name is invalid");
  }
  return hostName;
}

function safeRelativeDirectory(value: string, label: string): string {
  if (path.posix.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a portable relative directory`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return value;
}

function safePathSegments(value: unknown, label: string): readonly string[] {
  const entries = stringArray(value, label);
  if (entries.some((entry) => entry.includes("/") || entry.includes("\\"))) {
    throw new Error(`${label} contains a nested path segment`);
  }
  return entries;
}

function parseBrowserExtensions(
  value: unknown,
  allowedExtensionIds: readonly string[],
): ReadonlyMap<
  string,
  {
    readonly browserIconAssetPath: string;
    readonly extensionIds: readonly string[];
    readonly storeUrl: string;
  }
> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("Chrome browser extension descriptor is invalid");
  }
  const parsed = new Map<
    string,
    {
      readonly browserIconAssetPath: string;
      readonly extensionIds: readonly string[];
      readonly storeUrl: string;
    }
  >();
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("Chrome browser extension entry is invalid");
    const family = safeFamily(entry.browserFamily);
    const familyExtensionIds = extensionIds(entry.extensionIds, `Chrome ${family} extension IDs`);
    if (familyExtensionIds.some((extensionId) => !allowedExtensionIds.includes(extensionId))) {
      throw new Error(`Chrome ${family} extension authority escaped the manifest allowlist`);
    }
    if (parsed.has(family)) throw new Error(`Chrome browser family ${family} is duplicated`);
    const browserIconAssetPath = safeRelativeDirectory(
      boundedString(entry.browserIconAssetPath, `Chrome ${family} browser icon path`),
      `Chrome ${family} browser icon path`,
    );
    parsed.set(family, {
      browserIconAssetPath,
      extensionIds: familyExtensionIds,
      storeUrl: boundedString(entry.storeUrl, `Chrome ${family} store URL`),
    });
  }
  return parsed;
}

function parseMacosFamily(
  value: unknown,
  family: string,
): Pick<
  ChromeBrowserFamilyDescriptor,
  | "applicationNames"
  | "bundleId"
  | "nativeMessagingManifestDirectories"
  | "processNames"
  | "userDataDirectorySegments"
> {
  if (!isRecord(value)) throw new Error(`Chrome ${family} macOS descriptor is invalid`);
  const bundleId = boundedString(value.bundleId, `Chrome ${family} bundle ID`);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(bundleId)) {
    throw new Error(`Chrome ${family} bundle ID is invalid`);
  }
  return {
    applicationNames: stringArray(value.applicationNames, `Chrome ${family} app names`),
    bundleId,
    nativeMessagingManifestDirectories: stringArray(
      value.nativeMessagingManifestDirectories,
      `Chrome ${family} native messaging directories`,
    ).map((directory) =>
      safeRelativeDirectory(directory, `Chrome ${family} native messaging directory`),
    ),
    processNames: stringArray(value.processNames, `Chrome ${family} process names`),
    userDataDirectorySegments: safePathSegments(
      value.userDataDirectorySegments,
      `Chrome ${family} user data path`,
    ),
  };
}

export function parseChromeBrowserAuthority(
  value: unknown,
  expected: {
    readonly extensionIds: readonly string[];
    readonly hostName: string;
  },
): ChromeBrowserAuthority {
  if (!isRecord(value)) throw new Error("Chrome browser family descriptor must be an object");
  const expectedExtensionIds = extensionIds(expected.extensionIds, "Chrome manifest extension IDs");
  const descriptorExtensionIds = extensionIds(
    value.extensionIds,
    "Chrome descriptor extension IDs",
  );
  if (!sameStrings(descriptorExtensionIds, expectedExtensionIds)) {
    throw new Error("Chrome descriptor extension IDs do not match the runtime manifest");
  }
  const hostName = safeHostName(value.extensionHostName);
  if (hostName !== safeHostName(expected.hostName)) {
    throw new Error("Chrome descriptor host name does not match the runtime manifest");
  }

  const browserExtensions = parseBrowserExtensions(value.browserExtensions, descriptorExtensionIds);
  if (!Array.isArray(value.browserDiagnostics) || value.browserDiagnostics.length === 0) {
    throw new Error("Chrome browser diagnostics descriptor is invalid");
  }

  const families: ChromeBrowserFamilyDescriptor[] = [];
  const seenFamilies = new Set<string>();
  for (const diagnostic of value.browserDiagnostics) {
    if (!isRecord(diagnostic)) throw new Error("Chrome browser diagnostic entry is invalid");
    const family = safeFamily(diagnostic.browserFamily);
    if (seenFamilies.has(family)) throw new Error(`Chrome browser family ${family} is duplicated`);
    seenFamilies.add(family);
    const browserExtension = browserExtensions.get(family);
    if (!browserExtension) {
      throw new Error(`Chrome browser family ${family} has no extension descriptor`);
    }
    const diagnosticExtensionIds = extensionIds(
      diagnostic.extensionIds,
      `Chrome ${family} diagnostic extension IDs`,
    );
    if (!sameStrings(diagnosticExtensionIds, browserExtension.extensionIds)) {
      throw new Error(`Chrome ${family} extension authority is inconsistent`);
    }
    const macos = parseMacosFamily(diagnostic.macos, family);
    families.push({
      ...macos,
      browserIconAssetPath: browserExtension.browserIconAssetPath,
      displayName: boundedString(diagnostic.displayName, `Chrome ${family} display name`),
      extensionIds: browserExtension.extensionIds,
      extensionManagementUrl: boundedString(
        diagnostic.extensionManagementUrl,
        `Chrome ${family} extension management URL`,
      ),
      family,
      shortDisplayName: boundedString(
        diagnostic.shortDisplayName,
        `Chrome ${family} short display name`,
      ),
      storeUrl: browserExtension.storeUrl,
    });
  }
  if (seenFamilies.size !== browserExtensions.size) {
    throw new Error("Chrome family descriptor contains an unsupported browser variant");
  }

  return {
    extensionIds: descriptorExtensionIds,
    families: families.sort((left, right) => left.family.localeCompare(right.family)),
    hostName,
  };
}

/** Reads the already-attested descriptor without following a replacement symlink. */
export async function loadChromeBrowserAuthority(
  options: LoadChromeBrowserAuthorityOptions,
): Promise<ChromeBrowserAuthority> {
  const descriptorPath = path.resolve(options.descriptorPath);
  if (!path.isAbsolute(options.descriptorPath) || descriptorPath !== options.descriptorPath) {
    throw new Error("Chrome browser family descriptor path is not canonical");
  }
  const handle = await fs.open(
    descriptorPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.size !== options.expectedSize ||
      stats.size > MAX_DESCRIPTOR_BYTES
    ) {
      throw new Error("Chrome browser family descriptor does not match its manifest artifact");
    }
    const bytes = await handle.readFile();
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== options.expectedSha256) {
      throw new Error("Chrome browser family descriptor failed its manifest hash check");
    }
    return parseChromeBrowserAuthority(JSON.parse(bytes.toString("utf8")) as unknown, {
      extensionIds: options.expectedExtensionIds,
      hostName: options.expectedHostName,
    });
  } finally {
    await handle.close();
  }
}

export function getChromeBrowserFamily(
  authority: ChromeBrowserAuthority,
  family: string,
): ChromeBrowserFamilyDescriptor | null {
  return authority.families.find((descriptor) => descriptor.family === family) ?? null;
}

export function getChromeBrowserFamilyByBundleId(
  authority: ChromeBrowserAuthority,
  bundleId: string,
): ChromeBrowserFamilyDescriptor | null {
  return authority.families.find((descriptor) => descriptor.bundleId === bundleId) ?? null;
}

export function resolveChromeNativeMessagingManifestPaths(
  homeDirectory: string,
  authority: ChromeBrowserAuthority,
): readonly string[] {
  const resolvedHome = path.resolve(homeDirectory);
  const fileName = `${safeHostName(authority.hostName)}.json`;
  return [
    ...new Set(
      authority.families.flatMap((descriptor) =>
        descriptor.nativeMessagingManifestDirectories.map((directory) => {
          const destination = path.resolve(resolvedHome, directory, fileName);
          if (!destination.startsWith(`${resolvedHome}${path.sep}`)) {
            throw new Error("Chrome native messaging manifest escaped the user home");
          }
          return destination;
        }),
      ),
    ),
  ];
}
