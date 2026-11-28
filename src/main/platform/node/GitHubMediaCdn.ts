/* @effect-diagnostics asyncFunction:off -- Adapts the abortable Fetch byte stream for Electron's protocol responder. */
import { gitHubMediaKind } from "../../../shared/github-media";

export interface GitHubMediaByteRange {
  readonly start: number;
  readonly end: number;
}

const imageLimit = 10 * 1024 * 1024;
// GitHub permits up to 100 MB of video uploads for paid plans.
const videoLimit = 100 * 1024 * 1024;

function attachmentMimeType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function fetchCdn(
  url: URL,
  range: GitHubMediaByteRange | null,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<Response> {
  return request(url, {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: {
      "Accept-Encoding": "identity",
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    },
  });
}

export async function probeGitHubCdn(url: URL, signal: AbortSignal, request: typeof fetch) {
  const response = await fetchCdn(url, { start: 0, end: 0 }, signal, request);
  void response.body?.cancel().catch(() => undefined);
  const mimeType = attachmentMimeType(response);
  const kind = gitHubMediaKind(mimeType);
  const total = /^bytes 0-0\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1];
  const size = Number(total);
  if (!kind || response.status !== 206 || !Number.isSafeInteger(size) || size < 1) return null;
  if (size > (kind === "image" ? imageLimit : videoLimit)) return null;
  return { kind, mimeType, size };
}

export type GitHubCdnMedia = NonNullable<Awaited<ReturnType<typeof probeGitHubCdn>>> & {
  readonly url: URL;
};

export async function readGitHubCdn(
  media: GitHubCdnMedia,
  range: GitHubMediaByteRange | null,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetchCdn(media.url, range, signal, request);
  const length = range ? range.end - range.start + 1 : media.size;
  const expectedContentRange = range ? `bytes ${range.start}-${range.end}/${media.size}` : null;
  const encoding = response.headers.get("content-encoding");
  if (
    !response.body ||
    response.status !== (range ? 206 : 200) ||
    attachmentMimeType(response) !== media.mimeType ||
    (encoding !== null && encoding !== "identity") ||
    response.headers.get("content-range") !== expectedContentRange ||
    response.headers.get("content-length") !== String(length)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }

  let remaining = length;
  return response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        remaining -= chunk.byteLength;
        if (remaining < 0) return controller.error(new Error("Invalid GitHub attachment length"));
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (remaining !== 0) controller.error(new Error("Incomplete GitHub attachment"));
      },
    }),
  );
}
