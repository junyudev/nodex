import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  RELEASE_DOWNLOAD_ORIGIN,
  releaseDownloadUrl,
  releaseObjectKey,
  STABLE_RELEASE_POINTER_KEY,
} from "../../src/shared/release-download";
import { assembleReleaseBundle } from "./bundle";
import { publishAppcastsToR2, verifyPublishedAppcasts } from "./feeds";
import { sha256File } from "./model";
import { ReleaseBucket, sha256Bytes } from "./r2";
import { publishReleaseBundleToR2 } from "./r2-publication";
import { RELEASE_ARCHITECTURES } from "./targets";
import { makeReleaseFixture } from "./windows-release.fixture";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nodex-release-r2-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const signer = () =>
  new AwsClient({ accessKeyId: "test", secretAccessKey: "test", service: "s3", region: "auto" });

const keyOf = (request: Request): string =>
  new URL(request.url).pathname.split("/").slice(2).join("/");
const head = (bytes: number, sha256?: string | null) =>
  new Response(null, {
    headers: {
      "Content-Length": String(bytes),
      ...(sha256 ? { "x-amz-meta-sha256": sha256 } : {}),
    },
  });

function fakeBucket() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const digests = new Map<string, string | null>();
  const writes: string[] = [];
  const publicChecks = new Set<string>();
  const requests: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).origin === RELEASE_DOWNLOAD_ORIGIN) {
      const key = new URL(request.url).pathname.slice(1);
      expect(request.method).toBe("HEAD");
      publicChecks.add(key);
      const bytes = objects.get(key);
      return bytes ? head(bytes.byteLength) : new Response(null, { status: 404 });
    }
    const key = keyOf(request);
    const current = objects.get(key);
    const etag = current ? `"${sha256Bytes(current)}"` : undefined;
    if (request.method === "HEAD") {
      return current
        ? head(current.byteLength, digests.get(key))
        : new Response(null, { status: 404 });
    }
    if (request.method === "GET") {
      return current
        ? new Response(current, { headers: { etag: etag! } })
        : new Response(null, { status: 404 });
    }
    expect(request.method).toBe("PUT");
    const headers = request.headers;
    const ifMatch = headers.get("if-match");
    if ((ifMatch && ifMatch !== etag) || (headers.get("if-none-match") === "*" && current)) {
      return new Response(null, { status: 412 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    expect(headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(headers.get("x-amz-content-sha256")).toBe(sha256Bytes(bytes));
    if (key.startsWith("releases/") || key.startsWith("nightly/")) {
      expect(headers.get("x-amz-meta-sha256")).toBe(sha256Bytes(bytes));
    }
    if (key.startsWith("updates/") || key === STABLE_RELEASE_POINTER_KEY) {
      expect(headers.get("cache-control")).toBe("no-cache");
      expect(headers.get("content-type")).toBe(
        key.startsWith("updates/") ? "application/xml" : "application/json",
      );
    }
    if (key === STABLE_RELEASE_POINTER_KEY) {
      for (const key of objects.keys()) {
        if (key.startsWith("releases/")) expect(publicChecks.has(key)).toBe(true);
      }
    }
    writes.push(key);
    objects.set(key, bytes);
    digests.set(key, headers.get("x-amz-meta-sha256"));
    return new Response(null);
  };
  return { objects, writes, publicChecks, requests, bucket: new ReleaseBucket(signer(), requests) };
}

function assemble(channel: "stable" | "nightly") {
  const inputs = makeReleaseFixture(root, channel);
  const directory = join(root, "bundle");
  const bundle = assembleReleaseBundle({ ...inputs, outputDirectory: directory });
  return {
    bundle,
    directory,
    bundlePath: join(directory, "release-bundle.json"),
    windowsPublicKey: inputs.windowsPublicKey,
  };
}

const asset = {
  bytes: 4,
  sha256: sha256Bytes(Buffer.from("disk")),
  contentType: "application/octet-stream",
};
const key = "releases/v0.2.2/Nodex-0.2.2-arm64.dmg";

test("skips identical immutable objects and rejects different bytes before opening the file", async () => {
  for (const [size, digest, expected] of [
    [4, asset.sha256, "skipped"],
    [5, asset.sha256, "has size 5, expected 4 bytes"],
    [4, sha256Bytes(Buffer.from("same")), "has digest"],
    [4, null, "has digest unknown"],
  ] as const) {
    const bucket = new ReleaseBucket(signer(), async (input) => {
      expect((input as Request).method).toBe("HEAD");
      // A compressed response would carry no Content-Length to compare.
      expect((input as Request).headers.get("accept-encoding")).toBe("identity");
      return head(size, digest);
    });
    const upload = bucket.putImmutableFile(key, join(root, "unopened"), asset);
    if (expected === "skipped") await expect(upload).resolves.toBe("skipped");
    else await expect(upload).rejects.toThrow(expected);
  }
});

test.each([4, 5, null])(
  "rechecks immutable uploads after a 412 race (winner size %s)",
  async (size) => {
    const path = join(root, "asset");
    writeFileSync(path, "disk");
    const operations: string[] = [];
    const bucket = new ReleaseBucket(signer(), async (input) => {
      const request = input as Request;
      operations.push(request.method);
      if (operations.length === 1 || (operations.length === 3 && size === null)) {
        return new Response(null, { status: 404 });
      }
      if (operations.length === 2) {
        await request.body?.cancel();
        return new Response(null, { status: 412 });
      }
      return head(size!, asset.sha256);
    });
    const upload = bucket.putImmutableFile(key, path, asset);
    if (size === 4) await expect(upload).resolves.toBe("skipped");
    else await expect(upload).rejects.toThrow(size === null ? "HTTP 412" : "has size 5");
    expect(operations).toEqual(["HEAD", "PUT", "HEAD"]);
  },
);

test("streams signed immutable bytes from disk again after network and server failures", async () => {
  const path = join(root, "asset");
  const content = Buffer.alloc(256 * 1024, 42);
  writeFileSync(path, content);
  const identity = { ...asset, bytes: content.byteLength, sha256: sha256Bytes(content) };
  let uploads = 0;
  const bucket = new ReleaseBucket(signer(), async (input) => {
    const request = input as Request;
    if (request.method === "HEAD") return new Response(null, { status: 404 });
    expect(request.method).toBe("PUT");
    expect(request.headers.get("content-length")).toBe(String(identity.bytes));
    expect(request.headers.get("content-type")).toBe(identity.contentType);
    expect(request.headers.get("x-amz-content-sha256")).toBe(identity.sha256);
    expect(request.headers.get("authorization")).toContain("x-amz-content-sha256");
    expect(request.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(request.headers.get("if-none-match")).toBe("*");
    const reader = request.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeLessThan(identity.bytes);
    if (++uploads < 3) {
      await reader.cancel();
      if (uploads === 1) throw new TypeError("connection lost");
      return new Response(null, { status: 503 });
    }
    const chunks = [first.value!];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    expect(Buffer.concat(chunks)).toEqual(content);
    return new Response(null);
  });
  await expect(bucket.putImmutableFile(key, path, identity)).resolves.toBe("uploaded");
  expect(uploads).toBe(3);
});

test("backfills a schema 8 Stable bundle from public assets and advances its pointer only forward", async () => {
  const fixture = assemble("stable");
  const { bundle, directory, bundlePath } = fixture;
  const checksums = join(directory, "SHA256SUMS");
  const windowsComponents = bundle.assets.find(
    ({ role, architecture }) => role === "components-manifest" && architecture === "windows-x64",
  )!;
  const assets = bundle.assets.filter(({ name }) => name !== windowsComponents.name);
  rmSync(join(directory, windowsComponents.name));
  rmSync(join(directory, "testflight"), { recursive: true });
  writeFileSync(bundlePath, JSON.stringify({ ...bundle, schemaVersion: 8, assets }));
  const entries = [...assets, { name: "release-bundle.json", sha256: sha256File(bundlePath) }]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`);
  writeFileSync(checksums, entries.join(""));

  const fake = fakeBucket();
  const publish = () =>
    publishReleaseBundleToR2({ ...fixture, bucket: fake.bucket, fetchRequest: fake.requests });
  const installerName = (suffix: string) => `Nodex-${bundle.version}-${suffix}`;
  const pointer = {
    version: 1,
    tag: bundle.tag,
    installers: {
      macos: installerName("arm64.dmg"),
      "windows-x64": installerName("windows-x64.exe"),
      android: installerName("android.apk"),
    },
  };
  const previous = { ...pointer, tag: "v0.2.1" };
  fake.objects.set(STABLE_RELEASE_POINTER_KEY, new TextEncoder().encode(JSON.stringify(previous)));
  const published = await publish();
  const expected = [
    ...assets.map(({ name }) => name).filter((name) => !name.startsWith("Nodex-latest-")),
    "release-bundle.json",
    "SHA256SUMS",
  ];
  expect(published).toEqual({ tag: bundle.tag, uploaded: expected, skipped: [] });
  expect([...fake.publicChecks]).toEqual(
    expected.map((name) => releaseObjectKey(bundle.tag, name)),
  );
  expect(
    JSON.parse(new TextDecoder().decode(fake.objects.get(STABLE_RELEASE_POINTER_KEY))),
  ).toEqual(pointer);
  await expect(publish()).resolves.toEqual({ tag: bundle.tag, uploaded: [], skipped: expected });

  const newer = new TextEncoder().encode(JSON.stringify({ ...pointer, tag: "v0.10.0" }));
  fake.objects.set(STABLE_RELEASE_POINTER_KEY, newer);
  await expect(publish()).rejects.toThrow("cannot move from v0.10.0 back to v0.2.2");
  expect(fake.objects.get(STABLE_RELEASE_POINTER_KEY)).toEqual(newer);
});

test.each(["stable", "nightly"] as const)(
  "publishes byte-exact signed %s feeds and verifies their public endpoints",
  async (channel) => {
    const fixture = assemble(channel);
    const { bundle, directory } = fixture;
    const { bucket, objects, requests } = fakeBucket();
    if (channel === "nightly") {
      const mirrored = await publishReleaseBundleToR2({
        ...fixture,
        bucket,
        fetchRequest: requests,
      });
      expect(mirrored.uploaded).toHaveLength(bundle.assets.length + 2);
      expect(objects.has(STABLE_RELEASE_POINTER_KEY)).toBe(false);
    }
    const feedKey = (arch: string) => `updates/${channel}/${arch}/appcast.xml`;
    const expectedFeed = (arch: string) =>
      readFileSync(join(directory, `Nodex-${bundle.version}-appcast-${arch}.xml`));
    const sibling = channel === "stable" ? "nightly" : "stable";
    const siblingKey = `updates/${sibling}/arm64/appcast.xml`;
    objects.set(siblingKey, new TextEncoder().encode("untouched"));
    for (const buildVersion of ["2.0.0", bundle.releaseIdentity.buildVersion]) {
      const conflictingFeed = `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${buildVersion}</sparkle:version></item></channel></rss>`;
      objects.set(feedKey("windows-x64"), new TextEncoder().encode(conflictingFeed));
      await expect(publishAppcastsToR2({ ...fixture, bucket })).rejects.toThrow(
        buildVersion === "2.0.0" ? "cannot move" : "different bytes",
      );
      expect(objects.has(feedKey("arm64"))).toBe(false);
    }
    objects.set(feedKey("windows-x64"), expectedFeed("windows-x64"));
    const published = await publishAppcastsToR2({ ...fixture, bucket });
    expect(published.feeds.map(({ path }) => path)).toEqual(RELEASE_ARCHITECTURES.map(feedKey));
    for (const arch of RELEASE_ARCHITECTURES)
      expect(objects.get(feedKey(arch))).toEqual(new Uint8Array(expectedFeed(arch)));
    expect(new TextDecoder().decode(objects.get(siblingKey))).toBe("untouched");

    const canonical = new Set<string>();
    const cacheBusted = new Set<string>();
    const redirects = new Set<string>();
    let badRedirect = false;
    const filenames: Readonly<Record<string, string>> = {
      macos: `Nodex-${bundle.version}-arm64.dmg`,
      "windows-x64": `Nodex-${bundle.version}-windows-x64.exe`,
      android: `Nodex-${bundle.version}-android.apk`,
    };
    const fetchRequest: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/dl/")) {
        expect(init?.redirect).toBe("manual");
        const platform = url.pathname.split("/").pop()!;
        redirects.add(platform);
        return new Response(null, {
          status: 302,
          headers: {
            location: releaseDownloadUrl(
              bundle.tag,
              badRedirect && platform === "android"
                ? "Nodex-latest-android.apk"
                : filenames[platform],
            ),
          },
        });
      }
      if (url.hostname === "github.com") {
        expect(init?.method).toBe("HEAD");
        return new Response(null);
      }
      const key = url.pathname.slice(1);
      (url.search ? cacheBusted : canonical).add(key);
      return new Response(objects.get(key));
    };
    const verify = () => verifyPublishedAppcasts({ ...fixture, attempts: 1, fetchRequest });
    await expect(verify()).resolves.toBeUndefined();
    expect([...canonical]).toEqual(RELEASE_ARCHITECTURES.map(feedKey));
    expect([...cacheBusted]).toEqual([...canonical]);
    expect([...redirects]).toEqual(channel === "stable" ? Object.keys(filenames) : []);
    if (channel === "stable") {
      badRedirect = true;
      await expect(verify()).rejects.toHaveProperty(
        "cause.message",
        expect.stringContaining("Stable android download expected HTTP 302"),
      );
    }
  },
);
