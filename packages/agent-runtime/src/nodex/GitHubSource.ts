/** The Host reuses the provider's transport and credential contract without Runtime ownership. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as GitHubApiModule from "./github/GitHubApi.ts";
import * as GitHubCredentialsModule from "./github/GitHubCredentials.ts";
import * as GitHubQuota from "./github/GitHubQuota.ts";
import * as SourceControlRateLimit from "./github/SourceControlRateLimit.ts";
export { GitHubApi, PinnedGitHubCredential } from "./github/GitHubApi.ts";
export type { GitHubApiError, GitHubRestInput, GitHubRestResponse } from "./github/GitHubApi.ts";
export { GitHubCredentials, GitHubNotSignedInError } from "./github/GitHubCredentials.ts";
export const SourceAccount = Context.Reference<string | undefined>("nodex/GitHubSourceAccount", {
  defaultValue: () => undefined,
});
export const sourceApiLayer = (
  readToken: (
    host: string,
    account: string | undefined,
  ) => Effect.Effect<
    { token: Redacted.Redacted; fingerprint: string },
    GitHubCredentialsModule.GitHubCredentialUnavailableError
  >,
) => {
  const credentials = Layer.succeed(
    GitHubCredentialsModule.GitHubCredentials,
    GitHubCredentialsModule.GitHubCredentials.of({
      get: Effect.fn("SourceCredentials.get")(function* (host: string) {
        const account = yield* SourceAccount;
        const value = yield* readToken(host, account);
        return { ...value, host, source: "gh" as const };
      }),
      invalidate: () => Effect.void,
    }),
  );
  return GitHubApiModule.layer.pipe(
    Layer.provide(credentials),
    Layer.provide(GitHubQuota.layer),
    Layer.provide(SourceControlRateLimit.layer),
  );
};
