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
import { vi } from "vitest";
import type { ProviderKeyResult, ProviderKeySettings } from "../../../shared/provider-keys";
import { AgentRuntimeProviderConfiguration } from "../../agent-runtime/AgentRuntimeProviderConfiguration";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { providerKeyModelDiscovery } from "../../platform/node/ProviderKeyModelDiscovery";
import { ApplicationSettings, make as makeSettings } from "../../settings/ApplicationSettings";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { make } from "./ProviderKeysIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

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

        const target = { preset: "custom", baseUrl: "https://gateway.example/" };
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
          assert.isTrue(Exit.isFailure(yield* Effect.exit(handler(event(undefined, true), input))));
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
