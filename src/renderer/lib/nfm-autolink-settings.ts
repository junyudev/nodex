import {
  normalizeStoredBoolean,
  writeStoredBoolean,
} from "./storage-boolean";
import { parse as parseDomain } from "tldts";

export const NFM_AUTOLINK_SETTINGS_STORAGE_KEY = "nodex-nfm-autolink-settings-v1";

export interface NfmAutolinkSettings {
  autoLinkWhileTyping: boolean;
  autoLinkOnPaste: boolean;
  linkifyBareDomains: boolean;
}

export const DEFAULT_NFM_AUTOLINK_SETTINGS: NfmAutolinkSettings = {
  autoLinkWhileTyping: true,
  autoLinkOnPaste: true,
  linkifyBareDomains: true,
};

const ALLOWED_AUTOLINK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "ftp:",
  "ftps:",
  "mailto:",
  "tel:",
  "callto:",
  "sms:",
  "cid:",
  "xmpp:",
]);

const LIKELY_LOCAL_FILE_SUFFIXES = new Set([
  "avif",
  "bmp",
  "c",
  "cc",
  "cpp",
  "css",
  "csv",
  "doc",
  "docx",
  "gif",
  "go",
  "heic",
  "html",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "pdf",
  "php",
  "png",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeNfmAutolinkSettings(value: unknown): NfmAutolinkSettings {
  if (!isRecord(value)) return { ...DEFAULT_NFM_AUTOLINK_SETTINGS };

  return {
    autoLinkWhileTyping: normalizeStoredBoolean(
      value.autoLinkWhileTyping,
      DEFAULT_NFM_AUTOLINK_SETTINGS.autoLinkWhileTyping,
    ),
    autoLinkOnPaste: normalizeStoredBoolean(
      value.autoLinkOnPaste,
      DEFAULT_NFM_AUTOLINK_SETTINGS.autoLinkOnPaste,
    ),
    linkifyBareDomains: normalizeStoredBoolean(
      value.linkifyBareDomains,
      DEFAULT_NFM_AUTOLINK_SETTINGS.linkifyBareDomains,
    ),
  };
}

export function readNfmAutolinkSettings(): NfmAutolinkSettings {
  try {
    const raw = localStorage.getItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NFM_AUTOLINK_SETTINGS };
    return normalizeNfmAutolinkSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NFM_AUTOLINK_SETTINGS };
  }
}

export function writeNfmAutolinkSettings(value: unknown): NfmAutolinkSettings {
  const normalized = normalizeNfmAutolinkSettings(value);
  try {
    localStorage.setItem(
      NFM_AUTOLINK_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}

export function writeNfmAutolinkBooleanSetting(
  key: keyof NfmAutolinkSettings,
  value: unknown,
): NfmAutolinkSettings {
  const current = readNfmAutolinkSettings();
  const next = {
    ...current,
    [key]: writeStoredBoolean(
      `${NFM_AUTOLINK_SETTINGS_STORAGE_KEY}:${key}`,
      value,
      DEFAULT_NFM_AUTOLINK_SETTINGS[key],
    ),
  };
  try {
    localStorage.setItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    localStorage.removeItem(`${NFM_AUTOLINK_SETTINGS_STORAGE_KEY}:${key}`);
  } catch {
    // localStorage may be unavailable.
  }
  return next;
}

function hasExplicitProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function looksLikeLocalPath(value: string): boolean {
  if (/^(?:\.{1,2}[\\/]|~[\\/]|\/|[a-z]:[\\/])/i.test(value)) {
    return true;
  }

  const firstSlashIndex = value.search(/[\\/]/);
  if (firstSlashIndex < 0) return false;

  const firstDotIndex = value.indexOf(".");
  return firstDotIndex < 0 || firstSlashIndex < firstDotIndex;
}

function hasLikelyLocalFileSuffix(value: string): boolean {
  const firstSegment = value.split(/[/?#:]/)[0] ?? "";
  const suffix = firstSegment.split(".").pop()?.toLowerCase();
  if (!suffix) return false;
  return LIKELY_LOCAL_FILE_SUFFIXES.has(suffix);
}

function isAllowedAutolinkProtocol(protocol: string): boolean {
  return ALLOWED_AUTOLINK_PROTOCOLS.has(protocol.toLowerCase());
}

function isAutolinkableExplicitUrl(value: string): boolean {
  const parsed = tryParseUrl(value);
  if (!parsed) return false;
  return isAllowedAutolinkProtocol(parsed.protocol);
}

function isAutolinkableWwwUrl(value: string): boolean {
  const parsed = tryParseUrl(`https://${value}`);
  if (!parsed) return false;

  const domain = parseDomain(parsed.hostname, {
    allowPrivateDomains: false,
    mixedInputs: false,
    validateHostname: true,
  });

  if (domain.isIp) return false;
  return domain.isIcann === true && typeof domain.domain === "string";
}

function isProtocolLessAutolinkValue(value: string): boolean {
  return !hasExplicitProtocol(value);
}

function isAllowedLeftAutolinkBoundary(value: string | undefined): boolean {
  if (!value) return true;
  if (/\s/u.test(value)) return true;
  return /[([{<"'`]/u.test(value);
}

function isAllowedRightAutolinkBoundary(value: string | undefined): boolean {
  if (!value) return true;
  if (/\s/u.test(value)) return true;
  return /[)\]}>".,;:!?'"`]/u.test(value);
}

function isProtocolLessMatchEmbeddedInPath(
  fullText: string,
  startIndex: number,
  endIndex: number,
): boolean {
  const previousCharacter = startIndex > 0 ? fullText[startIndex - 1] : undefined;
  const nextCharacter = endIndex < fullText.length ? fullText[endIndex] : undefined;

  if (previousCharacter === "/" || previousCharacter === "\\") {
    return true;
  }

  if (!isAllowedLeftAutolinkBoundary(previousCharacter)) {
    return true;
  }

  if (!isAllowedRightAutolinkBoundary(nextCharacter)) {
    return true;
  }

  return false;
}

function isBareWebLikeDomain(value: string): boolean {
  if (looksLikeLocalPath(value) || hasLikelyLocalFileSuffix(value)) {
    return false;
  }

  const parsed = tryParseUrl(`https://${value}`);
  if (!parsed) return false;

  const domain = parseDomain(parsed.hostname, {
    allowPrivateDomains: false,
    mixedInputs: false,
    validateHostname: true,
  });

  if (domain.isIp) return false;
  return domain.isIcann === true && typeof domain.domain === "string";
}

export function shouldAutoLinkValue(
  value: string,
  options: Pick<NfmAutolinkSettings, "linkifyBareDomains">,
): boolean {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  if (hasExplicitProtocol(trimmed)) return isAutolinkableExplicitUrl(trimmed);
  if (/^www\./i.test(trimmed)) return isAutolinkableWwwUrl(trimmed);

  if (!options.linkifyBareDomains) return false;
  return isBareWebLikeDomain(trimmed);
}

export function shouldAutoLinkMatchInText(
  fullText: string,
  startIndex: number,
  value: string,
  options: Pick<NfmAutolinkSettings, "linkifyBareDomains">,
): boolean {
  if (!shouldAutoLinkValue(value, options)) return false;

  if (!isProtocolLessAutolinkValue(value)) {
    return true;
  }

  return !isProtocolLessMatchEmbeddedInPath(
    fullText,
    startIndex,
    startIndex + value.length,
  );
}
