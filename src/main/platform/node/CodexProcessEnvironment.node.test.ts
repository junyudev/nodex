import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { HostShellEnvironment, live as shellLive } from "../../host-runtime/HostShellEnvironment";
import { resolveCodexProcessEnvironment, resolveLocalCodexLaunch } from "./CodexProcessEnvironment";
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

const accountHome = {
  mode: "overlay",
  sharedHome: "/profile/codex",
  effectiveHome: "/profile/account",
  directoryIdentity: null,
  sharedDirectoryIdentity: null,
  sharedEntryNames: [],
} as const;

it.effect.each(["captured", "failed"] as const)(
  "resolves the physical Codex launch with %s shell recovery",
  (status) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        shellLive({
          platform: "darwin",
          baseEnvironment: { PATH: "/desktop", HTTPS_PROXY: "http://desktop-proxy.example" },
          loadInteractiveEnvironment: () =>
            status === "captured"
              ? Promise.resolve({
                  PATH: "/login",
                  HTTPS_PROXY: "http://shell-proxy.example",
                  HTTP_PROXY: "http://shell-http.example",
                  SSL_CERT_FILE: "/user/custom-ca.pem",
                  CODEX_HOME: "/other-account",
                  NODEX_HOME: "/other-profile",
                  CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://shell-endpoint.example",
                  CODEX_APP_SERVER_OPENAI_BASE_URL: "https://shell-openai.example",
                  BROWSER_USE_ACCESS_PIPE_PATH: "/foreign-host",
                  ELECTRON_RUN_AS_NODE: "1",
                })
              : Promise.reject(new Error("Shell exited")),
        }),
      );
      const launch = yield* resolveLocalCodexLaunch({
        accountHome,
        profileHome: "/profile",
        platform: "darwin",
        additionalSearchPaths: ["/nodex/tools"],
        shell: Context.get(context, HostShellEnvironment),
        localLaunch: {
          resolveOverrides: (environment) =>
            Effect.succeed(["-c", `shell_environment_policy.set.PATH="${environment.PATH}"`]),
        },
        pending: {
          args: ["-c", "mcp_servers.nodex.enabled=true"],
          env: {
            HTTP_PROXY: "http://configured-proxy.example",
            CODEX_HOME: "/also-wrong",
            CODEX_APP_SERVER_OPENAI_BASE_URL: "https://explicit-openai.example",
          },
        },
      });
      const path = status === "captured" ? "/login" : "/desktop";
      expect(launch.env).toMatchObject({
        HTTP_PROXY: "http://configured-proxy.example",
        HTTPS_PROXY:
          status === "captured" ? "http://shell-proxy.example" : "http://desktop-proxy.example",
        PATH: `/nodex/tools:${path}`,
        CODEX_HOME: "/profile/account",
        NODEX_HOME: "/profile",
        CODEX_SQLITE_HOME: "/profile/codex",
      });
      expect(launch.env.SSL_CERT_FILE).toBe(
        status === "captured" ? "/user/custom-ca.pem" : undefined,
      );
      expect(launch.env.BROWSER_USE_ACCESS_PIPE_PATH).toBeUndefined();
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      const matchesEndpoint = launch.args.includes(
        'chatgpt_base_url="https://shell-endpoint.example"',
      );
      expect(matchesEndpoint).toBe(status === "captured");
      expect(launch.args).toContain('openai_base_url="https://explicit-openai.example"');
      expect(launch.args).not.toContain('openai_base_url="https://shell-openai.example"');
      expect(launch.args.slice(-4)).toEqual([
        "-c",
        `shell_environment_policy.set.PATH="${path}"`,
        "-c",
        "mcp_servers.nodex.enabled=true",
      ]);
    }).pipe(Effect.scoped),
);
