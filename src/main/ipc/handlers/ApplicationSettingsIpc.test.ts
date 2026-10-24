import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { AgentRuntimeProviderConfiguration } from "../../agent-runtime/AgentRuntimeProviderConfiguration";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { StoreAdministrationSchedulerRuntime } from "../../host-runtime/StoreAdministrationSchedulerRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import {
  ApplicationSettings,
  make as makeApplicationSettings,
} from "../../settings/ApplicationSettings";
import { DesktopNotificationRuntime } from "../../host-runtime/DesktopNotificationRuntime";
import { ApplicationSettingsIpcError, live } from "./ApplicationSettingsIpc";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import {
  AgentRuntimeProviderConfigurationError,
  type ProviderConfigurationResult,
} from "../../agent-runtime/AgentRuntimeProviderConfiguration";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, ApplicationSettingsIpcError>;

it.effect("owns the complete application settings ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    let providerRefreshes = 0;
    let providerResult: ProviderConfigurationResult = { applied: true, deferredInstanceIds: [] };
    let providerFailure = false;
    const settingsRoot = mkdtempSync(path.join(tmpdir(), "nodex-application-settings-ipc-"));
    const settingsPath = path.join(settingsRoot, "config.toml");
    const settings = yield* makeApplicationSettings({
      environment: {},
      hostHomeDirectory: settingsRoot,
      settingsPath,
    });
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const menus = ApplicationMenuRuntime.of({
      refresh: () => undefined,
      bindHistory: () => Effect.succeed(1),
      publishHistory: () => Effect.void,
    });
    let keymapAdmissionsInFlight = 0;
    let peakKeymapAdmissions = 0;
    const dictation = DictationRuntime.of({
      syncCommandKeymap: () =>
        Effect.gen(function* () {
          keymapAdmissionsInFlight += 1;
          peakKeymapAdmissions = Math.max(peakKeymapAdmissions, keymapAdmissionsInFlight);
          yield* Effect.yieldNow;
          keymapAdmissionsInFlight -= 1;
          return null;
        }),
      restoreCommandKeymap: () => Effect.void,
    } as unknown as DictationRuntime["Service"]);
    const schedulers = StoreAdministrationSchedulerRuntime.of({
      configureBackup: () => Effect.void,
    } as unknown as StoreAdministrationSchedulerRuntime["Service"]);
    const broadcasts: Array<{ channel: string; value: unknown }> = [];
    const windows = WindowRuntime.of({
      all: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (channel: string, value: unknown) => broadcasts.push({ channel, value }),
          },
        },
      ],
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationMenuRuntime, menus),
            Layer.succeed(ApplicationSettings, settings),
            Layer.succeed(AgentRuntimeProviderConfiguration, {
              refresh: Effect.suspend(() => {
                providerRefreshes += 1;
                return providerFailure
                  ? Effect.fail(new AgentRuntimeProviderConfigurationError({ cause: "offline" }))
                  : Effect.succeed(providerResult);
              }),
            }),
            Layer.succeed(DictationRuntime, dictation),
            Layer.succeed(DesktopNotificationRuntime, {
              authorization: {
                read: Effect.succeed("authorized"),
                request: Effect.succeed("authorized"),
              },
            } as unknown as DesktopNotificationRuntime["Service"]),
            Layer.succeed(StoreAdministrationSchedulerRuntime, schedulers),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer({
              homeDirectory: settingsRoot,
              nodexHome: settingsRoot,
              profileSettingsPath: settingsPath,
            }),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual([...handlers.keys()].sort(), [
      "codex-command-keymap-state",
      "reset-codex-command-keybindings",
      "set-codex-command-keybinding",
      "settings:acp-agents:configuration-status",
      "settings:acp-agents:get",
      "settings:acp-agents:update",
      "settings:backup:get",
      "settings:backup:update",
      "settings:claude-agents:get",
      "settings:claude-agents:update",
      "settings:codex-developer:get",
      "settings:codex-developer:update",
      "settings:codex-home:get",
      "settings:codex-home:update",
      "settings:composer-predictions:get",
      "settings:composer-predictions:update",
      "settings:diagnostics:get",
      "settings:diagnostics:update",
      "settings:git:get",
      "settings:git:update",
      "settings:history:get",
      "settings:history:update",
      "settings:inbox:get",
      "settings:inbox:update",
      "settings:notification-authorization:open-settings",
      "settings:notification-authorization:read",
      "settings:notification-authorization:request",
      "settings:opencode-agents:get",
      "settings:opencode-agents:update",
      "settings:telemetry:get",
      "settings:telemetry:update",
      "settings:third-party-notices:get",
      "settings:thread-notifications:get",
      "settings:thread-notifications:update",
      "settings:window-restore:get",
      "settings:window-restore:update",
    ]);
    const frame = { url: "app://-/index.html" };
    const event = {
      sender: { getType: () => "window", id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    assert.strictEqual(
      yield* handlers.get("settings:notification-authorization:read")!(event),
      "authorized",
    );
    assert.strictEqual(
      yield* handlers.get("settings:notification-authorization:request")!(event),
      "authorized",
    );
    const untrustedEvent = {
      ...event,
      senderFrame: { url: "https://example.com" },
    } as IpcMainInvokeEvent;
    for (const channel of [
      "settings:notification-authorization:read",
      "settings:notification-authorization:request",
      "settings:notification-authorization:open-settings",
    ]) {
      assert.strictEqual(
        (yield* Effect.result(handlers.get(channel)!(untrustedEvent)))._tag,
        "Failure",
      );
    }
    assert.deepEqual(yield* handlers.get("settings:composer-predictions:get")!(event), {
      enabled: true,
    });
    assert.strictEqual(
      (yield* Effect.result(
        handlers.get("settings:composer-predictions:update")!(untrustedEvent, { enabled: false }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.result(
        handlers.get("settings:composer-predictions:update")!(event, { enabled: "false" }),
      ))._tag,
      "Failure",
    );
    assert.deepEqual(
      yield* handlers.get("settings:composer-predictions:update")!(event, { enabled: false }),
      { enabled: false },
    );
    yield* Effect.yieldNow;
    assert.deepEqual(
      broadcasts.filter(({ channel }) => channel === "composer-prediction-settings-changed"),
      [{ channel: "composer-prediction-settings-changed", value: { enabled: false } }],
    );
    assert.strictEqual(providerRefreshes, 0);
    for (const channel of [
      "settings:claude-agents:update",
      "settings:opencode-agents:update",
      "settings:acp-agents:update",
    ] as const)
      yield* handlers.get(channel)!(event, { instances: [] });
    assert.strictEqual(providerRefreshes, 3);
    const acpInstance = {
      id: "acp-work",
      agentDefinitionId: "generic",
      displayName: "Work",
      enabled: true,
      source: { kind: "local", executable: "generic", args: [] },
      environment: [],
      customModels: [],
      credentials: { kind: "isolated-home", home: settingsRoot },
      proxy: "isolated",
    };
    providerResult = {
      applied: false,
      deferredInstanceIds: [
        agentRuntimeProviderId({
          kind: "acp",
          agentDefinitionId: "generic",
          instanceConfigId: "acp-work",
        })!,
      ],
    };
    const deferred = yield* handlers.get("settings:acp-agents:update")!(event, {
      instances: [acpInstance],
    });
    assert.deepEqual(deferred, {
      instances: [acpInstance],
      deferredInstanceIds: ["acp-work"],
      configurationStatus: "deferred",
    });
    assert.isFalse(readFileSync(settingsPath, "utf8").includes("deferredInstanceIds"));
    const savedBytes = readFileSync(settingsPath, "utf8");
    const broadcastsBeforeStatus = broadcasts.length;
    assert.deepEqual(yield* handlers.get("settings:acp-agents:configuration-status")!(event), {
      deferredInstanceIds: ["acp-work"],
      configurationStatus: "deferred",
    });
    providerResult = { applied: true, deferredInstanceIds: [] };
    assert.deepEqual(yield* handlers.get("settings:acp-agents:configuration-status")!(event), {
      deferredInstanceIds: [],
      configurationStatus: "applied",
    });
    assert.equal(readFileSync(settingsPath, "utf8"), savedBytes);
    assert.equal(broadcasts.length, broadcastsBeforeStatus);
    providerFailure = true;
    assert.deepEqual(yield* handlers.get("settings:acp-agents:configuration-status")!(event), {
      deferredInstanceIds: [],
      configurationStatus: "failed",
    });
    const refreshesBeforeUntrusted = providerRefreshes;
    assert.equal(
      (yield* Effect.result(
        handlers.get("settings:acp-agents:configuration-status")!(untrustedEvent),
      ))._tag,
      "Failure",
    );
    assert.equal(providerRefreshes, refreshesBeforeUntrusted);
    const failed = yield* handlers.get("settings:acp-agents:update")!(event, {
      instances: [acpInstance],
    });
    assert.deepEqual(failed, {
      instances: [acpInstance],
      deferredInstanceIds: [],
      configurationStatus: "failed",
    });
    providerFailure = false;
    providerResult = { applied: true, deferredInstanceIds: [] };
    const rejectedShortcut = (yield* handlers.get("set-codex-command-keybinding")!(
      event,
      "globalDictationHold",
      { type: "set", keybinding: { key: "Y" } },
    )) as {
      readonly type: string;
      readonly reason?: { readonly kind: string; readonly message: string };
    };
    assert.strictEqual(rejectedShortcut.type, "rejected");
    assert.deepEqual(rejectedShortcut.reason, {
      kind: "modifier-required",
      message: "Shortcut must include Cmd/Ctrl or Alt.",
    });
    const keybindingResults = yield* Effect.all(
      [
        handlers.get("set-codex-command-keybinding")!(event, "settings", {
          type: "set",
          keybinding: { key: "CmdOrCtrl+Shift+1" },
        }),
        handlers.get("set-codex-command-keybinding")!(event, "newWindow", {
          type: "set",
          keybinding: { key: "CmdOrCtrl+Shift+2" },
        }),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(
      keybindingResults.map((result) => (result as { readonly type: string }).type),
      ["applied", "applied"],
    );
    assert.strictEqual(peakKeymapAdmissions, 1);
    const invalid = yield* Effect.result(
      handlers.get("settings:backup:update")!(event, {
        autoEnabled: true,
        intervalHours: 6,
        retentionCount: 28,
        retentionGiB: 32,
        unexpected: true,
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
    const invalidCodexHome = yield* Effect.result(
      handlers.get("settings:codex-home:update")!(event, { homePath: "/codex", unexpected: true }),
    );
    assert.strictEqual(invalidCodexHome._tag, "Failure");
    const home = (yield* handlers.get("settings:codex-home:get")!(event)) as {
      activeHomePath: string;
    };
    const savedHome = (yield* handlers.get("settings:codex-home:update")!(event, {
      homePath: path.join(settingsRoot, "codex"),
    })) as { activeHomePath: string; resolvedHomePath: string; restartRequired: boolean };
    assert.strictEqual(savedHome.activeHomePath, home.activeHomePath);
    assert.strictEqual(savedHome.resolvedHomePath, path.join(settingsRoot, "codex"));
    assert.isTrue(savedHome.restartRequired);
    const restartedSettings = yield* makeApplicationSettings({
      environment: {},
      hostHomeDirectory: settingsRoot,
      settingsPath,
    });
    const restartedHome = (yield* restartedSettings.snapshot()).codexHome;
    assert.strictEqual(restartedHome.activeHomePath, savedHome.resolvedHomePath);
    assert.isFalse(restartedHome.restartRequired);

    const beforeInvalidHome = readFileSync(settingsPath);
    for (const input of [
      { homePath: "relative" },
      { homePath: path.join(settingsRoot, "codex"), accountHomePath: "relative" },
      {
        homePath: path.join(settingsRoot, "codex"),
        accountHomePath: path.join(settingsRoot, "codex", "account"),
      },
    ]) {
      const rejectedHome = yield* Effect.result(
        handlers.get("settings:codex-home:update")!(event, input),
      );
      assert.strictEqual(rejectedHome._tag, "Failure");
      assert.deepEqual(readFileSync(settingsPath), beforeInvalidHome);
    }

    const resetHome = (yield* handlers.get("settings:codex-home:update")!(event, {
      homePath: "",
    })) as {
      activeHomePath: string;
      resolvedHomePath: string;
      source: string;
      restartRequired: boolean;
    };
    assert.strictEqual(resetHome.activeHomePath, home.activeHomePath);
    assert.strictEqual(resetHome.resolvedHomePath, path.join(settingsRoot, ".codex"));
    assert.strictEqual(resetHome.source, "default");
    assert.isFalse(resetHome.restartRequired);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
    rmSync(settingsRoot, { recursive: true, force: true });
  }),
);
