import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        { host: baseEnv },
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          { host: baseEnv },
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { host: { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" } },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );

  it.effect.each(["win32", "darwin"] as const)(
    "uses only the declared provider credentials for isolated instances on %s",
    (platform) =>
      Effect.gen(function* () {
        const host = {
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          "BASH_FUNC_greet%%": "() {  echo hi\n}",
          HTTPS_PROXY: "http://proxy.example",
          oPeNaI_ApI_KeY: "host-openai",
          aZuRe_oPeNaI_ApI_KeY: "host-azure",
          anthropic_auth_token: "host-anthropic",
          Codex_Home: "/host/codex",
          CLAUDE_CONFIG_DIR: "/host/claude",
          claudecode: "1",
          Nodex_Gateway_Api_Key: "host-gateway",
          nodex_codex_launch_args: "-c model_provider=openai",
          Path: "C:\\Windows",
        };
        expect(
          yield* mergeProviderInstanceEnvironment(
            [
              { name: "CODEX_HOME", value: "/instance/codex", sensitive: false },
              { name: "CODEX_PROVIDER_API_KEY", value: "instance-key", sensitive: true },
              { name: "PATH", value: "C:\\tools", sensitive: false },
            ],
            { isolated: true, host },
          ),
        ).toEqual({
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          "BASH_FUNC_greet%%": "() {  echo hi\n}",
          HTTPS_PROXY: "http://proxy.example",
          CODEX_HOME: "/instance/codex",
          CODEX_PROVIDER_API_KEY: "instance-key",
          PATH: "C:\\tools",
          ...(platform === "win32" ? {} : { Path: host.Path }),
        });
        expect(yield* mergeProviderInstanceEnvironment(undefined, { host })).toEqual(host);
      }).pipe(Effect.provideService(HostProcess.Platform, platform)),
  );
});
