import { describe, vi } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ProviderKeyResult, ProviderKeySettings } from "../../../shared/provider-keys";
import { AgentRuntimeProviderConfiguration } from "../../agent-runtime/AgentRuntimeProviderConfiguration";
import { testLayer as mainConfigLayer, testLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { providerKeyModelDiscovery } from "../../platform/node/ProviderKeyModelDiscovery";
import { ApplicationSettings, make as makeSettings } from "../../settings/ApplicationSettings";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { make } from "./ProviderKeysIpc";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ProviderKeyUsageSnapshot } from "../../../shared/provider-key-usage";
import { ProviderKeyUsage } from "../../provider-keys/ProviderKeyUsage";
import { live } from "./ProviderKeyUsageIpc";
import { EventEmitter } from "node:events";
import type { SubscriptionUsageSnapshot } from "../../../shared/agent-runtime-api";
import { AgentRuntimeSubscriptionUsage } from "../../agent-runtime/AgentRuntimeSubscriptionUsage";
import { live as liveSubscriptionUsageIpc } from "./SubscriptionUsageIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

describe("ProviderKeysIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>;

  function event(url = "app://-/index.html", subframe = false) {
    const frame = { url };
    return {
      sender: { getType: () => "window", mainFrame: frame },
      senderFrame: subframe ? { ...frame } : frame,
    } as unknown as IpcMainInvokeEvent;
  }

  it.effect(
    "validates trusted commands and keeps key replacement, runtime refresh and window updates consistent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-provider-keys-"))),
            (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
          );
          const settingsPath = join(root, "config.toml");
          const secretDir = join(root, "agent-secrets", "provider-keys");
          const vault = new Map<string, string>();
          let locked = false;
          const settings = yield* makeSettings({
            settingsPath,
            hostHomeDirectory: root,
            environment: {},
            secretEncryption: {
              isAvailable: () => !locked,
              encryptString: (plaintext) => {
                const ref = randomUUID();
                vault.set(ref, plaintext);
                return Buffer.from(ref);
              },
              decryptString: (ciphertext) => vault.get(ciphertext.toString())!,
            },
          });
          const request = vi.fn<typeof fetch>();
          const handlers = new Map<string, Handler>();
          const calls: unknown[] = [];
          const windows = [1, 2].map((id) => ({
            id,
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send: (...args: unknown[]) => {
                calls.push([id, ...args]);
              },
            },
          }));
          const ipc = makeTestElectronIpc({
            handle: (channel: string, handler: Handler) =>
              Effect.acquireRelease(
                Effect.sync(() => handlers.set(channel, handler)),
                () => Effect.sync(() => handlers.delete(channel)),
              ).pipe(Effect.asVoid),
            on: () => Effect.void,
          });
          yield* Layer.build(
            make(providerKeyModelDiscovery(request)).pipe(
              Layer.provide(
                Layer.mergeAll(
                  mainConfigLayer(),
                  Layer.succeed(ElectronIpc, ipc),
                  Layer.succeed(ApplicationSettings, settings),
                  Layer.succeed(AgentRuntimeProviderConfiguration, {
                    refresh: Effect.sync(() => {
                      calls.push("refresh");
                      return { applied: true, deferredInstanceIds: [] };
                    }),
                  }),
                  Layer.succeed(WindowRuntime, {
                    all: () => windows,
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
          );

          const invoke = <A>(operation: string, ...args: unknown[]) =>
            handlers.get(`provider-keys:${operation}`)!(event(), ...args) as Effect.Effect<
              A,
              unknown
            >;

          const target = {
            preset: "custom",
            baseUrl: "https://gateway.example/",
            agent: "claudeAgent",
          };
          const original = "test-key-original";
          const replacement = "test-key-replaced";
          for (const [operation, input] of [
            ["connect", { target, apiKey: original }],
            ["read", undefined],
            ["update", { id: "absent" }],
            ["refresh-models", { id: "absent" }],
            ["remove", { id: "absent" }],
          ] as const) {
            const handler = handlers.get(`provider-keys:${operation}`)!;
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(handler(event("https://other.example"), input))),
            );
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(handler(event(undefined, true), input))),
            );
            if (operation !== "read") {
              assert.isTrue(
                Exit.isFailure(yield* Effect.exit(handler(event(), { apiKey: original }))),
              );
            }
          }
          assert.deepEqual(yield* invoke("read"), { connections: [] });
          assert.strictEqual(request.mock.calls.length, 0);
          assert.deepEqual(calls, []);

          const models = [{ id: "model-1", name: "First model" }];
          request.mockResolvedValueOnce(Response.json({ data: models }));
          const added = yield* invoke<ProviderKeyResult>("connect", { target, apiKey: original });
          if (!added.ok) return assert.fail(added.message);
          const id = added.connectionId;
          assert.match(id, /^[a-z0-9-]{1,64}$/u);
          assert.deepEqual(added.settings.connections, [
            {
              id,
              preset: "custom",
              agent: "claudeAgent",
              endpoint: null,
              baseUrl: "https://gateway.example",
              displayName: "gateway.example",
              enabled: true,
              models,
              keyHint: "inal",
            },
          ]);
          assert.deepEqual(calls.splice(0), [
            "refresh",
            [1, "provider-keys:changed", added.settings],
            [2, "provider-keys:changed", added.settings],
          ]);
          const firstRef = readdirSync(secretDir)[0]!;
          assert.notInclude(readFileSync(settingsPath, "utf8"), original);
          assert.notInclude(readFileSync(join(secretDir, firstRef), "utf8"), original);
          const snapshot = yield* settings.snapshot();
          assert.deepEqual(snapshot.providerKeys, added.settings);
          assert.notInclude(JSON.stringify(snapshot), firstRef);
          assert.deepEqual(yield* invoke("read"), added.settings);
          assert.strictEqual(request.mock.calls.length, 1);
          assert.strictEqual(Redacted.value(yield* settings.providerKeySecret(id)), original);

          request.mockResolvedValueOnce(Response.json({ code: 401 }));
          assert.include(yield* invoke<ProviderKeyResult>("update", { id, apiKey: replacement }), {
            ok: false,
            reason: "rejected",
          });
          assert.strictEqual(Redacted.value(yield* settings.providerKeySecret(id)), original);
          assert.deepEqual(calls, []);

          locked = true;
          assert.include(yield* invoke<ProviderKeyResult>("refresh-models", { id }), {
            ok: false,
            reason: "storage",
          });
          request.mockResolvedValueOnce(Response.json({ data: models }));
          assert.include(yield* invoke<ProviderKeyResult>("update", { id, apiKey: replacement }), {
            ok: false,
            reason: "storage",
          });
          assert.deepEqual(readdirSync(secretDir), [firstRef]);
          assert.deepEqual(calls, []);
          locked = false;

          request.mockResolvedValueOnce(Response.json({ data: models }));
          const replaced = yield* invoke<ProviderKeyResult>("update", {
            id,
            apiKey: replacement,
            displayName: "Gateway",
          });
          assert.isTrue(replaced.ok);
          assert.strictEqual(Redacted.value(yield* settings.providerKeySecret(id)), replacement);
          assert.lengthOf(readdirSync(secretDir), 1);
          assert.notInclude(readdirSync(secretDir), firstRef);
          assert.notInclude(readFileSync(settingsPath, "utf8"), replacement);

          request.mockResolvedValueOnce(Response.json({ data: [{ id: "model-2" }] }));
          const refreshed = yield* invoke<ProviderKeyResult>("refresh-models", { id });
          assert.isTrue(refreshed.ok);
          assert.deepEqual((yield* invoke<ProviderKeySettings>("read")).connections[0]?.models, [
            { id: "model-2", name: "Model 2" },
          ]);
          assert.strictEqual(
            new Headers(request.mock.calls.at(-1)?.[1]?.headers).get("x-api-key"),
            replacement,
          );

          const disabled = yield* invoke<ProviderKeyResult>("update", { id, enabled: false });
          if (!disabled.ok) return assert.fail(disabled.message);
          assert.isFalse(disabled.settings.connections[0]!.enabled);
          assert.strictEqual(Redacted.value(yield* settings.providerKeySecret(id)), replacement);
          assert.strictEqual(request.mock.calls.length, 5);

          assert.deepEqual(yield* invoke("remove", { id }), { connections: [] });
          assert.deepEqual(readdirSync(secretDir), []);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(settings.providerKeySecret(id))));
          assert.strictEqual(calls.filter((call) => call === "refresh").length, 4);
        }),
      ),
  );
});

describe("ProviderKeyUsageIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    connectionId?: unknown,
  ) => Effect.Effect<unknown, unknown>;

  const personal = "app://-/index.html";
  const hosted = "app://-/index.html?spaceId=team";
  const event = (url = personal, id = 1, subframe = false) => {
    const frame = { url };
    return {
      sender: { id, mainFrame: frame, getType: () => "window" },
      senderFrame: subframe ? { ...frame } : frame,
    } as unknown as IpcMainInvokeEvent;
  };

  it.effect("only personal windows can read, refresh or receive API key usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const refreshed: (string | undefined)[] = [];
        const sent: [number, string, unknown][] = [];
        const snapshot = yield* SubscriptionRef.make<ProviderKeyUsageSnapshot>({ connections: [] });
        const read = SubscriptionRef.get(snapshot);
        const window = (id: number, url: string) => ({
          isDestroyed: () => false,
          webContents: {
            getURL: () => url,
            isDestroyed: () => false,
            send: (channel: string, payload: unknown) => sent.push([id, channel, payload]),
          },
        });

        yield* Layer.build(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                testLayer(),
                Layer.succeed(ProviderKeyUsage, {
                  read,
                  changes: SubscriptionRef.changes(snapshot),
                  refresh: (id) => Effect.sync(() => refreshed.push(id)).pipe(Effect.andThen(read)),
                }),
                Layer.succeed(
                  ElectronIpc,
                  makeTestElectronIpc({
                    handle: (channel: string, handler: Handler) =>
                      Effect.sync(() => {
                        handlers.set(channel, handler);
                      }),
                    on: () => Effect.void,
                  }),
                ),
                Layer.succeed(WindowRuntime, {
                  has: (id: number) => id <= 3,
                  all: () => [window(1, personal), window(2, personal), window(3, hosted)],
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        );

        const readHandler = handlers.get("provider-keys:usage:read")!;
        const refreshHandler = handlers.get("provider-keys:usage:refresh")!;
        const update: ProviderKeyUsageSnapshot = {
          connections: [
            { connectionId: "deep", observedAt: 0, readFailed: false, balance: null, windows: [] },
          ],
        };
        yield* SubscriptionRef.set(snapshot, update);
        yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });
        assert.deepEqual(
          sent.filter(([, , payload]) => payload === update),
          [
            [1, "provider-keys:usage-changed", update],
            [2, "provider-keys:usage-changed", update],
          ],
        );

        for (const sender of [
          event(hosted, 3),
          event("https://untrusted.example"),
          event(personal, 1, true),
          event(personal, 4),
        ]) {
          assert.equal((yield* Effect.result(readHandler(sender)))._tag, "Failure");
          assert.equal((yield* Effect.result(refreshHandler(sender)))._tag, "Failure");
        }
        assert.equal(
          (yield* Effect.result(refreshHandler(event(), { id: "deep" })))._tag,
          "Failure",
        );
        assert.deepEqual(refreshed, []);
        assert.deepEqual(yield* readHandler(event()), update);
        assert.deepEqual(yield* refreshHandler(event(), "deep"), update);
        assert.deepEqual(yield* refreshHandler(event()), update);
        assert.deepEqual(refreshed, ["deep", undefined]);
      }),
    ),
  );
});

describe("SubscriptionUsageIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Effect.Effect<unknown, unknown>;

  const signedOut: SubscriptionUsageSnapshot = { status: "ready", providers: [], reason: null };

  const setup = Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const snapshot = yield* SubscriptionRef.make<SubscriptionUsageSnapshot>({
      status: "loading",
      providers: null,
      reason: null,
    });
    const logouts: (readonly string[])[] = [];
    const delivered = new Map<number, unknown[]>();
    const window = (id: number, url = "app://-/index.html") => ({
      isDestroyed: () => false,
      webContents: {
        id,
        getURL: () => url,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          if (channel === "agent-runtime:subscription-usage-changed")
            delivered.set(id, [...(delivered.get(id) ?? []), payload]);
        },
      },
    });
    yield* Layer.build(
      liveSubscriptionUsageIpc.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentRuntimeSubscriptionUsage, {
              snapshot,
              refresh: SubscriptionRef.get(snapshot),
              reread: Effect.void,
              logoutClaude: (instanceIds) =>
                Effect.sync(() => logouts.push(instanceIds)).pipe(Effect.as(signedOut)),
            }),
            Layer.succeed(
              ElectronIpc,
              makeTestElectronIpc({
                handle: (channel, handler) =>
                  Effect.sync(() => {
                    handlers.set(channel, handler as Handler);
                  }),
                on: () => Effect.void,
              }),
            ),
            Layer.succeed(WindowRuntime, {
              has: (id: number) => id === 1 || id === 2 || id === 3,
              all: () => [window(1), window(2), window(3, "app://-/index.html?spaceId=team")],
            } as never),
            testLayer(),
          ),
        ),
      ),
    );
    const frame = { url: "app://-/index.html" };
    const sender = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: frame,
      getType: () => "window",
      isDestroyed: () => false,
    });
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
      discard: true,
    });
    return { handlers, snapshot, logouts, delivered, event, settle };
  });

  it.effect("every personal window hears each change to this desktop's Claude usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        yield* fixture.settle;
        const read: SubscriptionUsageSnapshot = {
          status: "unavailable",
          providers: null,
          reason: "Agent execution could not start",
        };
        yield* SubscriptionRef.set(fixture.snapshot, read);
        yield* fixture.settle;
        assert.deepEqual(fixture.delivered.get(1)?.at(-1), read);
        assert.deepEqual(fixture.delivered.get(2)?.at(-1), read);
        // A team window's Agents run on its Space host; this desktop's accounts are not its own.
        assert.isUndefined(fixture.delivered.get(3));
        assert.deepEqual(
          yield* fixture.handlers.get("agent-runtime:subscription-usage:read")!(fixture.event),
          read,
        );
      }),
    ),
  );

  it.effect("signs out only well-formed Claude Agents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        const logout = fixture.handlers.get("agent-runtime:subscription-usage:logout-claude")!;
        assert.deepEqual(yield* logout(fixture.event, { instanceIds: ["claude_a"] }), signedOut);
        const rejected = yield* logout(fixture.event, { instanceIds: [] }).pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        assert.deepEqual(fixture.logouts, [["claude_a"]]);
      }),
    ),
  );
});
