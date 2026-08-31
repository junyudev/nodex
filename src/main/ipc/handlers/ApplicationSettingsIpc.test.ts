import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
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
import { ApplicationSettingsIpcError, live } from "./ApplicationSettingsIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, ApplicationSettingsIpcError>;

it.effect("owns the complete application settings ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const settingsRoot = mkdtempSync(path.join(tmpdir(), "nodex-application-settings-ipc-"));
    const settings = yield* makeApplicationSettings({
      environment: {},
      settingsPath: path.join(settingsRoot, "config.toml"),
    });
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const menus = ApplicationMenuRuntime.of({ refresh: () => undefined });
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
    const windows = WindowRuntime.of({
      all: () => [],
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationMenuRuntime, menus),
            Layer.succeed(ApplicationSettings, settings),
            Layer.succeed(DictationRuntime, dictation),
            Layer.succeed(StoreAdministrationSchedulerRuntime, schedulers),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
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
      "settings:acp-agents:get",
      "settings:acp-agents:update",
      "settings:backup:get",
      "settings:backup:update",
      "settings:codex-developer:get",
      "settings:codex-developer:update",
      "settings:diagnostics:get",
      "settings:diagnostics:update",
      "settings:git:get",
      "settings:git:update",
      "settings:history:get",
      "settings:history:update",
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

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
    rmSync(settingsRoot, { recursive: true, force: true });
  }),
);
