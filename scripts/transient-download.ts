/**
 * Third-party release hosts fail briefly at their gateway or drop connections. Preparing a build
 * rides those out; every other failure, and every verification of what was downloaded, stays
 * fail-fast.
 */

/** About two minutes, enough to ride out a release host that is briefly failing at its gateway. */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000];

/** Gateway and rate-limit answers clear on their own; any other HTTP status is final. */
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_DOWNLOAD_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** A download the server answered with a non-success status. */
export class DownloadHttpError extends Error {
  constructor(
    label: string,
    readonly status: number,
  ) {
    super(`Failed to download ${label}: HTTP ${status}`);
    this.name = "DownloadHttpError";
  }
}

/** Whether a failure anywhere in this error's cause chain is worth another attempt. */
export function isTransientDownloadError(error: unknown): boolean {
  const visited = new Set<Error>();
  for (let cause = error; cause instanceof Error && !visited.has(cause); cause = cause.cause) {
    visited.add(cause);
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSIENT_DOWNLOAD_CODES.has(cause.code)
    ) {
      return true;
    }
    if (cause instanceof DownloadHttpError && TRANSIENT_HTTP_STATUSES.has(cause.status))
      return true;
    // Electron's downloader keeps the HTTP response on its error: a fetch Response or a got one.
    const response = (
      cause as { readonly response?: { readonly status?: unknown; readonly statusCode?: unknown } }
    ).response;
    const status = response?.status ?? response?.statusCode;
    if (typeof status === "number" && TRANSIENT_HTTP_STATUSES.has(status)) return true;
  }
  return false;
}

/** Runs one download, repeating it after each transient failure until the delays run out. */
export async function retryTransientDownload<T>(
  download: () => Promise<T>,
  retryDelaysMs: readonly number[] = DOWNLOAD_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download();
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined || !isTransientDownloadError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
