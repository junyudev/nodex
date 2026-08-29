export const CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL = "clipboard:inspect-paste-sync" as const;

export const NODEX_CLIPBOARD_ENVELOPE_META_NAME = "nodex-clipboard-envelope-v1" as const;
export const NODEX_STRUCTURAL_CLIPBOARD_FALLBACK_ATTRIBUTE =
  "data-nodex-structural-fallback" as const;
export const NODEX_CLIPBOARD_WRITE_CLAIM_ATTRIBUTE = "data-nodex-clipboard-write-claim" as const;
export const NODEX_CLIPBOARD_ENVELOPE_MAX_BYTES = 4 * 1024;
const NODEX_CLIPBOARD_ENVELOPE_SCAN_BYTES = NODEX_CLIPBOARD_ENVELOPE_MAX_BYTES * 2;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface NodexClipboardEnvelopeV1 {
  readonly version: 1;
  readonly profileId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly bundleId: string;
  readonly capability: string;
  readonly manifestHash: string;
  readonly actionHint: "copy" | "cut";
}

export interface StructuralClipboardWriteInput {
  readonly envelope: NodexClipboardEnvelopeV1;
  readonly writeClaim: string;
  readonly html: string;
  readonly text: string;
}

export interface ClaimedClipboardPresentationWriteInput {
  readonly writeClaim: string;
  readonly html: string;
  readonly text: string;
}

export type ClaimedClipboardPresentationWriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: "superseded" | "write_failed" | "readback_mismatch";
    };

export type StructuralClipboardWriteResult = ClaimedClipboardPresentationWriteResult;

const ENVELOPE_STRING_KEYS = [
  "profileId",
  "libraryId",
  "storeEpoch",
  "bundleId",
  "capability",
  "manifestHash",
] as const;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function isNodexClipboardEnvelope(value: unknown): value is NodexClipboardEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return false;
  if (candidate.actionHint !== "copy" && candidate.actionHint !== "cut") return false;
  if (Object.keys(candidate).length !== ENVELOPE_STRING_KEYS.length + 2) return false;

  return ENVELOPE_STRING_KEYS.every((key) => {
    const field = candidate[key];
    return typeof field === "string" && field.length > 0 && field.length <= 512;
  });
}

function readMetaAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu");
  return pattern.exec(tag)?.[2] ?? null;
}

function isNodexClipboardMetaTag(tag: string): boolean {
  return readMetaAttribute(tag, "name")?.toLowerCase() === NODEX_CLIPBOARD_ENVELOPE_META_NAME;
}

function stripNodexClipboardMetaTags(html: string): string {
  return html.replace(/<meta\b[^>]*>/giu, (tag) => (isNodexClipboardMetaTag(tag) ? "" : tag));
}

const TYPED_OWNER_HTML_ATTRIBUTE_PATTERN =
  /\sdata-content-type\s*=\s*(?:"(page|database|canvas)"|'(page|database|canvas)'|(page|database|canvas)(?=\s|\/?>))/giu;
const CLIPBOARD_WRITE_CLAIM_HTML_ATTRIBUTE_PATTERN =
  /\sdata-nodex-clipboard-write-claim\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;

function stripNodexClipboardWriteClaims(html: string): string {
  return html.replace(CLIPBOARD_WRITE_CLAIM_HTML_ATTRIBUTE_PATTERN, "");
}

/** Generic HTML is presentation only and must never materialize owner authority. */
export function sanitizeUntrustedTypedOwnerHtml(html: string): string {
  return html.replace(
    TYPED_OWNER_HTML_ATTRIBUTE_PATTERN,
    (_match, doubleQuoted: string, singleQuoted: string, unquoted: string) =>
      ` data-nodex-structural-fallback-type="${doubleQuoted || singleQuoted || unquoted}"`,
  );
}

export function hasUntrustedTypedOwnerHtml(html: string): boolean {
  TYPED_OWNER_HTML_ATTRIBUTE_PATTERN.lastIndex = 0;
  return TYPED_OWNER_HTML_ATTRIBUTE_PATTERN.test(html);
}

export function hasNodexStructuralClipboardFallback(html: string): boolean {
  return new RegExp(`\\b${NODEX_STRUCTURAL_CLIPBOARD_FALLBACK_ATTRIBUTE}\\s*=`, "iu").test(html);
}

/** Encodes the bounded presentation capability; the owned clipboard bundle stays in Core. */
export function encodeNodexClipboardEnvelope(envelope: NodexClipboardEnvelopeV1): string {
  if (!isNodexClipboardEnvelope(envelope)) {
    throw new Error("Invalid Nodex clipboard envelope.");
  }

  const encoded = encodeBase64Url(JSON.stringify(envelope));
  const meta = `<meta name="${NODEX_CLIPBOARD_ENVELOPE_META_NAME}" content="${encoded}">`;
  if (new TextEncoder().encode(meta).byteLength > NODEX_CLIPBOARD_ENVELOPE_MAX_BYTES) {
    throw new Error("Nodex clipboard envelope exceeds its size limit.");
  }
  return meta;
}

export function attachNodexClipboardEnvelope(
  html: string,
  envelope: NodexClipboardEnvelopeV1,
  writeClaim?: string,
): string {
  if (writeClaim !== undefined && !UUID_V7_PATTERN.test(writeClaim)) {
    throw new Error("Invalid structural clipboard write claim.");
  }
  const sidecar = encodeNodexClipboardEnvelope(envelope);
  const fallback = sanitizeUntrustedTypedOwnerHtml(
    stripNodexClipboardWriteClaims(stripNodexClipboardMetaTags(html)),
  );
  const claimAttribute = writeClaim
    ? ` ${NODEX_CLIPBOARD_WRITE_CLAIM_ATTRIBUTE}="${writeClaim}"`
    : "";
  return `<!doctype html><html><head>${sidecar}</head><body><div ${NODEX_STRUCTURAL_CLIPBOARD_FALLBACK_ATTRIBUTE}="1"${claimAttribute}>${fallback}</div></body></html>`;
}

/** Claims the native clipboard synchronously while Core prepares the authoritative snapshot. */
export function attachNodexStructuralClipboardWriteClaim(html: string, writeClaim: string): string {
  if (!UUID_V7_PATTERN.test(writeClaim)) {
    throw new Error("Invalid structural clipboard write claim.");
  }
  const fallback = sanitizeUntrustedTypedOwnerHtml(
    stripNodexClipboardWriteClaims(stripNodexClipboardMetaTags(html)),
  );
  return `<!doctype html><html><head></head><body><div ${NODEX_STRUCTURAL_CLIPBOARD_FALLBACK_ATTRIBUTE}="1" ${NODEX_CLIPBOARD_WRITE_CLAIM_ATTRIBUTE}="${writeClaim}">${fallback}</div></body></html>`;
}

/** Claims ordinary rich clipboard presentation without changing its authority semantics. */
export function attachNodexClipboardWriteClaim(html: string, writeClaim: string): string {
  if (!UUID_V7_PATTERN.test(writeClaim)) {
    throw new Error("Invalid clipboard write claim.");
  }
  const fallback = stripNodexClipboardWriteClaims(stripNodexClipboardMetaTags(html));
  return `<!doctype html><html><head></head><body><div ${NODEX_CLIPBOARD_WRITE_CLAIM_ATTRIBUTE}="${writeClaim}">${fallback}</div></body></html>`;
}

export function readNodexClipboardWriteClaim(html: string): string | null {
  const match = new RegExp(
    `\\b${NODEX_CLIPBOARD_WRITE_CLAIM_ATTRIBUTE}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`,
    "iu",
  ).exec(html);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value && UUID_V7_PATTERN.test(value) ? value : null;
}

export function decodeNodexClipboardEnvelope(html: string): NodexClipboardEnvelopeV1 | null {
  const metaTags =
    html.slice(0, NODEX_CLIPBOARD_ENVELOPE_SCAN_BYTES).match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of metaTags) {
    if (!isNodexClipboardMetaTag(tag)) continue;
    const encoded = readMetaAttribute(tag, "content");
    if (!encoded || new TextEncoder().encode(tag).byteLength > NODEX_CLIPBOARD_ENVELOPE_MAX_BYTES) {
      return null;
    }
    const json = decodeBase64Url(encoded);
    if (!json) return null;
    try {
      const envelope: unknown = JSON.parse(json);
      return isNodexClipboardEnvelope(envelope) ? envelope : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface NodexClipboardHtmlInspection {
  readonly envelope: NodexClipboardEnvelopeV1 | null;
  readonly fallbackHtml: string;
  readonly hasStructuralFallback: boolean;
  readonly writeClaim: string | null;
}

/** Invalid or foreign-looking sidecars are always removed before generic HTML parsing. */
export function inspectNodexClipboardHtml(html: string): NodexClipboardHtmlInspection {
  return {
    envelope: decodeNodexClipboardEnvelope(html),
    fallbackHtml: stripNodexClipboardMetaTags(html),
    hasStructuralFallback: hasNodexStructuralClipboardFallback(html),
    writeClaim: readNodexClipboardWriteClaim(html),
  };
}
