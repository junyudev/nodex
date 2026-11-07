import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { app, BrowserWindow } from "electron";
import { MainConfig } from "../../app/MainConfig";
import {
  inertProductAnalytics,
  make,
  ProductAnalytics,
} from "../../product-analytics/ProductAnalytics";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { STATSIG_LOG_EVENT_URL } from "../../../shared/product-analytics/statsig";
import { ElectronNet, live as electronNetLive } from "./ElectronNet";

const REQUEST_TIMEOUT = Duration.seconds(20);
/** A Store older than this predates the first analytics launch on this Profile. */
const EXISTING_PROFILE_AGE_MS = 10 * 60 * 1_000;

/**
 * Electron's network stack honours the system proxy, which restricted networks need. A development
 * build that was not explicitly opted in holds no state and sends nothing.
 */
export const live = Layer.effect(
  ProductAnalytics,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const net = yield* ElectronNet;
    const settings = yield* ApplicationSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Analytics never gates startup: an unreadable settings document leaves it silent.
    const snapshot = yield* settings.snapshot().pipe(Effect.option);
    if (snapshot._tag === "None") return inertProductAnalytics;
    const telemetry = snapshot.value.telemetry;
    if (!config.isPackaged && !telemetry.active) return inertProductAnalytics;

    const appVersion = app.getVersion();
    const endpoint = config.environment.NODEX_TELEMETRY_ENDPOINT ?? STATSIG_LOG_EVENT_URL;
    return yield* make({
      statePath: path.join(config.nodexHome, "product-analytics", "state.json"),
      context: {
        appVersion,
        channel: !config.isPackaged
          ? "development"
          : appVersion.includes("-nightly")
            ? "nightly"
            : "stable",
        tier: config.isPackaged ? "production" : "development",
        os: config.platform,
        arch: process.arch,
        locale: app.getLocale(),
      },
      telemetry,
      telemetryChanges: settings.telemetrySettingsChanges,
      noticeApplies: settings.snapshot().pipe(
        Effect.map(({ telemetry, diagnostics }) => telemetry.active || diagnostics.active),
        Effect.orElseSucceed(() => false),
      ),
      profileKind: Effect.gen(function* () {
        const info = yield* fs.stat(path.join(config.nodexHome, "nodex.db"));
        const now = yield* Clock.currentTimeMillis;
        const created = Option.getOrUndefined(info.birthtime)?.getTime();
        return created !== undefined && now - created > EXISTING_PROFILE_AGE_MS
          ? ("existing" as const)
          : ("new" as const);
      }).pipe(Effect.orElseSucceed(() => "new" as const)),
      windowFocused: Effect.sync(() => BrowserWindow.getFocusedWindow() !== null),
      send: (request) =>
        net.fetch(endpoint, { method: "POST", headers: request.headers, body: request.body }).pipe(
          Effect.map((response) => response.status),
          Effect.timeout(REQUEST_TIMEOUT),
        ),
    });
  }),
).pipe(Layer.provide(Layer.merge(electronNetLive, NodeServices.layer)));
