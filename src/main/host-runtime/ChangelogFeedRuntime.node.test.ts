import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { expect, vi } from "vite-plus/test";
import {
  CHANGELOG_FEED_URL,
  CHANGELOG_PAGE_URL,
  type ChangelogFeed,
} from "../../shared/changelog-feed";
import { testLayer as testMainConfig, type MainConfigValue } from "../app/MainConfig";
import { makeChangelogFeedRequest } from "../platform/electron/ChangelogFeedNetwork";
import type { UpdateFetch } from "../windows-update-download";
import { ChangelogFeedRuntime, layer } from "./ChangelogFeedRuntime";

const feed: ChangelogFeed = {
  schemaVersion: 1,
  url: CHANGELOG_PAGE_URL,
  releases: [
    {
      version: "1.2.3",
      date: "2026-11-24",
      url: `${CHANGELOG_PAGE_URL}#v1.2.3`,
      headline: "Read release notes",
      sections: [{ kind: "added", entries: [{ lead: "Read release notes.", detail: "" }] }],
    },
  ],
};
const updatedFeed = {
  ...feed,
  releases: [{ ...feed.releases[0]!, headline: "Read updated release notes" }],
};
const developmentEndpoint = "http://[::1]:8765/changelog.json";
const overrides = (url: string): Partial<MainConfigValue> => ({
  environment: { NODEX_CHANGELOG_FEED_URL: url },
});
const makeRuntime = (request: Parameters<typeof layer>[0], config?: Partial<MainConfigValue>) =>
  ChangelogFeedRuntime.pipe(
    Effect.provide(layer(request).pipe(Layer.provide(testMainConfig(config)))),
  );

it.effect(
  "coalesces reads, caches for five minutes, and preserves the last good feed during failures",
  () =>
    Effect.gen(function* () {
      const request = vi
        .fn<Parameters<typeof layer>[0]>()
        .mockReturnValueOnce(Effect.sleep("1 second").pipe(Effect.as(feed)))
        .mockReturnValueOnce(Effect.succeed({ ...feed, schemaVersion: 2 }))
        .mockReturnValueOnce(Effect.fail(new Error("Offline")))
        .mockReturnValueOnce(Effect.succeed(updatedFeed));
      const { read } = yield* makeRuntime(request);
      const firstReads = yield* Effect.all([read, read], { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(firstReads)).toEqual([feed, feed]);
      yield* TestClock.adjust(299_999);
      expect(yield* read).toEqual(feed);
      expect(request).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust(1);
      expect(yield* read).toEqual(feed);
      expect(yield* read).toEqual(feed);
      expect(yield* read).toEqual(updatedFeed);
      expect(yield* read).toEqual(updatedFeed);
      expect(request).toHaveBeenCalledTimes(4);
    }),
);

it.effect(
  "fails a cold read on invalid data or a timed-out request, then retries on the next read",
  () =>
    Effect.gen(function* () {
      const request = vi
        .fn<Parameters<typeof layer>[0]>()
        .mockReturnValueOnce(Effect.succeed({ ...feed, schemaVersion: 2 }))
        .mockReturnValueOnce(Effect.never)
        .mockReturnValueOnce(Effect.succeed(feed));
      const { read } = yield* makeRuntime(request);
      expect((yield* Effect.flip(read)).operation).toBe("decode");

      const stalled = yield* Effect.flip(read).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(stalled)).operation).toBe("download");
      expect(yield* read).toEqual(feed);
    }),
);

it.effect(
  "uses the shipped URL in packaged builds and permits only HTTPS or loopback HTTP overrides",
  () =>
    Effect.gen(function* () {
      const request = vi.fn<Parameters<typeof layer>[0]>().mockReturnValue(Effect.succeed(feed));
      for (const [config, endpoint] of [
        [{ ...overrides(developmentEndpoint), isPackaged: true }, CHANGELOG_FEED_URL],
        [overrides(developmentEndpoint), developmentEndpoint],
        [overrides("https://example.test/feed"), "https://example.test/feed"],
      ] as const) {
        const { read } = yield* makeRuntime(request, config);
        expect(yield* read).toEqual(feed);
        expect(request).toHaveBeenLastCalledWith(new URL(endpoint));
      }

      const { read } = yield* makeRuntime(request, overrides("http://127.example.test/feed"));
      expect((yield* Effect.flip(read)).operation).toBe("resolve-url");
      expect(request).toHaveBeenCalledTimes(3);
    }),
);

it.live(
  "follows same-origin redirects without credentials and refuses a cross-origin redirect",
  () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<UpdateFetch>()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "/latest.json" } }),
        )
        .mockResolvedValueOnce(Response.json(feed))
        .mockResolvedValueOnce(Response.redirect("https://somewhere.example/latest.json"));
      const request = makeChangelogFeedRequest(fetch);

      expect(yield* request(new URL(developmentEndpoint))).toEqual(feed);
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        new URL("/latest.json", developmentEndpoint).href,
        expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual" }),
      );
      const error = yield* Effect.flip(request(new URL(developmentEndpoint)));
      expect(error.cause).toMatchObject({
        message: "Changelog feed redirected outside its configured origin.",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    }),
);

it.live("stops reading a response that exceeds one MiB without a Content-Length header", () =>
  Effect.gen(function* () {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const request = makeChangelogFeedRequest(() => Promise.resolve(new Response(body)));

    const error = yield* Effect.flip(request(new URL(CHANGELOG_FEED_URL)));
    expect(error.cause).toMatchObject({ message: "Changelog feed exceeds its size limit." });
    expect(cancel).toHaveBeenCalledOnce();
  }),
);
