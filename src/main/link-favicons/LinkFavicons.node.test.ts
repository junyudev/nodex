import { assert, it } from "@effect/vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { make as makeApplicationSettings } from "../settings/ApplicationSettings";
import { make } from "./LinkFavicons";

const host = "developer.mozilla.org";
const none = { status: "none" } as const;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
const ready = { status: "ready", dataUrl: `data:image/png;base64,${png}` } as const;
const pngResponse = () =>
  new Response(Buffer.from(png, "base64"), { headers: { "content-type": "image/png" } });

const profile = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-link-favicons-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

it.effect("sends only the public link hostname to Google and coalesces simultaneous requests", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => pngResponse());
    const favicons = yield* make({
      profilePath: yield* profile,
      enabled: Effect.succeed(true),
      fetch,
    });

    for (const value of [
      "developer.mozilla.org:3000",
      "https://developer.mozilla.org/private?token=secret",
      "user:secret@developer.mozilla.org",
      "../developer.mozilla.org",
      "secret.internal",
      "dev.localhost",
      "192.168.1.4",
      "github.com",
    ]) {
      assert.deepEqual(yield* favicons.read(value), none);
    }
    assert.strictEqual(fetch.mock.calls.length, 0);

    const results = yield* Effect.all([favicons.read(host), favicons.read(host)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(results, [ready, ready]);
    assert.strictEqual(fetch.mock.calls.length, 1);
    const [[url, init]] = fetch.mock.calls;
    assert.strictEqual(
      url,
      "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE%2CSIZE%2CURL&url=https%3A%2F%2Fdeveloper.mozilla.org&size=64&drop_404_icon=true",
    );
    assert.deepEqual(init?.headers, {
      accept:
        "image/png, image/x-icon, image/vnd.microsoft.icon, image/jpeg, image/gif, image/webp",
      "user-agent": "Mozilla/5.0",
    });
    assert.strictEqual(init?.method, "GET");
    assert.strictEqual(init?.credentials, "omit");
    assert.strictEqual(init?.referrerPolicy, "no-referrer");
    assert.strictEqual(init?.redirect, "error");
  }),
);

it.effect("rejects non-raster, oversized and non-success responses", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const favicons = yield* make({
      profilePath: yield* profile,
      enabled: Effect.succeed(true),
      fetch,
    });
    const responses = [
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      new Response("not a PNG", { headers: { "content-type": "image/png" } }),
      new Response("text", { headers: { "content-type": "text/plain" } }),
      new Response(new Uint8Array(64 * 1024 + 1), {
        headers: { "content-type": "image/png" },
      }),
      new Response(Buffer.from(png, "base64"), {
        status: 404,
        headers: { "content-type": "image/png" },
      }),
    ];
    for (const [index, response] of responses.entries()) {
      fetch.mockResolvedValueOnce(response);
      assert.deepEqual(yield* favicons.read(`site-${index}.example.com`), none);
    }
    assert.strictEqual(fetch.mock.calls.length, responses.length);
  }),
);

it.effect("reuses an icon across service lifetimes and replaces a corrupt disk entry", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => pngResponse());
    const profilePath = yield* profile;
    const options = { profilePath, enabled: Effect.succeed(true), fetch };

    const first = yield* Effect.scoped(
      Effect.flatMap(make(options), (favicons) => favicons.read(host)),
    );
    assert.deepEqual(first, ready);
    const favicons = yield* make(options);
    assert.deepEqual(yield* favicons.read(host), ready);
    yield* TestClock.adjust("29 days");
    assert.deepEqual(yield* favicons.read(host), ready);
    assert.strictEqual(fetch.mock.calls.length, 1);

    const cachePath = join(profilePath, "cache", "link-favicons");
    const [entry] = yield* Effect.promise(() => readdir(cachePath));
    assert.isDefined(entry);
    yield* Effect.promise(() => writeFile(join(cachePath, entry), "invalid JSON"));
    assert.deepEqual(yield* favicons.read(host), ready);
    assert.strictEqual(fetch.mock.calls.length, 2);
  }),
);

it.effect("retries an expired negative entry", () =>
  Effect.gen(function* () {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockImplementationOnce(async () => pngResponse());
    const favicons = yield* make({
      profilePath: yield* profile,
      enabled: Effect.succeed(true),
      fetch,
    });

    assert.deepEqual(yield* favicons.read(host), none);
    yield* TestClock.adjust("23 hours");
    assert.deepEqual(yield* favicons.read(host), none);
    assert.strictEqual(fetch.mock.calls.length, 1);
    yield* TestClock.adjust("1 hour");
    assert.deepEqual(yield* favicons.read(host), ready);
    assert.strictEqual(fetch.mock.calls.length, 2);
  }),
);

it.effect("honors the saved Profile preference immediately and on the next launch", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => pngResponse());
    const profilePath = yield* profile;
    const source = {
      hostHomeDirectory: profilePath,
      environment: {},
      settingsPath: join(profilePath, "config.toml"),
    };
    const settings = yield* makeApplicationSettings(source);
    const favicons = yield* make({ profilePath, enabled: settings.fetchLinkFavicons, fetch });
    assert.isTrue(yield* settings.fetchLinkFavicons);

    yield* settings.update({ type: "update-link-favicons", input: false });
    assert.deepEqual(yield* favicons.read(host), none);
    const reopened = yield* makeApplicationSettings(source);
    const afterRestart = yield* make({ profilePath, enabled: reopened.fetchLinkFavicons, fetch });
    assert.deepEqual(yield* afterRestart.read(host), none);
    assert.strictEqual(fetch.mock.calls.length, 0);

    yield* reopened.update({ type: "update-link-favicons", input: true });
    assert.deepEqual(yield* afterRestart.read(host), ready);
    assert.strictEqual(fetch.mock.calls.length, 1);
  }),
);
