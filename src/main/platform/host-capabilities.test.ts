import { it } from "@effect/vitest";
import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { MainConfig, testLayer } from "../app/MainConfig";
import { hostCapabilities } from "./host-capabilities";

test.each(["x64", "arm64"])("Windows %s exposes only supported native integrations", (arch) => {
  const capabilities = hostCapabilities("win32", arch);
  expect(capabilities).toEqual({
    backgroundService: false,
    autoUpdate: false,
    browserControl: false,
    computerControl: false,
    appshot: false,
    deviceCheck: false,
    nativeClipboard: false,
    nativeNotificationAuthorization: false,
    dictationBackend: "windows",
    openCode: true,
  });
  expect(Object.isFrozen(capabilities)).toBe(true);
});
it.effect("capabilities follow the supplied bootstrap snapshot", () =>
  Effect.gen(function* () {
    const config = yield* MainConfig;
    expect(config.capabilities.dictationBackend).toBe("windows");
    expect(hostCapabilities("darwin", "arm64").deviceCheck).toBe(true);
    expect(hostCapabilities("darwin", "x64").deviceCheck).toBe(false);
  }).pipe(Effect.provide(testLayer({ platform: "win32", arch: "arm64" }))),
);
