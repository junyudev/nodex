import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { resolveCodexProcessEnvironment } from "./CodexProcessEnvironment";
import { composeNodexCliShellEnvironment, nodexCliShellPaths } from "./NodexCliShell";

it.effect("Codex uses its account and tool paths over case-variant inherited values", () =>
  Effect.gen(function* () {
    const environment = yield* resolveCodexProcessEnvironment({
      additionalSearchPaths: ["C:\\Nodex\\bin"],
      pathDelimiter: ";",
      codexHome: "C:\\account",
      environment: {
        Path: "old",
        PATH: "current",
        codex_home: "wrong-account",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(environment).toEqual({ PATH: "C:\\Nodex\\bin;current", CODEX_HOME: "C:\\account" });
  }),
);

it.effect("Windows CLI routing honors a configured Path over the inherited PATH", () =>
  Effect.gen(function* () {
    const environment = yield* Effect.promise(() =>
      composeNodexCliShellEnvironment({
        nodexHome: "profile",
        platform: "win32",
        homeDirectory: "user",
        searchPaths: ["tools"],
        inheritedEnvironment: { PATH: "inherited" },
        configuredEnvironment: { Path: "configured" },
      }),
    );
    expect(environment.PATH).toBe(`${nodexCliShellPaths("profile").bin};tools;configured`);
  }),
);
