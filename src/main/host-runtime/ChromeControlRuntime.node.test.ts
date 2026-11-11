import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolveChromeHostRegistration } from "../browser-use/chrome/ChromeHostRegistrationPolicy";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { expect, test, vi } from "vite-plus/test";
import {
  ChromeHostRegistrationInUse,
  type ChromeNativeHostInstallResult,
} from "../browser-use/chrome/ChromeNativeHostInstaller";
import {
  makeChromeControlRuntime,
  resolveChromeNativeHostNodeModuleDirs,
  type ChromeControlExtensionRegistryPort,
  type ChromeControlRuntimePorts,
} from "./ChromeControlRuntime";

test("projects only the packaged runtime Node module root into the native-host registry", () => {
  expect(
    resolveChromeNativeHostNodeModuleDirs("/runtime", [
      "runtime/lib/node_modules",
      "marketplace/plugins/browser/node_modules",
    ]),
  ).toEqual([path.join("/runtime", "runtime", "lib", "node_modules")]);
});

const extensionId = "hehggadaopoacecdllhhajmbjkdcmajg";
const peerIdentity = { signingIdentifier: "com.openai.chrome-host", teamId: "TESTTEAM1A" };
const installResult: ChromeNativeHostInstallResult = {
  manifestPaths: ["/profile/chrome/native-messaging.json"],
  nativeHostPath: "/profile/chrome/native-host",
  peerIdentity,
  registryPaths: ["/profile/chrome/chrome-native-hosts-v2.json"],
};

function makeRegistry(): ChromeControlExtensionRegistryPort & {
  connect: (extensionInstanceId: string, family?: string) => void;
  disconnect: () => void;
  focused: Array<{ extensionInstanceId: string; sessionId: string; tabId: string }>;
  stopped: boolean;
  subscribed: Promise<void>;
} {
  let connected: { readonly extensionInstanceId: string; readonly family: string } | null = null;
  let revision = 0;
  const focused: Array<{ extensionInstanceId: string; sessionId: string; tabId: string }> = [];
  const listeners = new Set<Parameters<ChromeControlExtensionRegistryPort["subscribe"]>[0]>();
  let resolveSubscribed: () => void = () => undefined;
  const subscribed = new Promise<void>((resolve) => {
    resolveSubscribed = resolve;
  });
  const snapshot = () => ({
    instances: connected
      ? [
          {
            extensionId,
            extensionInstanceId: connected.extensionInstanceId,
            family: connected.family,
          },
        ]
      : [],
    providerReady: connected !== null,
    revision,
  });
  const publish = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };
  return {
    connect: (extensionInstanceId, family = "chrome") => {
      connected = { extensionInstanceId, family };
      revision += 1;
      publish();
    },
    disconnect: () => {
      connected = null;
      revision += 1;
      publish();
    },
    focusPresentation: async (input) => {
      focused.push(input);
    },
    focused,
    refresh: async () => snapshot(),
    snapshot,
    start: async () => snapshot(),
    stop() {
      this.stopped = true;
    },
    stopped: false,
    subscribed,
    subscribe(listener) {
      listeners.add(listener);
      resolveSubscribed();
      return () => listeners.delete(listener);
    },
  };
}

function makePorts(
  registry: ChromeControlExtensionRegistryPort,
  overrides: Partial<ChromeControlRuntimePorts> = {},
): ChromeControlRuntimePorts {
  return {
    browserIconPaths: new Map([["chrome", "/runtime/chrome/assets/google-chrome.png"]]),
    bundleSupported: true,
    registrationKind: "production",
    installNativeHost: async () => installResult,
    makeRegistry: () => registry,
    requested: true,
    runtimeUnavailableReason: null,
    ...overrides,
  };
}

it.effect("publishes exact Chrome instance readiness and disconnection changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = makeRegistry();
      let installedPeerIdentity: typeof peerIdentity | null = null;
      const runtime = yield* makeChromeControlRuntime(
        makePorts(registry, {
          makeRegistry: (identity) => {
            installedPeerIdentity = identity;
            return registry;
          },
        }),
      );

      expect(installedPeerIdentity).toEqual(peerIdentity);
      expect(runtime.available()).toBe(false);
      expect(runtime.snapshot()).toMatchObject({
        bundleSupported: true,
        nativeHostInstalled: true,
        providerReady: false,
        requested: true,
        status: "extension-disconnected",
      });
      expect(runtime.resolveBrowserIconPath("chrome")).toBe(
        "/runtime/chrome/assets/google-chrome.png",
      );
      expect(runtime.resolveBrowserIconPath("edge")).toBeNull();

      const changesFiber = yield* runtime.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.promise(() => registry.subscribed);

      registry.connect("profile-a");
      expect(runtime.available()).toBe(true);
      expect(runtime.isConnectedInstance("chrome", "profile-a")).toBe(true);
      expect(runtime.isConnectedInstance("edge", "profile-a")).toBe(false);
      expect(runtime.isConnectedInstance("chrome", "profile-b")).toBe(false);
      yield* runtime.focusPresentation({
        extensionInstanceId: "profile-a",
        sessionId: "thread-1",
        tabId: "7",
      });
      registry.disconnect();

      const changes = yield* Fiber.join(changesFiber);
      expect(changes).toEqual([
        {
          connectedInstances: [{ extensionId, extensionInstanceId: "profile-a", family: "chrome" }],
          disconnectedInstances: [],
          snapshot: expect.objectContaining({ providerReady: true, revision: 1, status: "ready" }),
        },
        {
          connectedInstances: [],
          disconnectedInstances: [
            { extensionId, extensionInstanceId: "profile-a", family: "chrome" },
          ],
          snapshot: expect.objectContaining({
            providerReady: false,
            revision: 2,
            status: "extension-disconnected",
          }),
        },
      ]);
      expect(runtime.isConnectedInstance("chrome", "profile-a")).toBe(false);
      expect(registry.focused).toEqual([
        { extensionInstanceId: "profile-a", sessionId: "thread-1", tabId: "7" },
      ]);
    }),
  ),
);

it.effect("does not construct a provider when native-host installation fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = makeRegistry();
      let registryCreations = 0;
      const runtime = yield* makeChromeControlRuntime(
        makePorts(registry, {
          installNativeHost: async () => {
            throw new Error("wrong signing team");
          },
          makeRegistry: () => {
            registryCreations += 1;
            return registry;
          },
        }),
      );

      expect(registryCreations).toBe(0);
      expect(runtime.snapshot()).toMatchObject({
        nativeHostInstalled: false,
        providerReady: false,
        reason: "wrong signing team",
        requested: true,
        status: "faulted",
      });
      expect(
        yield* Effect.exit(
          runtime.focusPresentation({
            extensionInstanceId: "profile-a",
            sessionId: "thread-1",
            tabId: "7",
          }),
        ),
      ).toMatchObject({ _tag: "Failure" });
    }),
  ),
);

it.effect("reports an unavailable, unrequested bundle without touching installation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = makeRegistry();
      let installs = 0;
      let registryCreations = 0;
      const runtime = yield* makeChromeControlRuntime(
        makePorts(registry, {
          bundleSupported: false,
          installNativeHost: async () => {
            installs += 1;
            return installResult;
          },
          makeRegistry: () => {
            registryCreations += 1;
            return registry;
          },
          requested: false,
          runtimeUnavailableReason: "not-bundled",
        }),
      );

      expect(installs).toBe(0);
      expect(registryCreations).toBe(0);
      expect(runtime.snapshot()).toMatchObject({
        bundleSupported: false,
        reason: "not-bundled",
        requested: false,
        status: "runtime-unavailable",
      });
    }),
  ),
);

it.live("leaves the user home untouched when a development instance has no registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-chrome-disabled-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const originalHome = process.env.HOME;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.HOME = home;
        }),
        () =>
          Effect.sync(() => {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
          }),
      );
      const registration = resolveChromeHostRegistration({
        isPackaged: false,
        isolatedRunId: "dev",
        homeDirectory: homedir(),
        nodexHome: path.join(home, "profile"),
        personalNodexHome: path.join(home, ".nodex"),
        launchMode: undefined,
        hasScenarioHome: false,
      });
      const installNativeHost = vi.fn(async () => {
        await writeFile(path.join(home, "unexpected-registration"), "");
        return installResult;
      });
      const runtime = yield* makeChromeControlRuntime(
        makePorts(makeRegistry(), {
          installNativeHost,
          registrationKind: registration.kind,
        }),
      );
      expect(runtime.snapshot()).toMatchObject({
        status: "registration-disabled",
        nativeHostInstalled: false,
        providerReady: false,
        reason: expect.stringContaining("--register-browser-host"),
      });
      expect(installNativeHost).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
    }),
  ),
);

it.effect("identifies a temporary registration in Settings and gives it back on close", () =>
  Effect.gen(function* () {
    const releaseRegistration = vi.fn(async () => undefined);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeChromeControlRuntime(
          makePorts(makeRegistry(), {
            installNativeHost: async () => ({ ...installResult, releaseRegistration }),
            registrationKind: "development",
          }),
        );
        expect(runtime.snapshot()).toMatchObject({
          status: "extension-disconnected",
          nativeHostInstalled: true,
          reason: "Registered for this development instance.",
        });
      }),
    );
    expect(releaseRegistration).toHaveBeenCalledOnce();
  }),
);

it.effect("reports an existing registration owner without claiming the provider is ready", () =>
  Effect.gen(function* () {
    const runtime = yield* makeChromeControlRuntime(
      makePorts(makeRegistry(), {
        installNativeHost: async () => {
          throw new ChromeHostRegistrationInUse();
        },
      }),
    );
    expect(runtime.snapshot()).toMatchObject({
      status: "registration-in-use",
      nativeHostInstalled: false,
      providerReady: false,
    });
  }),
);
