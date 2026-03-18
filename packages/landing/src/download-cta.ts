export type MacDownloadArch = "arm64" | "x64";

const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/Asphocarp/nodex/releases/latest/download";

type NavigatorUADataLike = {
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
  platform?: string;
};

export type NavigatorLike = {
  platform?: string;
  userAgent?: string;
  userAgentData?: NavigatorUADataLike;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeLowercase(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isMacLikeNavigator(navigatorLike: NavigatorLike): boolean {
  const platform = normalizeLowercase(navigatorLike.platform);
  if (platform.includes("mac")) {
    return true;
  }

  const uaPlatform = normalizeLowercase(navigatorLike.userAgentData?.platform);
  if (uaPlatform.includes("mac")) {
    return true;
  }

  const userAgent = normalizeLowercase(navigatorLike.userAgent);
  return userAgent.includes("mac os x") || userAgent.includes("macintosh");
}

function hasExplicitMacIntelUserAgent(navigatorLike: NavigatorLike): boolean {
  if (!isMacLikeNavigator(navigatorLike)) {
    return false;
  }

  const userAgent = normalizeLowercase(navigatorLike.userAgent);
  return /\b(x86_64|x64|intel)\b/i.test(userAgent);
}

async function resolveClientHintArch(navigatorLike: NavigatorLike): Promise<MacDownloadArch | null> {
  if (!isMacLikeNavigator(navigatorLike)) {
    return null;
  }

  const userAgentData = navigatorLike.userAgentData;
  if (!userAgentData?.getHighEntropyValues) {
    return null;
  }

  try {
    const values = await userAgentData.getHighEntropyValues(["architecture"]);
    const architecture = normalizeLowercase(values.architecture);

    if (!isNonEmptyString(architecture)) {
      return null;
    }

    if (architecture.includes("arm") || architecture.includes("aarch64")) {
      return "arm64";
    }

    if (architecture.includes("x86") || architecture.includes("x64") || architecture.includes("intel")) {
      return "x64";
    }
  } catch {
    return null;
  }

  return null;
}

export function resolvePreferredMacDownloadArch(navigatorLike: NavigatorLike): MacDownloadArch {
  if (hasExplicitMacIntelUserAgent(navigatorLike)) {
    return "x64";
  }

  return "arm64";
}

export function resolveLatestMacDownloadUrl(arch: MacDownloadArch): string {
  const filename = arch === "arm64" ? "Nodex-latest-arm64.dmg" : "Nodex-latest-x64.dmg";
  return `${RELEASE_DOWNLOAD_BASE_URL}/${filename}`;
}

export async function upgradeLandingDownloadLink(
  anchor: HTMLAnchorElement,
  navigatorLike: NavigatorLike,
): Promise<void> {
  const hintedArch = await resolveClientHintArch(navigatorLike);
  const arch = hintedArch ?? resolvePreferredMacDownloadArch(navigatorLike);
  anchor.href = resolveLatestMacDownloadUrl(arch);
}

function initializeLandingDownloadLink(): void {
  if (typeof document === "undefined") {
    return;
  }

  const anchor = document.getElementById("landing-download-button");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }

  void upgradeLandingDownloadLink(anchor, navigator);
}

initializeLandingDownloadLink();
