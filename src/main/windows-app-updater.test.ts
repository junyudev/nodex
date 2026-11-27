import { describe, afterEach, expect, test } from "vite-plus/test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsUpdateInstallerCommand } from "./windows-update-handoff";
import { APP_UPDATE_PUBLIC_KEY, compareAppBuildVersions } from "./app-update-trust";
import {
  createPackagedWindowsAppUpdaterPlatform,
  createWindowsAppUpdaterPlatform,
} from "./windows-app-updater";
import { parseWindowsAppUpdateConfig, windowsUpdateFeedUrls } from "./windows-app-update-config";
import {
  MAX_APPCAST_BYTES,
  selectWindowsUpdate,
  type WindowsUpdateItem,
} from "./windows-update-appcast";
import {
  cleanupWindowsUpdates,
  downloadWindowsInstaller,
  fetchUpdate,
  readBoundedAppcast,
  type UpdateFetch,
} from "./windows-update-download";
import type { AppUpdaterEvent } from "./app-updater";
import {
  createPackagedMacAppUpdaterPlatform,
  parseSparkleRuntimeConfig,
} from "./sparkle-mac-app-updater";
import { parseSparkleNativeEvent } from "./sparkle-native-binding";

describe("windows-app-updater", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
    "base64",
  );
  const bytes = Buffer.from("signed installer bytes");
  const signature = sign(null, bytes, keys.privateKey).toString("base64");
  const url =
    "https://github.com/junyudev/nodex/releases/download/v0.2.3/Nodex-0.2.3-windows-x64.exe";
  const item: WindowsUpdateItem = {
    buildVersion: "1.1.2",
    version: "0.2.3",
    url,
    expectedBytes: bytes.length,
    signature,
  };
  const config = () => ({
    schemaVersion: 1,
    architecture: "x64",
    updates: "enabled",
    buildVersion: "1.1.1",
    feedUrls: windowsUpdateFeedUrls("x64"),
    publicKey: APP_UPDATE_PUBLIC_KEY,
  });
  const xmlItem = (version = "1.1.2", arch = "x64") =>
    `<item><title>Nodex update</title><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>0.2.3</sparkle:shortVersionString><description><![CDATA[Fixes & improvements]]></description><enclosure url="${url.replace("x64.exe", `${arch}.exe`)}" length="${bytes.length}" type="application/octet-stream" sparkle:os="windows" sparkle:edSignature="${signature}"/></item>`;
  const feed = (...items: string[]) =>
    `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items.join("")}</channel></rss>`;
  const directories: string[] = [];
  const directory = () => {
    const dir = mkdtempSync(join(tmpdir(), "nodex-updates-"));
    directories.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const untilEvent = (events: AppUpdaterEvent[], type: AppUpdaterEvent["type"]) =>
    expect.poll(() => events.some((event) => event.type === type)).toBe(true);

  describe("packaged Windows update trust", () => {
    test("accepts the pinned x64 feeds", () => {
      expect(parseWindowsAppUpdateConfig(config())).toMatchObject({
        architecture: "x64",
        updates: "enabled",
      });
    });
    test("rejects a substituted key, architecture, schema, build and feed", () => {
      for (const invalid of [
        { publicKey },
        { architecture: "ia32" },
        { architecture: "arm64" },
        { schemaVersion: 2 },
        { buildVersion: "1.1" },
        { feedUrls: { ...windowsUpdateFeedUrls("x64"), stable: "http://example.com" } },
        { unexpected: true },
        { buildChannel: "nightly" },
        { updates: "nightly" },
        { feedUrls: null },
      ]) {
        expect(() => parseWindowsAppUpdateConfig({ ...config(), ...invalid })).toThrow();
      }
    });
    test.each(["x64", "arm64"] as const)(
      "disabled %s packages reject update feeds",
      (architecture) => {
        expect(
          parseWindowsAppUpdateConfig({
            ...config(),
            architecture,
            updates: "disabled",
            feedUrls: null,
          }).updates,
        ).toBe("disabled");
        expect(() =>
          parseWindowsAppUpdateConfig({ ...config(), architecture, updates: "disabled" }),
        ).toThrow();
      },
    );
    test.each(["x64", "arm64"] as const)(
      "packaged %s entry point enforces key and update availability before acquisition",
      async (architecture) => {
        const root = directory();
        await mkdir(join(root, "native"));
        await writeFile(
          join(root, "native", "app-update.json"),
          JSON.stringify({
            ...config(),
            architecture,
            updates: "disabled",
            feedUrls: null,
            publicKey,
          }),
        );
        expect(() =>
          createPackagedWindowsAppUpdaterPlatform({
            resourcesPath: root,
            architecture,
            directory: join(root, "updates"),
          }),
        ).toThrow();
        await writeFile(
          join(root, "native", "app-update.json"),
          JSON.stringify({ ...config(), architecture, updates: "disabled", feedUrls: null }),
        );
        expect(
          createPackagedWindowsAppUpdaterPlatform({
            resourcesPath: root,
            architecture,
            directory: root,
          }),
        ).toBeNull();
      },
    );
  });

  describe("Windows appcast selection", () => {
    test("selects the newest architecture-qualified build, independent of item order", () => {
      expect(
        selectWindowsUpdate(
          feed(xmlItem("1.1.3"), xmlItem("1.1.99", "ia32"), xmlItem("1.1.2")),
          "x64",
          "1.1.1",
        ),
      ).toMatchObject({ buildVersion: "1.1.3", releaseNotes: "Fixes & improvements" });
    });
    test.each(["1.1.1", "1.1.0", "0.99.99"])("does not offer same or older build %s", (version) => {
      expect(selectWindowsUpdate(feed(xmlItem(version)), "x64", "1.1.1")).toBeNull();
    });
    test("orders numeric tuples across ordinal boundaries", () => {
      expect(compareAppBuildVersions("1.10.0", "1.9.99")).toBe(1);
      expect(compareAppBuildVersions("2.0.0", "1.99.99")).toBe(1);
      expect(compareAppBuildVersions("1.1.1", "1.1.1")).toBe(0);
      expect(() => compareAppBuildVersions("1.01.1", "1.1.1")).toThrow();
    });
    test("rejects malformed XML, DTDs, oversized feeds, unsafe URLs and invalid lengths", () => {
      for (const xml of [
        "<rss><channel></rss>",
        `<!DOCTYPE rss>${feed(xmlItem())}`,
        "x".repeat(MAX_APPCAST_BYTES + 1),
        feed(xmlItem().replace("https:", "http:")),
        feed(xmlItem().replace('length="22"', 'length="0"')),
        feed(xmlItem().replace(`length="${bytes.length}"`, 'length="9007199254740992"')),
      ]) {
        expect(() => selectWindowsUpdate(xml, "x64", "1.1.1")).toThrow();
      }
    });
    test("bounds streamed feeds and cancels after overflow", async () => {
      await expect(
        readBoundedAppcast(new Response("too large"), 3, new AbortController().signal),
      ).rejects.toThrow("size limit");
    });
    test("rejects HTTPS downgrade redirects before making an insecure request", async () => {
      const requests: string[] = [];
      const fetch: UpdateFetch = async (url) => {
        requests.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.com/update" },
        });
      };
      await expect(fetchUpdate(url, fetch, new AbortController().signal)).rejects.toThrow("HTTPS");
      expect(requests).toEqual([url]);
    });
  });

  const download = (
    dir: string,
    body: BodyInit = bytes,
    overrides: Partial<WindowsUpdateItem> = {},
    onProgress = (_received: number) => {},
  ) =>
    downloadWindowsInstaller({
      response: new Response(body),
      item: { ...item, ...overrides },
      publicKey,
      preparedPath: join(dir, "prepared-a.exe"),
      signal: new AbortController().signal,
      onProgress,
    });

  describe("verified installer staging", () => {
    test("streams only to .download until verification, then renames", async () => {
      const dir = directory();
      const progress: number[] = [];
      await download(dir, bytes, {}, (received) => {
        progress.push(received);
        expect(existsSync(join(dir, "prepared-a.exe"))).toBe(false);
      });
      expect(progress).toEqual([bytes.length]);
      expect(readFileSync(join(dir, "prepared-a.exe"))).toEqual(bytes);
      expect(existsSync(join(dir, "prepared-a.exe.download"))).toBe(false);
    });
    test.each(["signature", "length", "truncated"])(
      "rejects %s and removes partial files",
      async (kind) => {
        const dir = directory();
        const body = kind === "truncated" ? bytes.subarray(0, -1) : bytes;
        const overrides =
          kind === "signature"
            ? { signature: Buffer.alloc(64).toString("base64") }
            : kind === "length"
              ? { expectedBytes: bytes.length - 1 }
              : {};
        await expect(download(dir, body, overrides)).rejects.toThrow();
        expect(existsSync(join(dir, "prepared-a.exe"))).toBe(false);
        expect(existsSync(join(dir, "prepared-a.exe.download"))).toBe(false);
      },
    );
    test("rejects a mismatching HTTP length before staging", async () => {
      const dir = directory();
      await expect(
        downloadWindowsInstaller({
          response: new Response(bytes, { headers: { "content-length": "1" } }),
          item,
          publicKey,
          preparedPath: join(dir, "prepared-a.exe"),
          signal: new AbortController().signal,
          onProgress: () => {},
        }),
      ).rejects.toThrow("response length");
    });
    test("startup removes only owned stale downloads and prepared installers", async () => {
      const dir = directory();
      for (const name of ["prepared-a.exe.download", "prepared-b.exe", "keep.txt"])
        await writeFile(join(dir, name), "stale");
      await cleanupWindowsUpdates(dir);
      expect(existsSync(join(dir, "prepared-a.exe.download"))).toBe(false);
      expect(existsSync(join(dir, "prepared-b.exe"))).toBe(false);
      expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    });
  });

  function platformHarness(
    fetch: UpdateFetch = async (url) =>
      new Response(url.endsWith(".xml") ? feed(xmlItem()) : bytes),
  ) {
    const dir = directory();
    const events: AppUpdaterEvent[] = [];
    const launches: { path: string; relaunch: boolean }[] = [];
    let quits = 0;
    let sessionEnd: () => void = () => {};
    // Unit-only dependency injection; packaged entry always parses the pinned production key.
    const platform = createWindowsAppUpdaterPlatform(
      { ...parseWindowsAppUpdateConfig(config()), publicKey } as never,
      dir,
      {
        fetch,
        currentVersion: "0.2.2",
        quit: () => {
          quits += 1;
        },
        launch: (path, relaunch) => {
          launches.push({ path, relaunch });
        },
        observeSessionEnd: (listener) => {
          sessionEnd = listener;
          return () => {};
        },
      },
    )!;
    const lease = platform.acquire("stable", (event) => events.push(event));
    return { dir, lease, events, launches, quits: () => quits, sessionEnd: () => sessionEnd() };
  }

  describe("Windows updater lease", () => {
    test.each([false, true])("hands off only after shutdown, relaunch=%s", async (relaunch) => {
      const h = platformHarness();
      try {
        h.lease.session.check("user");
        await untilEvent(h.events, "update-ready");
        if (relaunch) h.lease.session.installDownloadedUpdate();
        expect(h.quits()).toBe(relaunch ? 1 : 0);
        expect(h.launches).toEqual([]);
        const handoff = h.lease.session.prepareQuit!();
        await h.lease.release();
        await handoff?.();
        expect(h.launches).toEqual([
          { path: expect.stringMatching(/prepared-.*\.exe$/u), relaunch },
        ]);
      } finally {
        await h.lease.release();
      }
    });
    test("does not install during OS session end", async () => {
      const h = platformHarness();
      try {
        h.lease.session.check("background");
        await untilEvent(h.events, "update-ready");
        h.sessionEnd();
        expect(h.lease.session.prepareQuit!()).toBeNull();
        expect(() => h.lease.session.installDownloadedUpdate()).toThrow();
        expect(h.launches).toEqual([]);
      } finally {
        await h.lease.release();
      }
    });
    test("rechecks the installer before handoff", async () => {
      const h = platformHarness();
      try {
        h.lease.session.check("user");
        await untilEvent(h.events, "update-ready");
        const handoff = h.lease.session.prepareQuit!();
        const { readdir } = await import("node:fs/promises");
        const executable = (await readdir(h.dir)).find((name) => name.endsWith(".exe"))!;
        await writeFile(join(h.dir, executable), Buffer.alloc(bytes.length));
        await h.lease.release();
        await expect(handoff!()).rejects.toThrow("signature");
        expect(h.launches).toEqual([]);
      } finally {
        await h.lease.release();
      }
    });
    test("cancels a channel's in-flight download and fences its events", async () => {
      let started: (() => void) | undefined;
      const downloading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const h = platformHarness(async (url, init) => {
        if (url.endsWith(".xml")) return new Response(feed(xmlItem()));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 2));
              started?.();
              init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
                once: true,
              });
            },
          }),
        );
      });
      h.lease.session.check("user");
      await downloading;
      h.lease.session.setChannel("nightly");
      await h.lease.release();
      expect(
        h.events.some((event) => event.type === "update-ready" || event.type === "error"),
      ).toBe(false);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(h.dir)).toEqual([]);
    });
    test("reports recoverable failure and allows another check", async () => {
      const h = platformHarness(async () => {
        throw new Error("offline");
      });
      h.lease.session.check("user");
      await untilEvent(h.events, "error");
      await expect
        .poll(() => h.events.filter((event) => event.type === "check-started").length)
        .toBe(1);
      h.lease.session.check("user");
      await expect.poll(() => h.events.filter((event) => event.type === "error").length).toBe(2);
      await h.lease.release();
    });
  });

  test("NSIS handoff command preserves exact silent-update flags without a shell", () => {
    const installer = "C:\\Users\\用户\\Nodex Updates\\prepared-a.exe";
    expect(windowsUpdateInstallerCommand(installer, true)).toEqual({
      executable: installer,
      args: ["/S", "--updated", "--force-run"],
      options: { detached: true, stdio: "ignore", windowsHide: true, shell: false },
    });
    expect(windowsUpdateInstallerCommand(installer, false).args).toEqual(["/S", "--updated"]);
  });
});

describe("sparkle-mac-app-updater", () => {
  const runtimeManifest = (overrides: Record<string, unknown> = {}) => ({
    architecture: "arm64",
    artifacts: {},
    updates: "enabled",
    feedUrls: {
      stable: "https://nodex.jyu.app/updates/stable/arm64/appcast.xml",
      nightly: "https://nodex.jyu.app/updates/nightly/arm64/appcast.xml",
    },
    minimumMacOS: "15.0",
    publicKey: "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs=",
    schemaVersion: 3,
    sparkleArchiveSha256: "ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9",
    sparkleVersion: "2.9.4",
    ...overrides,
  });

  describe("packaged Sparkle runtime boundary", () => {
    test("accepts the pinned architecture-specific feeds", () => {
      expect(parseSparkleRuntimeConfig(runtimeManifest())).toMatchObject({
        architecture: "arm64",
        updates: "enabled",
        sparkleVersion: "2.9.4",
      });
      expect(() =>
        parseSparkleRuntimeConfig(
          runtimeManifest({
            feedUrls: {
              stable: "https://nodex.jyu.app/updates/stable/x64/appcast.xml",
              nightly: "https://nodex.jyu.app/updates/nightly/arm64/appcast.xml",
            },
          }),
        ),
      ).toThrow("do not match");
      expect(() =>
        parseSparkleRuntimeConfig(
          runtimeManifest({
            sparkleVersion: "2.9.5",
          }),
        ),
      ).toThrow("identity is invalid");
    });

    test("allows a disabled local build only when it has no feed", () => {
      expect(
        parseSparkleRuntimeConfig(
          runtimeManifest({
            updates: "disabled",
            feedUrls: null,
          }),
        ),
      ).toMatchObject({ updates: "disabled", feedUrls: null });
      expect(() =>
        parseSparkleRuntimeConfig(
          runtimeManifest({
            updates: "disabled",
          }),
        ),
      ).toThrow("do not match");
    });

    test("rejects a build channel field, channel-valued updates and missing enabled feeds", () => {
      expect(() => parseSparkleRuntimeConfig(runtimeManifest({ buildChannel: "nightly" }))).toThrow(
        "unsupported shape",
      );
      expect(() => parseSparkleRuntimeConfig(runtimeManifest({ updates: "stable" }))).toThrow(
        "update availability is invalid",
      );
      expect(() => parseSparkleRuntimeConfig(runtimeManifest({ feedUrls: null }))).toThrow(
        "do not match",
      );
    });

    test("returns before native addon loading for a disabled package", () => {
      const resourcesPath = mkdtempSync(join(tmpdir(), "nodex-disabled-sparkle-"));
      try {
        mkdirSync(join(resourcesPath, "native"));
        writeFileSync(
          join(resourcesPath, "native", "sparkle-runtime.json"),
          JSON.stringify(runtimeManifest({ updates: "disabled", feedUrls: null })),
        );

        expect(
          createPackagedMacAppUpdaterPlatform({
            applicationBundlePath: "/missing/Nodex.app",
            architecture: "arm64",
            resourcesPath,
          }),
        ).toBeNull();
      } finally {
        rmSync(resourcesPath, { force: true, recursive: true });
      }
    });

    test("rolls back a native lease whose runtime identity does not match", () => {
      const resourcesPath = mkdtempSync(join(tmpdir(), "nodex-mismatched-sparkle-"));
      let disposeCount = 0;
      try {
        mkdirSync(join(resourcesPath, "native"));
        writeFileSync(
          join(resourcesPath, "native", "sparkle-runtime.json"),
          JSON.stringify(runtimeManifest()),
        );
        const platform = createPackagedMacAppUpdaterPlatform({
          applicationBundlePath: "/Applications/Nodex.app",
          architecture: "arm64",
          loadNativeBinding: () =>
            ({
              checkForUpdates: () => undefined,
              dispose: () => {
                disposeCount += 1;
              },
              initialize: () => ({ architecture: "x64", sparkleVersion: "2.9.4" }),
              installDownloadedUpdate: () => undefined,
              setFeedUrl: () => undefined,
            }) as never,
          resourcesPath,
        });

        expect(() => platform?.acquire("stable", () => undefined)).toThrow(
          "does not match its packaged manifest",
        );
        expect(disposeCount).toBe(1);
      } finally {
        rmSync(resourcesPath, { force: true, recursive: true });
      }
    });

    test("fences native events before releasing one exact lease", async () => {
      const resourcesPath = mkdtempSync(join(tmpdir(), "nodex-scoped-sparkle-"));
      let disposeCount = 0;
      const native: { emit?: (value: unknown) => void } = {};
      try {
        mkdirSync(join(resourcesPath, "native"));
        writeFileSync(
          join(resourcesPath, "native", "sparkle-runtime.json"),
          JSON.stringify(runtimeManifest()),
        );
        const platform = createPackagedMacAppUpdaterPlatform({
          applicationBundlePath: "/Applications/Nodex.app",
          architecture: "arm64",
          loadNativeBinding: () =>
            ({
              checkForUpdates: () => undefined,
              dispose: () => {
                disposeCount += 1;
              },
              initialize: (_options: unknown, emit: (value: unknown) => void) => {
                native.emit = emit;
                return { architecture: "arm64", sparkleVersion: "2.9.4" };
              },
              installDownloadedUpdate: () => undefined,
              setFeedUrl: () => undefined,
            }) as never,
          resourcesPath,
        });
        const events: unknown[] = [];
        const lease = platform?.acquire("stable", (event) => events.push(event));
        native.emit?.({ type: "up-to-date", version: "0.2.1" });
        await lease?.release();
        await lease?.release();
        native.emit?.({ type: "up-to-date", version: "0.2.2" });

        expect(events).toEqual([{ type: "up-to-date", version: "0.2.1" }]);
        expect(disposeCount).toBe(1);
      } finally {
        rmSync(resourcesPath, { force: true, recursive: true });
      }
    });

    test("normalizes native progress and rejects malformed event payloads", () => {
      expect(
        parseSparkleNativeEvent({
          expectedBytes: 1_000,
          receivedBytes: 240,
          type: "download-progress",
        }),
      ).toEqual({
        expectedBytes: 1_000,
        receivedBytes: 240,
        type: "download-progress",
      });
      expect(() =>
        parseSparkleNativeEvent({
          expectedBytes: 1_000,
          receivedBytes: -1,
          type: "download-progress",
        }),
      ).toThrow("non-negative byte count");
      expect(() => parseSparkleNativeEvent({ type: "unexpected" })).toThrow("Unsupported");
    });
  });
});
