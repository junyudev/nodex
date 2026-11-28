import type { GitHubApi } from "@nodex/agent-runtime/github-source";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { parseGitHubAttachment, parseGitHubAttachmentCdnUrl } from "../../shared/github-media";
import { visitGitHubMediaTags } from "../../shared/github-media-markdown";
import type { GitHubThreadRef, GitHubUnavailable } from "../../shared/github-thread";

import {
  probeGitHubCdn,
  readGitHubCdn,
  type GitHubMediaByteRange,
  type GitHubCdnMedia,
} from "../../main/platform/node/GitHubMediaCdn";

type Attachment = NonNullable<ReturnType<typeof parseGitHubAttachment>>;
type MediaKey = readonly [fingerprint: string, host: string, repository: string, url: string];

const refreshMargin = 60_000;
const maxTtl = 4 * 60_000;

const unavailable = {
  status: "unavailable",
  reason: "not_found",
  message: null,
  retryAt: null,
} satisfies GitHubUnavailable;

function signedMediaUrl(html: string, id: string) {
  const candidates: Array<NonNullable<ReturnType<typeof parseGitHubAttachmentCdnUrl>>> = [];
  visitGitHubMediaTags(html, ({ src }) => {
    const candidate = parseGitHubAttachmentCdnUrl(src);
    if (candidate?.id === id) candidates.push(candidate);
  });
  return candidates[0];
}

function jwtExpiry(token: string): number | null {
  const body = token.split(".")[1];
  if (!body) return null;
  try {
    const expiry: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))?.exp;
    return typeof expiry === "number" && Number.isFinite(expiry) ? expiry * 1_000 : null;
  } catch {
    return null;
  }
}

export const makeGitHubThreadMedia = Effect.fn("GitHubThreadMedia.make")(function* (
  api: GitHubApi["Service"],
  request: typeof fetch = fetch,
) {
  const lookup = Effect.fn("GitHubThreadMedia.lookup")(function* ([
    ,
    host,
    repository,
    url,
  ]: MediaKey) {
    const attachment = parseGitHubAttachment(url);
    if (!attachment) return yield* Effect.fail(unavailable);
    const response = yield* api.rest({
      host,
      operation: "thread.attachment",
      method: "POST",
      path: "markdown",
      accept: "text/html",
      body: { text: `![attachment](${attachment.url})`, mode: "gfm", context: repository },
      maxResponseBytes: 32 * 1024,
      allowReserve: true,
      allowPaused: false,
    });
    if (response.truncated || response.invalidUtf8) return yield* Effect.fail(unavailable);
    const signed = signedMediaUrl(response.body, attachment.id);
    if (!signed) return yield* Effect.fail(unavailable);
    const expiresAt = signed.token ? jwtExpiry(signed.token) : Infinity;
    if (expiresAt === null) return yield* Effect.fail(unavailable);
    const metadata = yield* Effect.tryPromise({
      try: (signal) => probeGitHubCdn(signed.url, signal, request),
      catch: () => unavailable,
    });
    if (!metadata) return yield* Effect.fail(unavailable);
    const now = yield* Clock.currentTimeMillis;
    if (expiresAt <= now) return yield* Effect.fail(unavailable);
    return {
      ...metadata,
      url: signed.url,
      ttl: Math.max(0, Math.min(maxTtl, expiresAt - now - refreshMargin)),
    };
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 128,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.ttl : 0),
  });
  const resolve = (ref: GitHubThreadRef, attachment: Attachment, fingerprint: string) =>
    Cache.get(cache, [
      fingerprint,
      ref.host,
      `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`,
      attachment.url,
    ]);

  return {
    resolve,
    read: (media: GitHubCdnMedia, range: GitHubMediaByteRange | null, requestSignal: AbortSignal) =>
      Effect.tryPromise({
        try: (signal) =>
          readGitHubCdn(media, range, AbortSignal.any([requestSignal, signal]), request),
        catch: () => unavailable,
      }),
  };
});
