import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import { layer as callbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import {
  ChromeControlRuntime,
  live as chromeControlLive,
} from "../host-runtime/ChromeControlRuntime";
import type { BrowserRuntimeAvailability } from "./browser-runtime-bundle";
import {
  WindowsDesktopTools,
  unsupportedWindowsDesktopTools,
} from "../platform/node/WindowsDesktopTools";
import { makeWindowsBrowserRuntimeVerifier } from "../platform/node/WindowsBrowserRuntimeVerifier";
import { BrowserUseThreadConfigBuilder } from "./browser-use-thread-config";
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
  parseBrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import type { WindowsBrowserRuntimeVerifierPort } from "./browser-runtime-windows-verifier-port";
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

function fixture(arch: "arm64" | "x64" = "x64") {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-win-desktop-tools-"));
  roots.push(runtimeRoot);
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
    manifest,
    file,
    replacePe(bytes: Buffer, attest = false) {
      fs.writeFileSync(file, bytes);
      if (!attest) return;
      addon.sha256 = sha(bytes);
      addon.size = bytes.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    load(windowsVerifier?: WindowsBrowserRuntimeVerifierPort, targetArch = arch) {
      return resolveBrowserRuntimeBundle({
        appServerIdentity,
        runtimeRoot,
        targetArch,
        targetPlatform: "win32",
        windowsVerifier,
        testedPairs: [
          {
            appServer: appServerIdentity,
            browser: {
              browserPluginVersion: manifest.browserPlugin.version,
              manifestSha256: sha(fs.readFileSync(manifestPath)),
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
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      windows,
      runtimeStateHome,
      codexHome: "C:/Users/用户/.codex",
    });
    const result = builder.buildResult();
    if (result.status !== "available") throw new Error(result.message);
    const definition = result.config["mcp_servers.node_repl"];
    const plugin = builder.buildDesktopTools({
      status: "ready",
      installedVersion: "1",
      enabled: true,
      marketplaceRoot: "C:/Nodex Profile/marketplace",
      chrome: { status: "unavailable", reason: "backend-unavailable", message: "unused" },
      computerUse: { status: "unavailable", reason: "capability-unavailable", message: "unused" },
    });
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
