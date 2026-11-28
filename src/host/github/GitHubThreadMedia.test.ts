import type { GitHubApi } from "@nodex/agent-runtime/github-source";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { parseGitHubAttachment } from "../../shared/github-media";
import { makeGitHubThreadMedia } from "./GitHubThreadMedia";

const id = "23c3c624-f538-4f67-a100-bed566043a1f";
const cdnPath = `/123/456-${id}.mp4`;
const attachment = parseGitHubAttachment(`https://github.com/user-attachments/assets/${id}`)!;
const ref = { host: "github.com", owner: "acme", repo: "web", number: 1 };

const fixture = Effect.fnUntraced(function* (mimeType = "video/mp4", size = 64) {
  let markdownRequests = 0;
  const fetchCdn: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    expect(url.host).toBe("private-user-images.githubusercontent.com");
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Range")).toBe("bytes=0-0");
    return new Response("0", {
      status: 206,
      headers: { "Content-Type": mimeType, "Content-Range": `bytes 0-0/${size}` },
    });
  };
  const api: GitHubApi["Service"] = {
    graphql: () => Effect.die("Unexpected GraphQL request"),
    credential: () => Effect.succeed({ token: Redacted.make("test"), fingerprint: "test" }),
    rest: () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const payload = Buffer.from(JSON.stringify({ exp: (now + 120_000) / 1_000 })).toString(
          "base64url",
        );
        markdownRequests++;
        return {
          body: `<img src="https://private-user-images.githubusercontent.com${cdnPath}?jwt=${markdownRequests}.${payload}.signature">`,
          status: 200,
          headers: {},
          truncated: false,
          invalidUtf8: false,
        };
      }),
  };
  const media = yield* makeGitHubThreadMedia(api, fetchCdn);
  return { media, requests: () => markdownRequests };
});

describe("GitHub attachment resolution", () => {
  it.effect(
    "coalesces by connected credential and refreshes a minute before the signed URL expires",
    () =>
      Effect.gen(function* () {
        const { media, requests } = yield* fixture();
        const first = yield* media.resolve(ref, attachment, "credential-one");
        yield* TestClock.adjust(59_999);
        expect((yield* media.resolve(ref, attachment, "credential-one")).url.href).toBe(
          first.url.href,
        );
        expect(requests()).toBe(1);
        const other = yield* media.resolve(ref, attachment, "credential-two");
        expect(other.url.href).not.toBe(first.url.href);
        yield* TestClock.adjust(1);
        const refreshed = yield* media.resolve(ref, attachment, "credential-one");
        expect(refreshed.url.href).not.toBe(first.url.href);
        expect(requests()).toBe(3);
      }),
  );

  it.effect("rejects active content and enforces the separate attachment size budgets", () =>
    Effect.gen(function* () {
      for (const [type, size] of [
        ["image/svg+xml", 64],
        ["text/html", 64],
        ["image/png", 10 * 1024 * 1024 + 1],
        ["video/mp4", 100 * 1024 * 1024 + 1],
      ] as const) {
        const { media } = yield* fixture(type, size);
        const result = yield* Effect.flip(media.resolve(ref, attachment, "credential"));
        expect(result).toMatchObject({ status: "unavailable", reason: "not_found" });
      }
    }),
  );
});
