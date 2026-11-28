import { pinnedTarExecutable } from "../platform/node/pinned-tar-archive";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
// @effect-diagnostics strictEffectProvide:off
import { it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import type { AppComponentInstallation, AppComponentState } from "../../shared/app-components";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  HostShellEnvironment,
  inheritedHostShellEnvironment,
} from "../host-runtime/HostShellEnvironment";
import {
  ApplicationSettings,
  make as makeApplicationSettings,
} from "../settings/ApplicationSettings";
import { AppComponentActivation } from "./AppComponentActivation";
import { writeClaudeCodeFixture } from "./claude-code-fixture";
import { appComponentCatalog } from "./AppComponentCatalog";
import type { ComponentFetch } from "./AppComponentDownload";
import {
  appComponentRoot,
  hasAppComponentTombstone,
  hasAppComponentWanted,
  installAppComponent,
} from "./AppComponentStore";
import { AppComponentFetch, make } from "./AppComponents";

vi.mock("./AppComponentCatalog", { spy: true });

const id = "desktop-tools";
const expectStatus = (state: AppComponentState, status: AppComponentInstallation["status"]) =>
  expect(state.installation.status).toBe(status);

const fixture = Effect.fnUntraced(function* (options: {
  readonly fetch: (bytes: Buffer) => ComponentFetch;
  readonly reject?: boolean | "first";
  /** Publish the component before the service starts, as an earlier run would have. */
  readonly preinstalled?: boolean;
  readonly packaged?: boolean;
  readonly home?: string;
  readonly onDemand?: boolean;
  readonly isolatedCodexShell?: HostShellEnvironment["Service"];
  readonly contents?: string;
  readonly windows?: boolean;
}) {
  const home =
    options.home ??
    (yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-components-"))),
      (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
    ));
  const environment: Record<string, string> =
    options.windows && process.platform === "win32"
      ? { NODEX_CORE_EXECUTABLE: requiredNativeExecutable("core-server") }
      : {};
  const target = {
    platform: options.windows ? "win32" : "darwin",
    arch: options.windows && process.arch === "x64" ? "x64" : "arm64",
    isPackaged: options.packaged !== false,
    environment,
  };
  const source = path.join(home, "archive-source");
  const payload = writeClaudeCodeFixture(
    source,
    options.contents ?? "component fixture",
    options.windows,
  );
  const archivePath = path.join(home, "fixture.tar.gz");
  execFileSync(pinnedTarExecutable(), ["-czf", archivePath, "-C", source, "."]);
  const bytes = readFileSync(archivePath);
  const definition = {
    id: options.isolatedCodexShell ? "codex" : options.onDemand ? "claude-code" : id,
    install: options.onDemand || options.isolatedCodexShell ? "on-first-use" : "at-startup",
    payload,
    archive: {
      assetName: "fixture.tar.gz",
      url: "https://example.test/component",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    unpackedBytes: 1024,
  } as const;
  const settings = yield* makeApplicationSettings({
    environment: {},
    hostHomeDirectory: home,
    settingsPath: path.join(home, "config.toml"),
  });
  let active = false;
  const activate = vi.fn(() =>
    Effect.sync(() => {
      if (
        options.reject === true ||
        (options.reject === "first" && activate.mock.calls.length === 1)
      )
        return { status: "rejected", message: "Unsupported component" } as const;
      active = true;
      return { status: "active" } as const;
    }),
  );
  const fetch = vi.fn(options.fetch(bytes));
  if (options.preinstalled)
    yield* Effect.promise(() =>
      installAppComponent({
        home,
        target,
        definition,
        fetch: () => Promise.resolve(new Response(new Uint8Array(bytes))),
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onInstalling: () => undefined,
      }),
    );
  if (options.packaged !== false) vi.mocked(appComponentCatalog).mockReturnValueOnce([definition]);
  const owner = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        mainConfigLayer({
          ...target,
          nodexHome: home,
          homeDirectory: home,
          isolatedRunId: options.isolatedCodexShell ? "isolated-run" : null,
        }),
        Layer.succeed(ApplicationSettings, settings),
        Layer.succeed(AppComponentFetch, { fetch }),
        Layer.succeed(AppComponentActivation, {
          activate,
          isActive: () => Effect.sync(() => active),
        }),
        ...(options.isolatedCodexShell
          ? [Layer.succeed(HostShellEnvironment, options.isolatedCodexShell)]
          : []),
      ),
    ),
  );
  const seen: AppComponentInstallation["status"][] = [];
  yield* owner.changes.pipe(
    Stream.runForEach((snapshot) =>
      Effect.sync(() => {
        const state = snapshot.components[0];
        if (state && seen.at(-1) !== state.installation.status)
          seen.push(state.installation.status);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const watch = (status: AppComponentInstallation["status"]) =>
    owner.changes.pipe(
      Stream.filterMap((snapshot) => {
        const component = snapshot.components[0];
        return component?.installation.status === status
          ? Result.succeed(component)
          : Result.failVoid;
      }),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    owner,
    settings,
    watch,
    fetch,
    activate,
    home,
    seen,
    root: appComponentRoot(home, definition),
    definition,
  };
});

it.effect("installs Codex in a packaged isolated run without using the host login shell", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let usedLoginShell = false;
      const harness = yield* fixture({
        isolatedCodexShell: {
          ...inheritedHostShellEnvironment({ PATH: "/host-only/bin" }),
          load: Effect.sync(() => {
            usedLoginShell = true;
            return { PATH: "/host-only/bin" };
          }),
        },
        fetch: (bytes) => () => Promise.resolve(new Response(new Uint8Array(bytes))),
      });
      yield* harness.watch("on-demand");
      expect(yield* harness.owner.ensure("codex")).toEqual({
        status: "installed",
        root: harness.root,
      });
      expect(usedLoginShell).toBe(false);
    }),
  ),
);

it.effect("retries a network failure on the test clock and activates a completed install", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let failures = 0;
      const harness = yield* fixture({
        onDemand: true,
        fetch: (bytes) => () =>
          Promise.resolve(
            failures++ === 0
              ? new Response(null, { status: 503 })
              : new Response(new Uint8Array(bytes)),
          ),
      });
      yield* harness.watch("on-demand");
      const waiting = yield* harness.owner.ensure("claude-code").pipe(Effect.forkScoped);
      const failed = yield* harness.watch("failed");
      expect(failed.installation).toMatchObject({ reason: "network" });
      if (failed.installation.status !== "failed" || failed.installation.retryAt === null) {
        throw new Error("Expected a scheduled retry");
      }
      const retryAt = failed.installation.retryAt;
      expect(retryAt).toBeGreaterThanOrEqual(1500);
      expect(retryAt).toBeLessThanOrEqual(2000);
      yield* TestClock.adjust(retryAt - 1);
      expect(harness.fetch).toHaveBeenCalledOnce();
      yield* TestClock.adjust(1);
      const installed = yield* harness.watch("installed");
      expectStatus(installed, "installed");
      expect(yield* Fiber.join(waiting)).toEqual({ status: "installed", root: harness.root });
      expect(harness.seen).toEqual([
        "on-demand",
        "queued",
        "downloading",
        "failed",
        "queued",
        "downloading",
        "installing",
        "installed",
      ]);
      expect(harness.activate).toHaveBeenCalledExactlyOnceWith("claude-code");
    }),
  ),
);

it.effect("cancels an in-flight download and persists the disabled preference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let requested: (() => void) | undefined;
      const started = Effect.callback<void>((resume) => {
        requested = () => resume(Effect.void);
      });
      const pending = yield* started.pipe(Effect.forkScoped({ startImmediately: true }));
      let aborted = false;
      const harness = yield* fixture({
        fetch:
          () =>
          (_url, { signal }) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
              requested?.();
            }),
      });
      yield* Fiber.join(pending);
      const snapshot = yield* harness.owner.setEnabled({ id, enabled: false });
      expect(snapshot.components[0]).toMatchObject({
        enabled: false,
        installation: { status: "not-installed" },
        removalPending: false,
      });
      expect(aborted).toBe(true);
      expect(harness.activate).not.toHaveBeenCalled();
      expect((yield* harness.settings.snapshot()).disabledAppComponents).toEqual([id]);
      expect(yield* Effect.promise(() => hasAppComponentTombstone(harness.home, id))).toBe(true);
    }),
  ),
);

it.effect("discards rejected files and allows an immediate manual retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* fixture({
        fetch: (bytes) => () => Promise.resolve(new Response(new Uint8Array(bytes))),
        reject: true,
      });
      const rejected = yield* harness.watch("failed");
      expect(rejected.installation).toMatchObject({ reason: "rejected", retryAt: null });
      expect(() => readFileSync(path.join(harness.root, "package/claude"))).toThrow(/ENOENT/u);
      const retry = yield* harness.owner.retry(id);
      expect(retry.components[0]?.installation.status).toBe("queued");
      yield* harness.watch("failed");
      expect(harness.fetch).toHaveBeenCalledTimes(2);
    }),
  ),
);

it.effect("replaces installed files this build refuses with a clean download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* fixture({
        fetch: (bytes) => () => Promise.resolve(new Response(new Uint8Array(bytes))),
        preinstalled: true,
        reject: "first",
      });
      yield* harness.watch("installed");
      expect(harness.activate).toHaveBeenCalledTimes(2);
      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(readFileSync(path.join(harness.root, "package/claude"), "utf8")).toBe(
        "component fixture",
      );
    }),
  ),
);

it.effect("keeps active files pending restart and clears removal if turned back on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* fixture({
        fetch: (bytes) => () => Promise.resolve(new Response(new Uint8Array(bytes))),
      });
      const active = yield* harness.watch("installed");
      const pending = yield* harness.owner.setEnabled({ id, enabled: false });
      expect(pending.components[0]).toMatchObject({
        enabled: false,
        removalPending: true,
        installation: active.installation,
      });
      expect(readFileSync(path.join(harness.root, "package/claude"), "utf8")).toBe(
        "component fixture",
      );
      expect(yield* Effect.promise(() => hasAppComponentTombstone(harness.home, id))).toBe(true);
      const enabled = yield* harness.owner.setEnabled({ id, enabled: true });
      expect(enabled.components[0]).toMatchObject({
        enabled: true,
        removalPending: false,
        installation: active.installation,
      });
      expect(yield* Effect.promise(() => hasAppComponentTombstone(harness.home, id))).toBe(false);
      expect((yield* harness.settings.snapshot()).disabledAppComponents).toEqual([]);
      expect(harness.fetch).toHaveBeenCalledOnce();
    }),
  ),
);

it.effect("retries integrity once from a clean download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ranges: (string | null)[] = [];
      const harness = yield* fixture({
        fetch: (bytes) => (_url, init) => {
          ranges.push(new Headers(init.headers).get("range"));
          return Promise.resolve(new Response(new Uint8Array(bytes.length)));
        },
      });
      const failed = harness.owner.changes.pipe(
        Stream.filter((snapshot) => {
          const state = snapshot.components[0]?.installation;
          return (
            state?.status === "failed" && state.reason === "integrity" && state.retryAt === null
          );
        }),
        Stream.runHead,
      );
      yield* failed;
      yield* TestClock.adjust("10 minutes");
      expect(ranges).toEqual([null, null]);
      expect(harness.activate).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("does no component work for development installations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* fixture({
        fetch: () => () => Promise.reject(new Error("Unexpected download")),
        packaged: false,
      });
      expect(yield* harness.owner.read).toEqual({ revision: 0, components: [] });
      expect(yield* harness.owner.setEnabled({ id, enabled: false })).toEqual({
        revision: 0,
        components: [],
      });
      expect(harness.fetch).not.toHaveBeenCalled();
    }),
  ),
);

const claude = "claude-code";
const respond = (bytes: Buffer) => () => Promise.resolve(new Response(new Uint8Array(bytes)));

it.effect.each(["darwin", "win32"])(
  "first use on %s starts one install and resolves every waiter after activation",
  (platform) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          onDemand: true,
          windows: platform === "win32",
          fetch: respond,
        });
        yield* harness.watch("on-demand");
        expect(harness.fetch).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => hasAppComponentWanted(harness.home, claude))).toBe(
          false,
        );
        const installed = yield* Effect.all(
          [harness.owner.ensure(claude), harness.owner.ensure(claude)],
          { concurrency: 2 },
        );
        expect(installed).toEqual([
          { status: "installed", root: harness.root },
          { status: "installed", root: harness.root },
        ]);
        expect(harness.fetch).toHaveBeenCalledOnce();
        expect(harness.activate).toHaveBeenCalledExactlyOnceWith(claude);
        yield* harness.owner.setEnabled({ id: claude, enabled: false });
        expect(yield* harness.owner.ensure(claude)).toMatchObject({
          status: "unavailable",
          reason: "turned-off",
        });
        expect(yield* Effect.promise(() => hasAppComponentWanted(harness.home, claude))).toBe(
          false,
        );
      }),
    ),
);

it.effect("a wanted component installs its next pin in the background", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-component-pin-"))),
        (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const previous = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* fixture({ home, onDemand: true, fetch: respond });
          yield* first.owner.request(claude);
          yield* first.watch("installed");
          return first.root;
        }),
      );
      const next = yield* fixture({ home, onDemand: true, contents: "second pin", fetch: respond });
      expect(next.root).not.toBe(previous);
      yield* next.watch("installed");
      expect(next.fetch).toHaveBeenCalledOnce();
      expect(readFileSync(path.join(next.root, "package/claude"), "utf8")).toBe("second pin");
    }),
  ),
);
