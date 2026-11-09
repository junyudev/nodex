/* @effect-diagnostics asyncFunction:off unstableApiUsage:off -- Adapts gh and the scoped HTTP client at the Node platform boundary. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import { sourceApiLayer, GitHubNotSignedInError } from "@nodex/agent-runtime/github-source";
import { MainConfig } from "../../app/MainConfig";
const execute = promisify(execFile);
/** CLI output is credential material: never retain the process error, stdout or stderr. */
export const readGitHubSourceToken =
  (environment: Readonly<Record<string, string | undefined>>) =>
  (host: string, account: string | undefined) =>
    Effect.tryPromise({
      try: async (signal) => {
        const env = {
          ...environment,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
        };
        const result = await execute(
          "gh",
          ["auth", "token", "--hostname", host, ...(account ? ["--user", account] : [])],
          { signal, env, timeout: 10000, maxBuffer: 65536, encoding: "utf8", windowsHide: true },
        );
        const token = result.stdout.trim();
        if (!token) throw new Error("No CLI credential");
        return {
          token: Redacted.make(token),
          fingerprint: createHash("sha256").update(host).update(token).digest("hex"),
        };
      },
      catch: () => new GitHubNotSignedInError({ host, ...(account ? { account } : {}) }),
    });
export const live = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return sourceApiLayer(readGitHubSourceToken(config.environment)).pipe(
      Layer.provide(FetchHttpClient.layer),
    );
  }),
);
