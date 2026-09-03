export const BROWSER_PIP_IMAGE_LIMITS = {
  maximumCompressedBytes: 24 * 1024 * 1024,
  maximumDecodedBytesPerProcess: 256 * 1024 * 1024,
  maximumDecodedBytesPerSession: 64 * 1024 * 1024,
  maximumDecodedBytesPerThread: 128 * 1024 * 1024,
  maximumDimension: 8_192,
  maximumPixelCount: 16_777_216,
  maximumPresentationsPerProcess: 128,
  maximumPresentationsPerSession: 64,
  maximumPresentationsPerThread: 96,
} as const;

export type BrowserPipImageRejection =
  | "dimensions-too-large"
  | "header-mismatch"
  | "invalid-base64"
  | "pixel-budget-exceeded"
  | "process-quota"
  | "session-quota"
  | "thread-quota"
  | "unsupported-mime"
  | "wire-too-large";

export interface ValidatedBrowserPipImage {
  readonly compressedBytes: number;
  readonly dataUrl: string;
  readonly estimatedDecodedBytes: number;
  readonly height: number;
  readonly mime: "image/jpeg" | "image/png";
  readonly pixelCount: number;
  readonly width: number;
}

export type BrowserPipImageValidationResult =
  | { readonly accepted: true; readonly image: ValidatedBrowserPipImage }
  | { readonly accepted: false; readonly reason: BrowserPipImageRejection };

export interface BrowserPipResourceLease {
  readonly compressedBytes: number;
  readonly estimatedDecodedBytes: number;
  readonly presentationId: string;
  readonly sessionKey: string;
  readonly taskId: string;
  readonly updatedAt: number;
}

export interface BrowserPipResourceState {
  readonly leases: ReadonlyMap<string, BrowserPipResourceLease>;
}

export interface BrowserPipResourceAdmission {
  readonly admitted: BrowserPipResourceLease | null;
  readonly evicted: readonly BrowserPipResourceLease[];
  readonly reason: BrowserPipImageRejection | null;
  readonly state: BrowserPipResourceState;
}

export interface BrowserPipResourceLimits {
  readonly maximumDecodedBytesPerProcess: number;
  readonly maximumDecodedBytesPerSession: number;
  readonly maximumDecodedBytesPerThread: number;
  readonly maximumPresentationsPerProcess: number;
  readonly maximumPresentationsPerSession: number;
  readonly maximumPresentationsPerThread: number;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const rejection = (reason: BrowserPipImageRejection): BrowserPipImageValidationResult => ({
  accepted: false,
  reason,
});

function parsePngDimensions(
  bytes: Buffer,
): { readonly height: number; readonly width: number } | null {
  if (bytes.length < 24) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpegDimensions(
  bytes: Buffer,
): { readonly height: number; readonly width: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

/** Validates canonical base64 and raster headers before bytes cross the native decode boundary. */
export function validateBrowserPipImage(dataUrl: string): BrowserPipImageValidationResult {
  const separatorIndex = dataUrl.indexOf(",");
  if (separatorIndex <= 0) return rejection("unsupported-mime");
  const prefix = dataUrl.slice(0, separatorIndex);
  const mime =
    prefix === "data:image/png;base64"
      ? "image/png"
      : prefix === "data:image/jpeg;base64"
        ? "image/jpeg"
        : null;
  if (!mime) return rejection("unsupported-mime");

  const encoded = dataUrl.slice(separatorIndex + 1);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return rejection("invalid-base64");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const compressedBytes = (encoded.length / 4) * 3 - padding;
  if (compressedBytes > BROWSER_PIP_IMAGE_LIMITS.maximumCompressedBytes) {
    return rejection("wire-too-large");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== compressedBytes || bytes.toString("base64") !== encoded) {
    return rejection("invalid-base64");
  }
  const dimensions = mime === "image/png" ? parsePngDimensions(bytes) : parseJpegDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return rejection("header-mismatch");
  }
  if (
    dimensions.width > BROWSER_PIP_IMAGE_LIMITS.maximumDimension ||
    dimensions.height > BROWSER_PIP_IMAGE_LIMITS.maximumDimension
  ) {
    return rejection("dimensions-too-large");
  }
  const pixelCount = dimensions.width * dimensions.height;
  if (
    !Number.isSafeInteger(pixelCount) ||
    pixelCount > BROWSER_PIP_IMAGE_LIMITS.maximumPixelCount
  ) {
    return rejection("pixel-budget-exceeded");
  }
  const estimatedDecodedBytes = pixelCount * 4;
  if (!Number.isSafeInteger(estimatedDecodedBytes)) return rejection("pixel-budget-exceeded");
  return {
    accepted: true,
    image: {
      compressedBytes,
      dataUrl,
      estimatedDecodedBytes,
      height: dimensions.height,
      mime,
      pixelCount,
      width: dimensions.width,
    },
  };
}

export const emptyBrowserPipResourceState = (): BrowserPipResourceState => ({ leases: new Map() });

function totals(leases: Iterable<BrowserPipResourceLease>): {
  readonly bytes: number;
  readonly count: number;
} {
  let bytes = 0;
  let count = 0;
  for (const lease of leases) {
    bytes += lease.estimatedDecodedBytes;
    count += 1;
  }
  return { bytes, count };
}

function quotaReason(
  leases: ReadonlyMap<string, BrowserPipResourceLease>,
  candidate: BrowserPipResourceLease,
  limits: BrowserPipResourceLimits,
): BrowserPipImageRejection | null {
  const process = totals(leases.values());
  if (
    process.count > limits.maximumPresentationsPerProcess ||
    process.bytes > limits.maximumDecodedBytesPerProcess
  ) {
    return "process-quota";
  }
  const thread = totals([...leases.values()].filter((lease) => lease.taskId === candidate.taskId));
  if (
    thread.count > limits.maximumPresentationsPerThread ||
    thread.bytes > limits.maximumDecodedBytesPerThread
  ) {
    return "thread-quota";
  }
  const session = totals(
    [...leases.values()].filter((lease) => lease.sessionKey === candidate.sessionKey),
  );
  return session.count > limits.maximumPresentationsPerSession ||
    session.bytes > limits.maximumDecodedBytesPerSession
    ? "session-quota"
    : null;
}

/**
 * Admits a replacement lease and evicts the oldest unrelated presentations until all aggregate
 * quotas fit. The current presentation is never selected as its own eviction victim.
 */
export function admitBrowserPipResource(
  state: BrowserPipResourceState,
  candidate: BrowserPipResourceLease,
  limits: BrowserPipResourceLimits = BROWSER_PIP_IMAGE_LIMITS,
): BrowserPipResourceAdmission {
  const leases = new Map(state.leases);
  leases.delete(candidate.presentationId);
  leases.set(candidate.presentationId, candidate);
  const evicted: BrowserPipResourceLease[] = [];
  let reason = quotaReason(leases, candidate, limits);
  const candidates = [...leases.values()]
    .filter((lease) => lease.presentationId !== candidate.presentationId)
    .sort(
      (left, right) =>
        left.updatedAt - right.updatedAt || left.presentationId.localeCompare(right.presentationId),
    );
  while (reason && candidates.length > 0) {
    const victim = candidates.shift();
    if (!victim) break;
    leases.delete(victim.presentationId);
    evicted.push(victim);
    reason = quotaReason(leases, candidate, limits);
  }
  if (reason) {
    return { admitted: null, evicted: [], reason, state };
  }
  return { admitted: candidate, evicted, reason: null, state: { leases } };
}

export function releaseBrowserPipResources(
  state: BrowserPipResourceState,
  predicate: (lease: BrowserPipResourceLease) => boolean,
): {
  readonly released: readonly BrowserPipResourceLease[];
  readonly state: BrowserPipResourceState;
} {
  const leases = new Map(state.leases);
  const released: BrowserPipResourceLease[] = [];
  for (const lease of leases.values()) {
    if (!predicate(lease)) continue;
    leases.delete(lease.presentationId);
    released.push(lease);
  }
  return { released, state: { leases } };
}
