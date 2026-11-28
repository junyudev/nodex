import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { layer as callbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import {
  ChromeControlRuntime,
  live as chromeControlLive,
} from "../host-runtime/ChromeControlRuntime";
import type { BrowserRuntimeAvailability } from "./browser-runtime-bundle";
import {
  WindowsDesktopTools,
  unsupportedWindowsDesktopTools,
  type RegistryValue,
} from "../platform/node/WindowsDesktopTools";
import { makeWindowsBrowserRuntimeVerifier } from "../platform/node/WindowsBrowserRuntimeVerifier";
import { BrowserUseThreadConfigBuilder } from "./browser-use-thread-config";
import type { ComputerUseRuntimeResult } from "../host-runtime/ComputerUseRuntime";
import {
  nodexDesktopToolMarketplaceName,
  windowsBrowserSkillBootstrap,
} from "./bundled-desktop-tool-marketplace";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  CHROME_NATIVE_HOST_NAME,
  parseBrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import type { WindowsBrowserRuntimeVerifierPort } from "./browser-runtime-windows-verifier-port";
import { appComponentStoreRoot } from "../app-components/AppComponentStore";
import { TEST_CHROME_FAMILY_DESCRIPTOR } from "../browser-use/chrome/chrome-test-fixture";
import { windowsChromeStatePath } from "../browser-use/chrome/WindowsChromeRegistration";
import {
  FIXTURE_PUBLISHER,
  fixtureWindowsPe,
  fixtureWindowsVerifier,
  writeWindowsBrowserRuntimeFixture,
} from "./browser-runtime-windows-test-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(arch: "arm64" | "x64" = "x64", component = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-win-desktop-tools-"));
  roots.push(home);
  const store = appComponentStoreRoot(home);
  const runtimeRoot = component ? path.join(store, "desktop-tools", "d".repeat(64)) : home;
  const root = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeWindowsBrowserRuntimeFixture(root, arch);
  const manifestPath = path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const addon = manifest.artifacts.find((entry) => entry.path === "bin/dependency.dll")!;
  const file = path.join(root, addon.path);
  const appServerIdentity = {
    entrypointSha256: "a".repeat(64),
    protocolSchemaFingerprint: "b".repeat(64),
    runtimeVersion: "0.166.0",
    sourceCommit: "c".repeat(40),
    targetArch: arch,
    targetPlatform: "win32",
  };
  return {
    root,
    store,
    manifest,
    file,
    replacePe(bytes: Buffer, attest = false) {
      fs.writeFileSync(file, bytes);
      if (!attest) return;
      addon.sha256 = sha(bytes);
      addon.size = bytes.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    load(
      windowsVerifier?: WindowsBrowserRuntimeVerifierPort,
      targetArch = arch,
      verifyWindowsTransport?: (signal?: AbortSignal) => Promise<void>,
    ) {
      const manifestSha256 = sha(fs.readFileSync(manifestPath));
      return resolveBrowserRuntimeBundle({
        appServerIdentity,
        expectedManifestSha256: component ? manifestSha256 : undefined,
        runtimeRoot,
        targetArch,
        targetPlatform: "win32",
        windowsVerifier,
        verifyWindowsTransport,
        testedPairs: [
          {
            appServer: appServerIdentity,
            browser: {
              browserPluginVersion: manifest.browserPlugin.version,
              manifestSha256,
              peerCliVersion: manifest.runtimeVersions.codexCli,
              targetArch: arch,
              targetPlatform: "win32",
            },
          },
        ],
      });
    },
  };
}

describe("Windows Desktop Tool manifests", () => {
  test.each(["arm64", "x64"] as const)("round trips %s with independent capabilities", (arch) => {
    const { manifest } = fixture(arch);
    expect(parseBrowserRuntimeManifest(manifest)).toEqual(manifest);
    expect(
      parseBrowserRuntimeManifest({
        ...manifest,
        capabilities: { ...manifest.capabilities, nativePip: {} },
      }),
    ).toBeNull();
    delete manifest.trust.pe["bin/dependency.dll"];
    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects case aliases and foreign-CPU trust declarations", () => {
    const { manifest } = fixture();
    const original = manifest.artifacts.find(
      (entry) => entry.path === "marketplace/plugins/browser/client.js",
    )!;
    const alias = { ...original, path: "Marketplace/plugins/browser/alias.js" };
    expect(
      parseBrowserRuntimeManifest({ ...manifest, artifacts: [...manifest.artifacts, alias] }),
    ).toBeNull();
    manifest.trust.pe["bin/dependency.dll"]!.machine = "arm64";
    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });
});

test.each(["arm64", "x64"] as const)(
  "checks the %s Component store before admitting native transport",
  async (arch) => {
    const { load, root, store } = fixture(arch, true);
    let boundaryTrusted = false;
    let transportCalls = 0;
    const verifier = makeWindowsBrowserRuntimeVerifier(
      {
        ...unsupportedWindowsDesktopTools,
        verifyStoreBoundary: (candidate) =>
          boundaryTrusted && candidate === store
            ? Effect.succeed(null)
            : unsupportedWindowsDesktopTools.verifyStoreBoundary(candidate),
        inspectPaths: (entries) =>
          Effect.succeed(
            entries.map(() => ({
              reparsePoint: false,
              grantsForeignWrite: false,
              ownerSid: "S-1-5-21-1",
              currentUserSid: "S-1-5-21-1",
            })),
          ),
        verifyAuthenticode: () =>
          Effect.succeed({
            status: "verified",
            signature: "embedded",
            chain: [FIXTURE_PUBLISHER],
            codeSigningEku: true,
            timestampPresent: true,
            revocation: "onlineChecked",
          }),
      },
      store,
      Effect.runPromise,
      "component-store",
    );
    const transport = async () => {
      transportCalls += 1;
      throw new Error("probe pipe unavailable");
    };
    expect(await load(verifier, arch, transport)).toMatchObject({
      status: "unavailable",
      reason: "platform-verification-failed",
      message: expect.stringContaining("verifyStoreBoundary"),
    });
    expect(transportCalls).toBe(0);
    boundaryTrusted = true;
    expect(await load(verifier, arch, transport)).toMatchObject({
      status: "unavailable",
      reason: "platform-verification-failed",
      message: expect.stringContaining("probe pipe unavailable"),
    });
    expect(transportCalls).toBe(1);
    expect(await load(verifier, arch, async () => {})).toMatchObject({
      status: "available",
      bundle: { rootPath: root },
    });
  },
);

describe("Windows Desktop Tool load", () => {
  test.each(["arm64", "x64"] as const)(
    "attests the %s closure through the Windows port",
    async (arch) => {
      const { load } = fixture(arch);
      expect(await load(fixtureWindowsVerifier())).toMatchObject({ status: "available" });
      expect(
        await load(fixtureWindowsVerifier(), arch === "arm64" ? "x64" : "arm64"),
      ).toMatchObject({ reason: "target-mismatch" });
      expect(await load()).toMatchObject({
        status: "unavailable",
        message: "Windows Desktop Tool verification unavailable",
      });
    },
  );

  test.each(["size", "hash"] as const)("rejects a wrong %s", async (kind) => {
    const { file, replacePe, load } = fixture();
    const bytes = fs.readFileSync(file);
    bytes[0x120] ^= 1;
    replacePe(kind === "size" ? bytes.subarray(0, bytes.length - 1) : bytes);
    expect(await load(fixtureWindowsVerifier())).toMatchObject({ reason: "artifact-integrity" });
  });

  test.each([
    ["foreign CPU", fixtureWindowsPe("arm64"), "PE machine type mismatch"],
    ["unsigned image", fixtureWindowsPe("x64", null), "no embedded Authenticode signature"],
  ] as const)("rejects an attested %s", async (_name, bytes, message) => {
    const { replacePe, load } = fixture();
    replacePe(bytes, true);
    expect(await load(fixtureWindowsVerifier())).toMatchObject({
      reason: "platform-verification-failed",
      message: expect.stringContaining(message),
    });
  });

  test("rejects a signer outside the publisher policy", async () => {
    const { load } = fixture();
    expect(
      await load(
        fixtureWindowsVerifier({
          async verifyAuthenticode() {
            return { ok: true, value: { subject: "CN=Other", issuer: "CN=Other" } };
          },
        }),
      ),
    ).toMatchObject({
      reason: "platform-verification-failed",
      message: expect.stringContaining("publisher"),
    });
  });

  test.each(["reparse entry", "foreign owner"])(
    "propagates native rejection of a %s",
    async (reason) => {
      const { load } = fixture();
      expect(
        await load(
          fixtureWindowsVerifier({
            async verifyClosurePaths() {
              return { ok: false, reason };
            },
          }),
        ),
      ).toMatchObject({ reason: "platform-verification-failed", message: reason });
    },
  );

  test("rejects a file outside the manifest", async () => {
    const { root, load } = fixture();
    fs.writeFileSync(path.join(root, "extra.js"), "unexpected");
    expect(await load(fixtureWindowsVerifier())).toMatchObject({
      reason: "artifact-invalid",
      message: expect.stringContaining("extra.js"),
    });
  });
});

test.each(["arm64", "x64"] as const)(
  "binds Windows %s path and publisher evidence through the loader",
  async (arch) => {
    const { load, root } = fixture(arch);
    const secure = {
      reparsePoint: false,
      ownerSid: "S-1-5-18",
      currentUserSid: "S-1-5-21-1",
      grantsForeignWrite: false,
    };
    let unsafe = {};
    let unsafePath: string | undefined;
    let signer = FIXTURE_PUBLISHER;
    const inspected: string[] = [];
    const verified: string[] = [];
    const verifier = makeWindowsBrowserRuntimeVerifier(
      {
        ...unsupportedWindowsDesktopTools,
        inspectPaths: (paths) =>
          Effect.sync(() => {
            inspected.push(...paths);
            return paths.map((file) => ({ ...secure, ...(file === unsafePath ? unsafe : {}) }));
          }),
        verifyAuthenticode: (file, strict) =>
          Effect.sync(() => {
            expect(strict).toBe(true);
            verified.push(file);
            return {
              status: "verified",
              signature: "embedded",
              chain: [signer],
              codeSigningEku: true,
              timestampPresent: true,
              revocation: "onlineChecked",
            };
          }),
      },
      path.dirname(root),
      Effect.runPromise,
    );
    expect(await load(verifier)).toMatchObject({ status: "available" });
    expect(inspected).toContain(path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME));
    expect(verified).toContain(path.join(root, "bin", "dependency.dll"));
    for (const security of [
      { reparsePoint: true },
      { ownerSid: "S-1-5-21-2" },
      { grantsForeignWrite: true },
    ]) {
      unsafePath = path.join(root, "bin");
      unsafe = security;
      expect(await load(verifier)).toMatchObject({
        reason: "platform-verification-failed",
        message: expect.stringContaining(unsafePath),
      });
    }
    unsafePath = undefined;
    signer = { ...FIXTURE_PUBLISHER, issuer: "CN=Foreign CA" };
    expect(await load(verifier)).toMatchObject({
      reason: "platform-verification-failed",
      message: expect.stringContaining("publisher or issuer"),
    });
  },
);

test.each(["arm64", "x64"] as const)(
  "shares the %s closed launch definition across local providers",
  async (arch) => {
    const browserRuntime = await fixture(arch).load(fixtureWindowsVerifier());
    if (browserRuntime.status !== "available") throw new Error(browserRuntime.message);
    const runtimeStateHome = "C:/Users/用户/Nodex Profile/runtime";
    const windows = {
      jobLauncher: "C:/Program Files/Nodex/nodex-core.exe",
      environment: {
        SystemRoot: "C:/Windows",
        node_repl_host_services_pipe_path: "foreign",
        CODEX_WINDOWS_REGISTERED_CORE: "foreign",
        Path: "foreign",
      },
    };
    let computerUseRuntime: ComputerUseRuntimeResult = {
      status: "unavailable",
      reason: "disabled",
      message: "Computer Use is turned off.",
    };
    const builder = new BrowserUseThreadConfigBuilder({
      computerUsePluginReady: () => true,
      computerUseRuntime: () => computerUseRuntime,
      browserRuntime,
      windows,
      runtimeStateHome,
      codexHome: "C:/Users/用户/.codex",
    });
    const result = builder.buildResult();
    if (result.status !== "available") throw new Error(result.message);
    const definition = result.config["mcp_servers.node_repl"];
    const plugins = {
      status: "ready",
      installedVersion: "1",
      enabled: true,
      marketplaceRoot: "C:/Nodex Profile/marketplace",
      chrome: { status: "unavailable", reason: "backend-unavailable", message: "unused" },
      computerUse: {
        status: "ready",
        enabled: true,
        installedVersion: "1",
        pluginRoot: "C:/Nodex Profile/computer-use",
      },
    } as const;
    const plugin = builder.buildDesktopTools(plugins);
    expect(definition).toMatchObject(plugin!.server);
    expect(plugin?.server.command).toBe(windows.jobLauncher);
    const [mode, stdio, image, , environment] = plugin!.server.args;
    expect(mode).toBe("--desktop-tools-job");
    expect(stdio).toBe("inherit");
    expect(image).toBe(browserRuntime.bundle.paths.nodeRepl);
    const env = JSON.parse(environment!);
    expect(env).toMatchObject({
      SYSTEMROOT: "C:/Windows",
      CODEX_HOME: "C:\\Users\\用户\\Nodex Profile\\runtime\\desktop-tools\\codex-home",
      BROWSER_USE_AVAILABLE_BACKENDS: "iab",
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: nodexDesktopToolMarketplaceName(
        runtimeStateHome,
        "win32",
      ),
    });
    expect(env.NODE_REPL_TRUSTED_CODE_PATHS).toContain(";");
    expect(Object.values(env)).not.toContain("foreign");
    expect(plugin?.server.env).toEqual({});
    expect(nodexDesktopToolMarketplaceName(runtimeStateHome.toUpperCase(), "win32")).toBe(
      env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR,
    );
    expect(env.SKY_CUA_NATIVE_PIPE_DIRECTORY).toBeUndefined();
    expect(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES)).not.toHaveProperty("sky");
    for (const nativePipePath of ["cua-first", "cua-restarted"]) {
      computerUseRuntime = {
        status: "available",
        platform: "win32",
        nativePipePath,
        serviceExecutablePath: "C:/Nodex Profile/runtime/service.exe",
      };
      const withComputerUse = builder.buildResult();
      if (withComputerUse.status !== "available") throw new Error(withComputerUse.message);
      const desktopTools = builder.buildDesktopTools(plugins)!;
      expect(withComputerUse.config["mcp_servers.node_repl"]).toMatchObject(desktopTools.server);
      expect(desktopTools.pluginRoots).toContain(plugins.computerUse.pluginRoot);
      const replEnv = JSON.parse(desktopTools.server.args[4]!);
      expect(replEnv).toMatchObject({
        SKY_CUA_NATIVE_PIPE: "1",
        SKY_CUA_NATIVE_PIPE_DIRECTORY: nativePipePath,
      });
      expect(JSON.parse(replEnv.NODE_REPL_TRUSTED_SERVICES)).toHaveProperty(
        "sky",
        "@oai/sky/service",
      );
    }
  },
);

test("Windows Browser instructions import the absolute plugin module as a file URL", () => {
  const source =
    'const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");';
  expect(windowsBrowserSkillBootstrap(source)).toContain(
    'pathToFileURL("<plugin root>/scripts/browser-client.mjs").href',
  );
});

it.effect(
  "Chrome control reads the verified Windows target after Main has acquired the service",
  () =>
    Effect.gen(function* () {
      const verified = yield* Effect.promise(() => fixture().load(fixtureWindowsVerifier()));
      if (verified.status !== "available") throw new Error(verified.message);
      let browserRuntime: BrowserRuntimeAvailability = {
        status: "unavailable",
        reason: "platform-verification-failed",
        message: "verification pending",
      };
      const ready = yield* Deferred.make<void>();
      const runtime = chromeControlLive({
        get browserRuntime() {
          return browserRuntime;
        },
        windowsBrowserReady: Deferred.await(ready),
        registration: { kind: "production", homeDirectory: "C:/Users/Nodex" },
        peerAuthorizationMode: "packaged",
        platform: "win32",
        architecture: "x64",
        runtimeStateHome: "C:/Users/Nodex/Profile/runtime",
      }).pipe(
        Layer.provide(
          Layer.merge(
            callbackRuntimeLayer,
            Layer.succeed(WindowsDesktopTools, unsupportedWindowsDesktopTools),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const chrome = yield* ChromeControlRuntime;
        expect(chrome.snapshot()).toMatchObject({
          requested: false,
          reason: "verification pending",
        });
        browserRuntime = verified;
        yield* Deferred.succeed(ready, undefined);
        // The fixture advertises Chrome but its synthetic descriptor cannot activate it.
        expect(yield* chrome.refresh).toMatchObject({
          requested: true,
          status: "runtime-unavailable",
        });
      }).pipe(Effect.provide(runtime));
    }),
);

it.effect(
  "Windows Chrome registration replaces the active Component pin and retires it on removal",
  () =>
    Effect.gen(function* () {
      const first = fixture("x64", true);
      const second = fixture("x64", true);
      const loadPin = async ({ manifest, root, load }: ReturnType<typeof fixture>) => {
        const chrome = manifest.capabilities.browserUse.backends.chrome;
        if (chrome.status !== "available") throw new Error("Expected a Chrome capability");
        const descriptor = {
          ...TEST_CHROME_FAMILY_DESCRIPTOR,
          browserDiagnostics: TEST_CHROME_FAMILY_DESCRIPTOR.browserDiagnostics.map((family) => ({
            ...family,
            windows: {
              processNames: [`${family.browserFamily}.exe`],
              userDataDirectorySegments: [family.shortDisplayName],
            },
          })),
        };
        const bytes = Buffer.from(JSON.stringify(descriptor));
        chrome.extensionIds = [...descriptor.extensionIds];
        const artifact = manifest.artifacts.find(({ path }) => path === chrome.familyDescriptor)!;
        artifact.size = bytes.byteLength;
        artifact.sha256 = sha(bytes);
        fs.writeFileSync(path.join(root, chrome.familyDescriptor), bytes);
        fs.writeFileSync(
          path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME),
          JSON.stringify(manifest),
        );
        const result = await load(fixtureWindowsVerifier());
        if (result.status !== "available") throw new Error(result.message);
        return result.bundle;
      };
      const firstPin = yield* Effect.promise(() => loadPin(first));
      const secondPin = yield* Effect.promise(() => loadPin(second));
      const runtimeStateHome = path.join(path.dirname(first.store), "runtime", "agent");
      const install = path.join(path.dirname(first.store), "Program Files", "Nodex");
      const pins = yield* SubscriptionRef.make<typeof firstPin | null>(null);
      const registry = new Map<string, RegistryValue>();
      const native = Layer.succeed(WindowsDesktopTools, {
        ...unsupportedWindowsDesktopTools,
        verifyAuthenticode: () =>
          Effect.succeed({
            status: "verified",
            signature: "embedded",
            chain: [FIXTURE_PUBLISHER],
            codeSigningEku: true,
            timestampPresent: true,
            revocation: "cacheChecked",
          }),
        inspectPath: () =>
          Effect.succeed({
            reparsePoint: false,
            grantsForeignWrite: false,
            ownerSid: "S-1-5-21-1",
            currentUserSid: "S-1-5-21-1",
          }),
        enumeratePipes: () => Effect.succeed({ names: [], truncated: false }),
        readRegistration: ({ browser }) => Effect.sync(() => registry.get(browser) ?? null),
        writeRegistration: (key, previous, target) =>
          Effect.sync(() => {
            const installed = {
              kind: 1,
              dataHex: Buffer.from(`${target}\0`, "utf16le").toString("hex"),
            };
            registry.set(key.browser, installed);
            return { key, installed, previous, createdKey: previous === null };
          }),
        restoreRegistration: ({ browser }, receipt) =>
          Effect.sync(() => {
            if (registry.get(browser)?.dataHex !== receipt.installed.dataHex) return false;
            if (receipt.previous) registry.set(browser, receipt.previous);
            else registry.delete(browser);
            return true;
          }),
      });
      const runtime = chromeControlLive({
        browserRuntime: {
          status: "unavailable",
          reason: "not-installed",
          message: "Install Desktop Tools",
        },
        windowsComponentChanges: SubscriptionRef.changes(pins),
        windowsBrowserReady: Effect.void,
        windowsInstallationDirectory: install,
        registration: { kind: "production", homeDirectory: path.dirname(first.store) },
        peerAuthorizationMode: "packaged",
        platform: "win32",
        runtimeStateHome,
      }).pipe(Layer.provide(Layer.merge(native, callbackRuntimeLayer)));
      yield* Effect.gen(function* () {
        const chrome = yield* ChromeControlRuntime;
        const publish = (pin: typeof firstPin | null) =>
          Effect.gen(function* () {
            const revision = chrome.snapshot().revision;
            const observed = yield* chrome.changes.pipe(
              Stream.filter(
                ({ snapshot }) =>
                  snapshot.revision > revision && snapshot.nativeHostInstalled === Boolean(pin),
              ),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* SubscriptionRef.set(pins, pin);
            yield* Fiber.join(observed);
          });
        const registryPath = path.join(runtimeStateHome, "chrome-native-hosts-v2.json");
        const entries = () => JSON.parse(fs.readFileSync(registryPath, "utf8")).entries;
        yield* publish(firstPin);
        expect(registry.size).toBe(2);
        expect(entries()).toMatchObject([{ paths: { resourcesPath: firstPin.rootPath } }]);
        const firstRegistration = registry.get("chrome");
        yield* publish(secondPin);
        expect(entries()).toMatchObject([{ paths: { resourcesPath: secondPin.rootPath } }]);
        expect(registry.get("chrome")).toEqual(firstRegistration);
        const state = windowsChromeStatePath(runtimeStateHome);
        expect(
          JSON.parse(fs.readFileSync(path.join(state, "registration-v1.json"), "utf8")),
        ).toMatchObject({ installationDirectory: install });
        expect(
          fs.existsSync(path.join(state, "native-messaging", `${CHROME_NATIVE_HOST_NAME}.json`)),
        ).toBe(true);
        yield* publish(null);
        expect(registry.size).toBe(0);
        expect(entries()).toEqual([]);
        expect(chrome.snapshot()).toMatchObject({
          nativeHostInstalled: false,
          providerReady: false,
          browserRuntimeUnavailableReason: "not-installed",
        });
      }).pipe(Effect.provide(runtime));
    }),
);
