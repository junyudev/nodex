// @effect-diagnostics strictEffectProvide:off
import { it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { pinnedTarExecutable } from "../platform/node/pinned-tar-archive";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, vi } from "vite-plus/test";
import {
  APP_COMPONENT_MANIFEST_MAX_BYTES,
  appComponentManifestSchema,
  type AppComponentManifestTarget,
} from "../../shared/app-component-manifest";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { writeDocumentToolsFixture } from "../platform/node/document-tools-test-fixture";
import {
  ApplicationSettings,
  make as makeApplicationSettings,
} from "../settings/ApplicationSettings";
import { AppComponentActivation } from "./AppComponentActivation";
import { appComponentCatalog, type AppComponentDefinition } from "./AppComponentCatalog";
import { fetchComponentManifest, type ComponentFetch } from "./AppComponentDownload";
import {
  appComponentRoot,
  installAppComponent,
  prepareAppComponentStoreSweep,
  type AppComponentStoreInput,
  setAppComponentWanted,
  writeAppComponentReceipt,
} from "./AppComponentStore";
import { AppComponentFetch, make } from "./AppComponents";
import { writeClaudeCodeFixture } from "./claude-code-fixture";

vi.mock("./AppComponentCatalog", { spy: true });
async function prepareAppComponentStore(
  input: AppComponentStoreInput & { readonly appBuildVersion?: string },
): Promise<void> {
  const sweep = await prepareAppComponentStoreSweep(input);
  await sweep();
}

afterEach(() => vi.mocked(appComponentCatalog).mockReset());

interface PrefetchTestTarget {
  platform: string;
  arch: string;
  isPackaged: boolean;
  environment?: Record<string, string>;
}
const target: PrefetchTestTarget = {
  platform: "darwin",
  arch: "arm64",
  isPackaged: true,
};
const currentBuild = "1.0.1";
const update = (buildVersion = "1.0.2") => ({
  target: "darwin-arm64" as const,
  version: "0.2.2",
  buildVersion,
  manifestUrl: `https://example.test/${buildVersion}/components.json`,
});
const respondWithManifest = (
  next: Omit<ReturnType<typeof update>, "target"> & { readonly target: AppComponentManifestTarget },
  components: readonly AppComponentDefinition[],
) =>
  Response.json({
    schemaVersion: 1,
    target: next.target,
    version: next.version,
    buildVersion: next.buildVersion,
    components,
  });

function archive(
  home: string,
  name: string,
  id: "claude-code" | "document-tools",
  windows = false,
) {
  const source = path.join(home, name);
  const payload =
    id === "claude-code"
      ? writeClaudeCodeFixture(source, name, windows)
      : writeDocumentToolsFixture(source, createHash("sha256").update(name).digest("hex")).payload;
  const assetName = `${name}.tar.gz`;
  const packed = path.join(home, assetName);
  execFileSync(pinnedTarExecutable(), ["-czf", packed, "-C", source, "."]);
  const bytes = new Uint8Array(readFileSync(packed));
  return {
    bytes,
    definition: {
      id,
      install: "on-first-use",
      payload,
      unpackedBytes: 4096,
      archive: {
        assetName,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: `https://example.test/${assetName}`,
      },
    } satisfies AppComponentDefinition,
  };
}

const install = (
  home: string,
  item: ReturnType<typeof archive>,
  fetch?: ComponentFetch,
  testTarget = target,
) =>
  installAppComponent({
    home,
    target: testTarget,
    definition: item.definition,
    fetch: fetch ?? (() => Promise.resolve(new Response(item.bytes))),
    signal: new AbortController().signal,
    onProgress: () => {},
    onInstalling: () => {},
  });

const fixture = Effect.fnUntraced(function* (testTarget = target) {
  const windows = testTarget.platform === "win32";
  const home = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-prefetch-"))),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
  const current = archive(home, "current", "claude-code", windows);
  const next = archive(home, "next", "claude-code", windows);
  const document = archive(home, "documents", "document-tools");
  const catalog = windows ? [current.definition] : [current.definition, document.definition];
  vi.mocked(appComponentCatalog).mockReturnValue(catalog);
  yield* Effect.promise(() => install(home, current, undefined, testTarget));
  yield* Effect.promise(() =>
    setAppComponentWanted({ home, target: testTarget }, "claude-code", true),
  );
  const active = new Set<string>();
  const activation = AppComponentActivation.of({
    activate: (id) =>
      Effect.sync(() => {
        active.add(id);
        return { status: "active" } as const;
      }),
    isActive: (id) => Effect.sync(() => active.has(id)),
  });
  const settings = yield* makeApplicationSettings({
    environment: {},
    hostHomeDirectory: home,
    settingsPath: path.join(home, "config.toml"),
  });
  const start = (fetch: ComponentFetch) =>
    make.pipe(
      Effect.provide(
        Layer.mergeAll(
          mainConfigLayer({
            platform: testTarget.platform,
            arch: testTarget.arch,
            isPackaged: testTarget.isPackaged,
            environment: testTarget.environment ?? {},
            nodexHome: home,
            appBuildVersion: currentBuild,
          }),
          Layer.succeed(ApplicationSettings, settings),
          Layer.succeed(AppComponentFetch, { fetch }),
          Layer.succeed(AppComponentActivation, activation),
        ),
      ),
      Effect.tap((owner) => owner.ensure("claude-code")),
    );
  return {
    home,
    current,
    next,
    document,
    start,
    root: (item: ReturnType<typeof archive>) => appComponentRoot(home, item.definition),
    part: path.join(home, "components", "downloads", `${next.definition.archive.sha256}.part`),
    record: path.join(home, "components", "next.json"),
  };
});

function pausedDownload(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal | null | undefined) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 16));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

function resumedDownload(bytes: Uint8Array<ArrayBuffer>, init: RequestInit) {
  expect(new Headers(init.headers).get("range")).toBe("bytes=16-");
  return new Response(bytes.subarray(16), {
    status: 206,
    headers: { "content-range": `bytes 16-${bytes.length - 1}/${bytes.length}` },
  });
}

it.effect(
  "stages only changed installed pins, then drops a superseded pin even if the new manifest is unavailable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const documentNext = archive(f.home, "new-documents", "document-tools");
      const sharedPin = update("1.0.3");
      const replacement = update("1.0.4");
      const fetch = vi.fn<ComponentFetch>((url) =>
        Promise.resolve(
          url === update().manifestUrl
            ? respondWithManifest(update(), [f.next.definition, documentNext.definition])
            : url === sharedPin.manifestUrl
              ? respondWithManifest(sharedPin, [f.next.definition])
              : url === replacement.manifestUrl
                ? new Response(null, { status: 404 })
                : new Response(f.next.bytes),
        ),
      );
      const owner = yield* f.start(fetch);
      const before = yield* owner.read;
      yield* owner.prefetchUpdate(update());
      yield* Effect.promise(() =>
        expect.poll(() => existsSync(f.root(f.next)) && !existsSync(f.part)).toBe(true),
      );
      expect(yield* owner.read).toEqual(before);
      expect(readFileSync(path.join(f.root(f.current), "package/claude"), "utf8")).toBe("current");
      expect(readFileSync(path.join(f.root(f.next), "package/claude"), "utf8")).toBe("next");
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        update().manifestUrl,
        f.next.definition.archive.url,
      ]);
      yield* Effect.promise(() =>
        prepareAppComponentStore({ home: f.home, target, appBuildVersion: currentBuild }),
      );
      expect(existsSync(f.root(f.next))).toBe(true);
      yield* owner.prefetchUpdate(sharedPin);
      yield* Effect.promise(() =>
        expect
          .poll(() => JSON.parse(readFileSync(f.record, "utf8")).buildVersion)
          .toBe(sharedPin.buildVersion),
      );
      expect(existsSync(f.root(f.next))).toBe(true);
      expect(
        fetch.mock.calls.filter(([url]) => url === f.next.definition.archive.url),
      ).toHaveLength(1);
      yield* owner.prefetchUpdate(replacement);
      yield* Effect.promise(() =>
        expect.poll(() => !existsSync(f.root(f.next)) && !existsSync(f.record)).toBe(true),
      );
      expect(existsSync(f.root(f.current))).toBe(true);
    }),
);

it.effect("skips an unchanged installation and removes a staged pin when turned off", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const nextDocument = archive(f.home, "new-documents", "document-tools");
    const fetch = vi.fn<ComponentFetch>((url) =>
      Promise.resolve(
        url === update().manifestUrl
          ? respondWithManifest(update(), [f.current.definition, nextDocument.definition])
          : new Response(
              url === nextDocument.definition.archive.url ? nextDocument.bytes : f.document.bytes,
            ),
      ),
    );
    const owner = yield* f.start(fetch);
    expect((yield* owner.ensure("document-tools")).status).toBe("installed");
    yield* owner.prefetchUpdate(update());
    yield* Effect.promise(() => expect.poll(() => existsSync(f.root(nextDocument))).toBe(true));

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      f.document.definition.archive.url,
      update().manifestUrl,
      nextDocument.definition.archive.url,
    ]);
    yield* owner.setEnabled({ id: "document-tools", enabled: false });
    expect(existsSync(f.root(nextDocument))).toBe(false);
    expect(existsSync(f.root(f.document))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  }),
);

it.effect(
  "retains the next partial on the old build and resumes it as the new build's current pin",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* f.start((url, init) =>
            Promise.resolve(
              url === update().manifestUrl
                ? respondWithManifest(update(), [f.next.definition])
                : pausedDownload(f.next.bytes, init.signal),
            ),
          );
          yield* owner.prefetchUpdate(update());
          yield* Effect.promise(() =>
            expect.poll(() => existsSync(f.part) && statSync(f.part).size).toBe(16),
          );
        }),
      );
      const store = { home: f.home, target };
      yield* Effect.promise(() =>
        prepareAppComponentStore({ ...store, appBuildVersion: currentBuild }),
      );
      expect(existsSync(f.record)).toBe(true);
      expect(statSync(f.part).size).toBe(16);
      vi.mocked(appComponentCatalog).mockReturnValue([f.next.definition, f.document.definition]);
      yield* Effect.promise(() =>
        prepareAppComponentStore({ ...store, appBuildVersion: update().buildVersion }),
      );
      expect(existsSync(f.record)).toBe(false);
      expect(existsSync(f.root(f.current))).toBe(false);
      expect(statSync(f.part).size).toBe(16);
      yield* Effect.promise(() =>
        install(f.home, f.next, (_url, init) =>
          Promise.resolve(resumedDownload(f.next.bytes, init)),
        ),
      );
      const versions = readdirSync(path.dirname(f.root(f.next))).filter(
        (name) => !name.startsWith("."),
      );
      expect(versions).toEqual([f.next.definition.archive.sha256]);
      expect(existsSync(f.part)).toBe(false);
    }),
);

it.effect("disabling a Component cancels its prefetch and collects its partial", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let downloadSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<ComponentFetch>((url, init) => {
      if (url === update().manifestUrl)
        return Promise.resolve(respondWithManifest(update(), [f.next.definition]));
      downloadSignal = init.signal;
      return Promise.resolve(pausedDownload(f.next.bytes, init.signal));
    });
    const owner = yield* f.start(fetch);
    yield* owner.prefetchUpdate(update());
    yield* Effect.promise(() =>
      expect.poll(() => existsSync(f.part) && statSync(f.part).size).toBe(16),
    );
    const disabled = yield* owner.setEnabled({ id: "claude-code", enabled: false });
    expect(disabled.components[0]).toMatchObject({ enabled: false, removalPending: true });
    expect(downloadSignal?.aborted).toBe(true);
    expect(existsSync(f.part)).toBe(false);
    expect(existsSync(f.record)).toBe(false);
    expect(existsSync(f.root(f.current))).toBe(true);
    const another = update("1.0.3");
    fetch.mockImplementation((url) =>
      Promise.resolve(
        url === another.manifestUrl
          ? respondWithManifest(another, [f.next.definition])
          : new Response(f.next.bytes),
      ),
    );
    yield* owner.prefetchUpdate(another);
    yield* Effect.promise(() =>
      expect.poll(() => fetch.mock.calls.at(-1)?.[0]).toBe(another.manifestUrl),
    );
    expect(fetch.mock.calls.filter(([url]) => url === f.next.definition.archive.url)).toHaveLength(
      1,
    );
  }),
);

it.effect("yields a prefetch to a normal install and resumes it from the saved offset", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let attempt = 0;
    let firstSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<ComponentFetch>((url, init) => {
      if (url === update().manifestUrl)
        return Promise.resolve(
          respondWithManifest(update(), [f.next.definition, f.document.definition]),
        );
      if (url === f.document.definition.archive.url) {
        expect(firstSignal?.aborted).toBe(true);
        return Promise.resolve(new Response(f.document.bytes));
      }
      if (attempt++ > 0) {
        expect(existsSync(f.root(f.document))).toBe(true);
        return Promise.resolve(resumedDownload(f.next.bytes, init));
      }
      firstSignal = init.signal;
      return Promise.resolve(pausedDownload(f.next.bytes, init.signal));
    });
    const owner = yield* f.start(fetch);
    yield* owner.prefetchUpdate(update());
    yield* Effect.promise(() =>
      expect.poll(() => existsSync(f.part) && statSync(f.part).size).toBe(16),
    );
    expect((yield* owner.ensure("document-tools")).status).toBe("installed");
    yield* Effect.promise(() => expect.poll(() => existsSync(f.root(f.next))).toBe(true));
    expect(attempt).toBe(2);
  }),
);

it.effect("rejects a foreign-target manifest before fetching its Component archives", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const valid = update();
    const foreign = update("1.0.3");
    const different = archive(f.home, "foreign-pin", "claude-code");
    const fetch = vi.fn<ComponentFetch>(async (url) => {
      if (url === foreign.manifestUrl)
        return respondWithManifest({ ...foreign, target: "win32-x64" }, [different.definition]);
      if (url === valid.manifestUrl) return respondWithManifest(valid, [f.next.definition]);
      return new Response(f.next.bytes);
    });
    const owner = yield* f.start(fetch);
    yield* owner.prefetchUpdate(valid);
    yield* Effect.promise(() =>
      expect.poll(() => existsSync(f.record) && existsSync(f.root(f.next))).toBe(true),
    );
    fetch.mockClear();
    yield* owner.prefetchUpdate(foreign);
    yield* Effect.promise(() => expect.poll(() => existsSync(f.record)).toBe(false));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([foreign.manifestUrl]);
  }),
);

it.effect("bounds the decoded manifest and rejects invalid component definitions", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const raw = {
      schemaVersion: 1,
      target: update().target,
      version: update().version,
      buildVersion: update().buildVersion,
      components: [f.next.definition],
    };
    expect(appComponentManifestSchema.safeParse(raw).success).toBe(true);
    for (const component of [
      { ...f.next.definition, unexpected: true },
      {
        ...f.next.definition,
        archive: { ...f.next.definition.archive, url: "http://example.test/archive" },
      },
      { ...f.next.definition, payload: { kind: "document-tools", manifestSha256: "a".repeat(64) } },
    ])
      expect(
        appComponentManifestSchema.safeParse({ ...raw, components: [component] }).success,
      ).toBe(false);
    yield* Effect.promise(() =>
      expect(
        fetchComponentManifest(
          update().manifestUrl,
          () =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(APP_COMPONENT_MANIFEST_MAX_BYTES + 1));
                  },
                }),
              ),
            ),
          new AbortController().signal,
        ),
      ).rejects.toThrow("too large"),
    );
  }),
);

it.effect("prefetches Codex as a verified archive and retains it for the next build", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const asCodex = (item: ReturnType<typeof archive>): AppComponentDefinition => ({
      ...item.definition,
      id: "codex",
      payload: { kind: "codex", metadataSha256: "a".repeat(64), entrypointSha256: "b".repeat(64) },
    });
    const current = asCodex(archive(f.home, "stub-codex-current", "claude-code"));
    const next = asCodex(f.next);
    vi.mocked(appComponentCatalog).mockReturnValue([f.current.definition, current]);
    const installed = appComponentRoot(f.home, current);
    yield* Effect.promise(async () => {
      mkdirSync(installed, { recursive: true });
      await writeAppComponentReceipt(installed, 100);
      await setAppComponentWanted({ home: f.home, target }, current.id, true);
    });
    // The real archive's digest and receipt are checked by the store. This harness owns activation.
    const fetch = vi.fn<ComponentFetch>((url) =>
      Promise.resolve(
        url === update().manifestUrl
          ? respondWithManifest(update(), [next])
          : new Response(f.next.bytes),
      ),
    );
    const owner = yield* f.start(fetch);
    yield* owner.ensure("codex");
    yield* owner.prefetchUpdate(update());
    yield* Effect.promise(() =>
      expect.poll(() => (existsSync(f.part) ? statSync(f.part).size : 0)).toBe(next.archive.size),
    );
    expect(existsSync(appComponentRoot(f.home, next))).toBe(false);
    vi.mocked(appComponentCatalog).mockReturnValue([next]);
    yield* Effect.promise(() =>
      prepareAppComponentStore({ home: f.home, target, appBuildVersion: update().buildVersion }),
    );
    expect(readFileSync(f.part)).toEqual(Buffer.from(f.next.bytes));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([update().manifestUrl, next.archive.url]);
  }),
);

it.effect("prefetches a Windows Claude Code pin into the private store", () =>
  Effect.gen(function* () {
    const environment: Record<string, string> =
      process.platform === "win32"
        ? { NODEX_CORE_EXECUTABLE: requiredNativeExecutable("core-server") }
        : {};
    const testTarget = {
      platform: "win32",
      arch: process.arch === "x64" ? "x64" : "arm64",
      isPackaged: true,
      environment,
    };
    const f = yield* fixture(testTarget);
    const nextUpdate = update();
    const owner = yield* f.start((url) =>
      Promise.resolve(
        url === nextUpdate.manifestUrl
          ? respondWithManifest(nextUpdate, [f.next.definition])
          : new Response(f.next.bytes),
      ),
    );
    yield* owner.prefetchUpdate(nextUpdate);
    yield* Effect.promise(() =>
      expect.poll(() => existsSync(path.join(f.root(f.next), "package", "claude.exe"))).toBe(true),
    );
    expect(readFileSync(path.join(f.root(f.next), "package", "claude.exe"), "utf8")).toBe("next");
  }),
);
